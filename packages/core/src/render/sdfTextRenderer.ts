import type { ReadonlyMat4 } from 'gl-matrix';
import type { Vec3 } from '../math/color.ts';
import type { SdfFont } from './sdfFont.ts';
import type { SdfTextStyle } from './sdfTextLayout.ts';
import { SdfTextLayout } from './sdfTextLayout.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { SDF_TEXT_FRAG, SDF_TEXT_VERT } from './shaders/sdfText.ts';
import type { SurfaceTexture } from './surfaceTexture.ts';
import { SDF_TEXT_TEXTURE_UNIT } from './lightBudget.ts';

/**
 * Text from a signed distance field, on WebGL2.
 *
 * Same job as `textRenderer.ts` for the pixel font: a program, a VAO, buffers, one draw call
 * per string, reached only through `renderer.createSdfText()` and its `setSdfText` /
 * `drawSdfText` / `disposeSdfText`. Where this differs from that file, it is because SDF text
 * genuinely differs:
 *
 * - **A flat quad per glyph, not an instanced cube.** The pixel font is lit geometry; an SDF
 *   glyph is a distance field sampled by a fragment shader, so a quad textured with the field
 *   is the whole glyph. One `drawElements` call draws every quad the string laid out.
 * - **Coverage, not a solid.** The field's antialiased edge is an alpha value, so the draw
 *   blends and never writes depth — see `draw` for what happens if it does.
 * - **World geometry, not a screen overlay.** The pixel font builds its own projection from a
 *   viewport and pixel origin; SDF text takes a model matrix and draws against the scene's own
 *   view-projection, the same one `drawMesh` uses. A caller supplies the basis — see
 *   `sdfTextLayout.ts`.
 * - **The atlas is the caller's.** `setSdfText` retains it, exactly as `setSurfaceTexture`
 *   retains a material's texture, so `draw` needs nothing handed to it again every frame.
 *
 * `aPosition`/`aUv` are hardcoded to locations 0/1 below, matching `sdfText.ts`'s own
 * `layout(location = ...)` qualifiers — the same convention `text.ts`/`textRenderer.ts`
 * follow. That file is the one written-down source of truth both this and the WGSL naga
 * generates from it read; querying the locations at runtime instead would just be a second
 * source of truth that happens to agree with the first until one of them changes.
 */
export class SdfTextRenderer {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly positionBuffer: WebGLBuffer;
  private readonly uvBuffer: WebGLBuffer;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly layout = new SdfTextLayout();

  /** Set by `setText`; `draw` reads neither the class nor the atlas from anywhere else. */
  private font: SdfFont | null = null;
  private atlas: SurfaceTexture | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = compileProgram(gl, SDF_TEXT_VERT, SDF_TEXT_FRAG, 'sdfText');
    this.uniforms = uniformLocations(gl, this.program, 'sdfTextRenderer');

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('Failed to create SDF text VAO');
    this.vao = vao;
    gl.bindVertexArray(vao);

    /*
     * Positions and UVs are `DYNAMIC_DRAW` and start already sized to `layout`'s own
     * capacity, uploaded from its (all-zero, at this point) arrays. `bufferData` with a
     * typed array both allocates and uploads in the one call, and the array is already the
     * exact size a full string can reach, so there is no separate "how big" to track here.
     *
     * Locations 0 and 1 are `sdfText.ts`'s own `layout(location = ...)` qualifiers, not a
     * guess — see the class comment.
     */
    this.positionBuffer = this.dynamicAttribute(0, this.layout.positions, 3);
    this.uvBuffer = this.dynamicAttribute(1, this.layout.uvs, 2);

