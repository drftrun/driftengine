import { compileProgram, uniformLocations } from './shader.ts';
import { LINE_FRAG, LINE_VERT } from './shaders/line.ts';
import { buildSegmentQuads } from './segmentQuads.ts';
import type { LineSegments } from './linePoints.ts';

/**
 * One draw call for a polyline with a real width — an audio waveform, a trail, a plotted
 * curve, anything that is a stroke rather than a surface.
 *
 * Four vertices per segment rather than instancing, exactly as `BoltBatch` is: a segment's
 * two endpoints *are* its geometry, so there is no repeated base shape to instance and an
 * instanced version would upload the same two positions per vertex anyway. `SEGMENT_CORNERS`
 * and the index list come from `segmentQuads.ts`, shared with the arc renderer so the two
 * cannot drift into two different meshes for the same segment.
 *
 * **Alpha blended, depth tested, depth write off — not additive.** An arc is light arriving
 * and adds to what is behind it; a line is a surface-ish thing that occludes in colour but
 * must not cut a hole in the depth buffer from its own soft antialiased edge. That is the
 * rule the SDF text renderer follows for the same reason, and `drawTo` leaves depth
 * *testing* alone the way that renderer does, on the assumption that the mesh pass already
 * has it enabled with `LEQUAL` — this is world geometry, not a screen overlay recovering
 * state from whatever ran before it.
 */
export class LineBatch {
  readonly program: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation>;

  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly fromBuffer: WebGLBuffer;
  private readonly toBuffer: WebGLBuffer;
  /** Scratch, expanded from the segment list's per-segment arrays to per-vertex ones. */
  private readonly from: Float32Array;
  private readonly to: Float32Array;
  private readonly capacity: number;

  constructor(gl: WebGL2RenderingContext, capacity: number, label: string) {
    this.program = compileProgram(gl, LINE_VERT, LINE_FRAG, label);
    this.uniforms = uniformLocations(gl, this.program, 'lineBatch');
    this.capacity = capacity;

    const verts = capacity * 4;
    this.from = new Float32Array(verts * 3);
    this.to = new Float32Array(verts * 3);

    /*
     * The corner layout and the index list are the only static data: which end of the
     * segment a vertex sits at, and which side of it. Everything else arrives per frame.
     * Built in `segmentQuads.ts`, so both a bolt and a line draw the same quad.
     */
    const { corners, indices } = buildSegmentQuads(capacity);

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error(`${label}: createVertexArray failed`);
    this.vao = vao;
    gl.bindVertexArray(vao);
    // Locations pinned to `line.ts`'s own `layout(location = ...)` qualifiers: 0 aFrom, 1
    // aTo, 2 aCorner. There is no third dynamic attribute — a line has no envelope to carry.
    this.fromBuffer = this.dynamic(gl, 0, verts * 3, 3, label);
    this.toBuffer = this.dynamic(gl, 1, verts * 3, 3, label);
    this.staticAttr(gl, 2, corners, 2, label);

    const indexBuffer = gl.createBuffer();
    if (indexBuffer === null) throw new Error(`${label}: createBuffer failed`);
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * Send this frame's polyline, expanding each segment to its four vertices.
   *
   * The expansion is written here rather than folded into `expandBoltSegments`: that
   * function reads a `BoltSegments` — five arrays beyond `from`/`to` — and teaching it to
   * read a `LineSegments` too would grow a union that couples two renderers sharing only a
   * quad. This walk is the same shape with none of that: two positions in, copied to four
   * vertices each.
   */
  upload(gl: WebGL2RenderingContext, data: LineSegments): number {
    const count = Math.min(data.count, this.capacity);
    for (let s = 0; s < count; s++) {
      const fx = data.from[s * 3] as number;
      const fy = data.from[s * 3 + 1] as number;
      const fz = data.from[s * 3 + 2] as number;
      const tx = data.to[s * 3] as number;
      const ty = data.to[s * 3 + 1] as number;
      const tz = data.to[s * 3 + 2] as number;
      for (let c = 0; c < 4; c++) {
        const v = s * 4 + c;
        this.from[v * 3] = fx;
        this.from[v * 3 + 1] = fy;
        this.from[v * 3 + 2] = fz;
        this.to[v * 3] = tx;
        this.to[v * 3 + 1] = ty;
        this.to[v * 3 + 2] = tz;
      }
    }
    if (count === 0) return 0;
    const verts = count * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fromBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.from, 0, verts * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.toBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.to, 0, verts * 3);
    return count;
  }

  /**
   * @param additive Whether this stroke is *light arriving* rather than a thing in the world.
   *
   * **It states what the stroke is; it does not turn a line into a bolt.** `AGENTS.md` forbids a
   * mode flag on one verb to get the other, and this is not one: a bolt jitters along its own path
   * because it is lightning, and that is a fact about its *geometry* which nothing here changes. A
   * line asked to be additive still follows the path it was given, still has a clean edge, and is
   * still fogged. What changes is that it adds to what is behind it instead of covering it.
   *
   * Reported by a consumer drawing a glowing block outline: the only additive stroke was
   * `drawBolts`, which jitters, so they drew two alpha-blended passes at different softness and
   * measured what it cost — against a bright surface it tints toward the glow colour instead of
   * adding light to it, which is visible on sand at noon and indistinguishable in a cave.
   */
  drawTo(gl: WebGL2RenderingContext, segmentCount: number, additive = false): void {
    if (segmentCount === 0) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    // The quad billboards toward the view direction the same way a bolt's does — see
    // `line.ts`'s own `cross(dir, view)` — so its winding can flip with the camera exactly
    // as a bolt's can, and culling it would drop the line from half the angles it is seen.
    gl.disable(gl.CULL_FACE);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, segmentCount * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    this.buffers.length = 0;
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  private dynamic(
    gl: WebGL2RenderingContext,
    location: number,
    floats: number,
    size: number,
    label: string,
  ): WebGLBuffer {
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error(`${label}: createBuffer failed`);
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, floats * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return buffer;
  }

  private staticAttr(
    gl: WebGL2RenderingContext,
    location: number,
    data: Float32Array,
    size: number,
    label: string,
  ): void {
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error(`${label}: createBuffer failed`);
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  }
}
