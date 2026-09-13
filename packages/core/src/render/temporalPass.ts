import { compileProgram, uniformLocations } from './shader.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import { TEMPORAL_RESOLVE_FRAG } from './shaders/temporalResolve.ts';

/**
 * The temporal resolve on WebGL2: this frame blended into where the last one was.
 *
 * **Two targets and a swap, because a pass cannot read the texture it is writing.** The history is
 * sampled at a reprojected coordinate, which is somewhere else in the same image, so reading and
 * writing one texture is a feedback loop — undefined in WebGL2 and in practice whatever the driver
 * left in the cache. So the resolve writes into the one it did not read and the pair swaps, which
 * costs one more full-size texture and nothing per pixel.
 *
 * **What it returns is what the composite must then treat as the scene.** Bloom, occlusion and the
 * grade all read the scene texture, and reading the unresolved one would grade a stable picture
 * from an unstable source and put the crawl back on screen through the bloom.
 */
export class TemporalPass {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;

  /** The pair, and which of them the next resolve writes into. */
  private textures: (WebGLTexture | null)[] = [null, null];
  private framebuffers: (WebGLFramebuffer | null)[] = [null, null];
  private write = 0;

  private width = 0;
  private height = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    /**
     * Matched to the scene target's own format, and it has to be.
     *
     * A half-float scene resolved into an eight-bit history is squashed into 0 to 1 on its way in
     * and read back squashed, so the accumulation would pull every value above white *down* over
     * eight frames — a bloom threshold that stopped meaning brightness, and a sunset that faded
     * while the camera held still.
     */
    private readonly floatColor: boolean,
  ) {
    this.program = compileProgram(gl, FULLSCREEN_VERT, TEMPORAL_RESOLVE_FRAG, 'temporalResolve');
    this.uniforms = uniformLocations(gl, this.program, 'temporalPass');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('TemporalPass: createVertexArray failed');
    this.vao = vao;
  }

  private ensureSize(width: number, height: number): void {
    if (this.width === width && this.height === height && this.textures[0] !== null) return;
    const { gl } = this;
    this.width = width;
    this.height = height;

    for (let i = 0; i < 2; i++) {
      if (this.textures[i] === null) this.textures[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
      if (this.floatColor) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      /* Linear, because the history is sampled between texels wherever the reprojection lands;
         clamped, because a sample that wrapped would pull the far edge of the screen into the
         corner — and the shader rejects an off-screen reprojection before it can anyway. */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      if (this.framebuffers[i] === null) this.framebuffers[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[i]);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.textures[i],
        0,
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Resolve `scene` against the history and return the texture now holding the resolved frame.
   *
   * `blend` is how much of the clipped history to keep, and **zero is the whole switch**: the
   * first frame, the frame after a resize and the frame after a cut pass zero, and the shader
   * then returns this frame before it touches depth or history at all.
   */
  temporalResolve(
    scene: WebGLTexture,
    depth: WebGLTexture,
    reprojection: Float32Array,
    width: number,
    height: number,
    blend: number,
  ): WebGLTexture {
    const { gl } = this;
    this.ensureSize(width, height);

    const target = this.write;
    const history = 1 - this.write;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[target]);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene);
    gl.uniform1i(this.uniforms['uScene'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[history]);
    gl.uniform1i(this.uniforms['uHistory'] ?? null, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.uniform1i(this.uniforms['uDepth'] ?? null, 2);

    gl.uniformMatrix4fv(this.uniforms['uReprojection'] ?? null, false, reprojection);
    gl.uniform2f(this.uniforms['uTexel'] ?? null, 1 / width, 1 / height);
    gl.uniform1f(this.uniforms['uHistoryBlend'] ?? null, blend);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.write = history;
    const resolved = this.textures[target];
    if (resolved === null) throw new Error('TemporalPass: resolve target missing');
    return resolved;
  }

  dispose(): void {
    const { gl } = this;
    for (let i = 0; i < 2; i++) {
      if (this.textures[i] !== null) gl.deleteTexture(this.textures[i]);
      if (this.framebuffers[i] !== null) gl.deleteFramebuffer(this.framebuffers[i]);
      this.textures[i] = null;
      this.framebuffers[i] = null;
    }
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    this.width = 0;
    this.height = 0;
  }
}