    /*
     * The index buffer, `STATIC_DRAW` and written once. `SdfTextLayout` fills its whole
     * `0,1,2,0,2,3` pattern for every quad it could ever hold at construction — see its own
     * comment — so nothing about a later `set()` call ever changes this buffer's contents,
     * only how much of it `draw` asks to be drawn.
     */
    const indexBuffer = gl.createBuffer();
    if (indexBuffer === null) throw new Error('Failed to create SDF text index buffer');
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.layout.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
  }

  /**
   * Lay a string out against a font, and retain the atlas `draw` will sample.
   *
   * The atlas is retained here rather than taken by `draw` for the same reason
   * `setSurfaceTexture` retains a material's texture: a caller that draws the same label
   * every frame should not have to keep handing over an object nothing about the frame
   * changed. A no-op, and no re-upload, when neither the text nor the style moved.
   */
  setText(font: SdfFont, atlas: SurfaceTexture, text: string, style: SdfTextStyle): void {
    this.font = font;
    this.atlas = atlas;
    if (this.layout.set(font, text, style)) this.upload();
  }

  /**
   * Draw the laid-out string at `model`, against the scene's own view-projection.
   *
   * Nothing draws before a `setText` call has produced at least one quad, before a font and
   * an atlas are both on hand, or once opacity has faded a label out — a caller may call
   * this unconditionally.
   *
   * Returns whether a draw call was actually issued. `Renderer.drawSdfText` uses this to
   * know whether `SDF_TEXT_TEXTURE_UNIT` was touched at all, since that unit doubles as
   * `SURFACE_TEXTURE_UNIT` and the caller has to put the right texture back on it — but only
   * when this class actually rebound it to the atlas.
   */
  /**
   * `outputTransform` and `outputExposure` come from the renderer rather than from here, because
   * whether this pass grades depends on whether anything after it will. See `Renderer.gradeCode`.
   */
  draw(
    viewProj: ReadonlyMat4,
    model: Float32Array,
    color: Vec3,
    opacity: number,
    outputTransform: number,
    outputExposure: number,
  ): boolean {
    if (this.layout.quadCount === 0 || opacity <= 0 || this.font === null || this.atlas === null) {
      return false;
    }
    const gl = this.gl;
    const font = this.font;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    /*
     * Blending on, depth writes off. Text is coverage: the field's antialiased edge is an
     * alpha value, not a solid surface, and writing depth from it punches a hole in whatever
     * sits behind that edge — a bug that looks like a broken font rather than a depth bug.
     *
     * Depth *testing* is left alone, deliberately, rather than reasserted the way the pixel
     * font's own `TextRenderer.draw` reasserts it. That renderer is a screen overlay running
     * at the end of the frame and has to recover state a sky or an earlier pass may have
     * left behind. SDF text is world geometry drawn inside the mesh pass, where an enabled
     * depth test and `LEQUAL` are already the ambient state — the same assumption
     * `drawTranslucentMesh` makes for exactly the same reason.
     */
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.atlas.bind(gl, SDF_TEXT_TEXTURE_UNIT);

    const u = this.uniforms;
    gl.uniform1i(u['uOutputTransform'] ?? null, outputTransform);
    gl.uniform1f(u['uOutputExposure'] ?? null, outputExposure);
    setMat4(gl, u['uViewProj'], viewProj);
    setMat4(gl, u['uModel'], model);
    setVec3(gl, u['uColor'], color);
    setFloat(gl, u['uOpacity'], opacity);
    setFloat(gl, u['uDistanceRange'], font.distanceRange);
    setVec2(gl, u['uAtlasSize'], font.atlasWidth, font.atlasHeight);
    const atlasLoc = u['uAtlas'];
    if (atlasLoc !== undefined) gl.uniform1i(atlasLoc, SDF_TEXT_TEXTURE_UNIT);

    gl.drawElements(gl.TRIANGLES, this.layout.quadCount * 6, gl.UNSIGNED_INT, 0);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    return true;
  }

  dispose(): void {
    const gl = this.gl;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    this.buffers.length = 0;
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  /** Both vertex buffers, from the arrays `layout.set` filled in place. */
  private upload(): void {
    const gl = this.gl;
    const vertexCount = this.layout.quadCount * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.layout.positions, 0, vertexCount * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.layout.uvs, 0, vertexCount * 2);
  }

  private dynamicAttribute(location: number, initial: Float32Array, size: number): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error('Failed to create SDF text buffer');
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, initial, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return buffer;
  }
}

function setFloat(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | undefined,
  value: number,
): void {
  if (location !== undefined) gl.uniform1f(location, value);
}

function setVec2(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | undefined,
  x: number,
  y: number,
): void {
  if (location !== undefined) gl.uniform2f(location, x, y);
}

function setVec3(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | undefined,
  value: Vec3,
): void {
  if (location !== undefined) gl.uniform3f(location, value[0], value[1], value[2]);
}

function setMat4(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | undefined,
  value: ReadonlyMat4 | Float32Array,
): void {
  if (location !== undefined) gl.uniformMatrix4fv(location, false, value);
}
