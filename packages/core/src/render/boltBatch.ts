import { compileProgram, uniformLocations } from './shader.ts';
import { BOLT_FRAG, BOLT_VERT } from './shaders/bolt.ts';
import { buildSegmentQuads, expandBoltSegments } from './segmentQuads.ts';
import type { BoltSegments } from './boltPool.ts';

/**
 * One draw call for a pool of electrical arcs.
 *
 * Four vertices per segment rather than instancing, because a segment's two
 * endpoints *are* its geometry — there is no repeated base shape to instance, and
 * an instanced version would upload the same two positions per vertex anyway.
 *
 * Additive and depth-tested without writing depth, like every other emissive
 * effect here: an arc adds light to what is behind it and must not occlude
 * whatever is drawn next.
 */
export class BoltBatch {
  readonly program: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation>;

  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly fromBuffer: WebGLBuffer;
  private readonly toBuffer: WebGLBuffer;
  private readonly arcBuffer: WebGLBuffer;
  /** Scratch, expanded from the pool's per-segment arrays to per-vertex ones. */
  private readonly from: Float32Array;
  private readonly to: Float32Array;
  private readonly arc: Float32Array;
  private readonly capacity: number;

  constructor(gl: WebGL2RenderingContext, capacity: number, label: string) {
    this.program = compileProgram(gl, BOLT_VERT, BOLT_FRAG, label);
    this.uniforms = uniformLocations(gl, this.program, 'boltBatch');
    this.capacity = capacity;

    const verts = capacity * 4;
    this.from = new Float32Array(verts * 3);
    this.to = new Float32Array(verts * 3);
    this.arc = new Float32Array(verts * 4);

    /*
     * The corner layout and the index list are the only static data: which end of
     * the segment a vertex sits at, and which side of it. Everything else arrives
     * per frame. Built in `segmentQuads.ts`, so both backends draw one arc.
     */
    const { corners, indices } = buildSegmentQuads(capacity);

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error(`${label}: createVertexArray failed`);
    this.vao = vao;
    gl.bindVertexArray(vao);
    this.fromBuffer = this.dynamic(gl, 0, verts * 3, 3, label);
    this.toBuffer = this.dynamic(gl, 1, verts * 3, 3, label);
    this.staticAttr(gl, 2, corners, 2, label);
    this.arcBuffer = this.dynamic(gl, 3, verts * 4, 4, label);

    const indexBuffer = gl.createBuffer();
    if (indexBuffer === null) throw new Error(`${label}: createBuffer failed`);
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /**
   * Send this frame's arcs, expanding each segment to its four vertices.
   *
   * The expansion is `segmentQuads.ts`'s because it is a fact about how the geometry is drawn
   * rather than about GL — the pool is deliberately GL-free and testable, and the WebGPU batch
   * needs exactly the same four vertices.
   */
  upload(gl: WebGL2RenderingContext, data: BoltSegments): number {
    const count = expandBoltSegments(data, this.capacity, this.from, this.to, this.arc);
    if (count === 0) return 0;
    const verts = count * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fromBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.from, 0, verts * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.toBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.to, 0, verts * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.arc, 0, verts * 4);
    return count;
  }

  drawTo(gl: WebGL2RenderingContext, segmentCount: number): void {
    if (segmentCount === 0) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
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
