import type { TextStyle } from './textLayout.ts';
import { MAX_CELLS, TEXT_CUBE, TextLayout } from './textLayout.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { TEXT_FRAG, TEXT_VERT } from './shaders/text.ts';

/**
 * Text as geometry, on WebGL2.
 *
 * Every lit cell of every glyph is an instanced cube, so a message catches light, has depth,
 * and can rotate — rather than being a flat sticker over a flat-shaded world. One draw call
 * per string.
 *
 * **The layout is not here.** Which cells are lit is arithmetic over the pixel font and is the
 * same on either backend, so it lives in `textLayout.ts` and this owns only the buffers, the
 * program and the state the draw needs. See that file for why.
 *
 * Reached through `renderer.createText()` and the renderer's own `setText` / `drawText` /
 * `disposeText`, never constructed by a caller: a caller holding a context is a caller pinned
 * to one backend, which is what kept `showroom` on WebGL2.
 */
/** WebGL2's clip space is the shader's own, so the correction it binds is nothing. */
const TEXT_IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class TextRenderer {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly cellBuffer: WebGLBuffer;
  private readonly charBuffer: WebGLBuffer;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly layout = new TextLayout();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = compileProgram(gl, TEXT_VERT, TEXT_FRAG, 'text');
    this.uniforms = uniformLocations(gl, this.program, 'textRenderer');

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('Failed to create text VAO');
    this.vao = vao;
    gl.bindVertexArray(vao);

    this.staticAttribute(0, TEXT_CUBE.positions, 3);
    this.staticAttribute(1, TEXT_CUBE.normals, 3);
    this.cellBuffer = this.instanceAttribute(2, MAX_CELLS * 2, 2);
    this.charBuffer = this.instanceAttribute(3, MAX_CELLS, 1);

    gl.bindVertexArray(null);
  }

  /** Width of the last laid-out string, in pixels at a given cell size. */
  widthPx(cellSize: number): number {
    return this.layout.widthPx(cellSize);
  }

  /**
   * Lay a string out. The upload is skipped when the text has not changed, because most frames
   * show the same message as the frame before and re-uploading a buffer to say so is the sort
   * of cost that only shows up on a phone.
   */
  setText(text: string): void {
    if (this.layout.setText(text)) this.upload();
  }

  /** A solid rectangle of cells, for a keycap or a backing plate. See `TextLayout.setPlate`. */
  setPlate(widthCells: number, heightCells: number, bottomCell: number): void {
    if (this.layout.setPlate(widthCells, heightCells, bottomCell)) this.upload();
  }

  /**
   * @param originX left edge, in pixels from the left of the viewport.
   * @param originY baseline, in pixels from the top.
   */
  draw(
    viewportWidth: number,
    viewportHeight: number,
    originX: number,
    originY: number,
    style: TextStyle,
    timeSec: number,
  ): void {
    if (this.layout.instanceCount === 0 || style.alpha <= 0) return;
    const gl = this.gl;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    /*
     * Text gets a fresh depth buffer rather than no depth test at all.
     *
     * Turning depth off entirely is the obvious move and it is wrong: the cubes are solid, so
     * with nothing sorting them the last face in the buffer wins and every letter renders as
     * one flat facet. Clearing depth puts the whole message in front of the scene while still
     * letting its own geometry sort against itself, which is what gives the glyphs their edges.
     */
    // The mask goes up *before* the clear. `glClear` respects it, and the pass that ran before
    // this one — the plumes — leaves depth writes disabled, so clearing first silently did
    // nothing and the text was depth-tested against whatever the scene had already written. It
    // rendered on some frames and not others, with no GL error either way.
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    /*
     * **The equal-admitting compare in whichever direction this context tests.** Text lies flush on
     * the surface it labels, so it needs the case that keeps a coplanar fragment — `LEQUAL` where
     * nearer is smaller and `GEQUAL` where nearer is larger. Derived from the compare already set
     * rather than named, because this file has no way to know which way the frame is drawing and a
     * constant here silently drops every glyph on a reversed one.
     */
    const current = gl.getParameter(gl.DEPTH_FUNC) as number;
    const reversed = current === gl.GREATER || current === gl.GEQUAL;
    gl.depthFunc(reversed ? gl.GEQUAL : gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    setVec2(gl, this.uniforms['uViewport'], viewportWidth, viewportHeight);
    setVec2(gl, this.uniforms['uOrigin'], originX, originY);
    setFloat(gl, this.uniforms['uCellSize'], style.cellSize);
    // Far enough that a whole line barely converges, near enough that a rotating character
    // reads as turning rather than shearing.
    setFloat(gl, this.uniforms['uDepth'], Math.max(viewportWidth, 600) * 1.4);
    setFloat(gl, this.uniforms['uReveal'], style.reveal);
    setFloat(gl, this.uniforms['uCharCount'], Math.max(1, style.charSpan ?? this.layout.charCount));
    setFloat(gl, this.uniforms['uCharOffset'], style.charOffset ?? 0);
    setFloat(gl, this.uniforms['uSpin'], style.spin);
    setFloat(gl, this.uniforms['uPunch'], style.punch);
    setFloat(gl, this.uniforms['uBob'], style.bob);
    setFloat(gl, this.uniforms['uTime'], timeSec);
    setFloat(gl, this.uniforms['uGlow'], style.glow);
    setFloat(gl, this.uniforms['uAlpha'], style.alpha);
    /* Identity: this backend's clip space is the one the shader was written against. */
    const correction = this.uniforms['uClipCorrection'];
    if (correction !== undefined) gl.uniformMatrix4fv(correction, false, TEXT_IDENTITY);
    const color = this.uniforms['uColor'];
    if (color !== undefined) {
      gl.uniform3f(color, style.color[0], style.color[1], style.color[2]);
    }

    gl.drawArraysInstanced(gl.TRIANGLES, 0, TEXT_CUBE.vertexCount, this.layout.instanceCount);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    this.buffers.length = 0;
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  /** Both instance buffers, from the arrays the layout filled in place. */
  private upload(): void {
    const gl = this.gl;
    const count = this.layout.instanceCount;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.layout.cells, 0, count * 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.charBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.layout.chars, 0, count);
  }

  private staticAttribute(location: number, data: Float32Array, size: number): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error('Failed to create text buffer');
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return buffer;
  }

  private instanceAttribute(location: number, floats: number, size: number): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (buffer === null) throw new Error('Failed to create text buffer');
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, floats * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, 1);
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
