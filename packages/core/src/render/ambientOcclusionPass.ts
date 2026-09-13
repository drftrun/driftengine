import { AO_BLUR_FRAG, AO_FRAG } from './shaders/ambientOcclusion.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import { compileProgram, uniformLocations } from './shader.ts';

/**
 * The screen-space ambient occlusion pass: estimate from depth, then blur.
 *
 * Its own module rather than more of `SceneTarget`, because it is its own responsibility —
 * that class owns where the frame lands and how it reaches the canvas, and this owns one
 * effect's targets and programs. The composite pass consumes the texture this returns and
 * knows nothing else about it.
 *
 * **Two single-channel targets, ping-ponged.** The estimate lands in one, the horizontal
 * blur writes the other, the vertical blur writes back into the first, and that one is
 * returned. `R8` rather than `RGBA8`: occlusion is one number, and three channels of padding
 * over a 4K frame is 24 MB of bandwidth per pass to carry nothing.
 */
export class AmbientOcclusionPass {
  private width = 0;
  private height = 0;
  private estimate: WebGLTexture | null = null;
  private scratch: WebGLTexture | null = null;
  private estimateFramebuffer: WebGLFramebuffer | null = null;
  private scratchFramebuffer: WebGLFramebuffer | null = null;
  /**
   * Set once if a single-channel target will not complete, after which this pass does
   * nothing and says so once.
   *
   * `R8` is colour-renderable in WebGL2 by specification, so this is not expected. It is here
   * because the alternative to an honest "off" is a frame multiplied by a texture that was
   * never written, and the last time an effect in this renderer sampled a target nobody had
   * filled, the failure presented as the driver being at fault. See `sceneTarget.ts`.
   */
  private unavailable = false;

  private readonly estimateProgram: WebGLProgram;
  private readonly estimateUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly blurProgram: WebGLProgram;
  private readonly blurUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;
  /** Scratch for the blur direction, so a per-frame pass allocates nothing. */
  private readonly step = new Float32Array(2);
  /** Scratch for the four inverse-projection terms the blur linearises depth with. */
  private readonly depthToViewZ = new Float32Array(4);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.estimateProgram = compileProgram(gl, FULLSCREEN_VERT, AO_FRAG, 'ao');
    this.estimateUniforms = uniformLocations(gl, this.estimateProgram, 'ao');
    this.blurProgram = compileProgram(gl, FULLSCREEN_VERT, AO_BLUR_FRAG, 'aoBlur');
    this.blurUniforms = uniformLocations(gl, this.blurProgram, 'aoBlur');

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('AmbientOcclusionPass: createVertexArray failed');
    this.vao = vao;
  }

  private ensureSize(width: number, height: number): boolean {
    if (this.unavailable) return false;
    if (this.width === width && this.height === height && this.estimate !== null) return true;
    const { gl } = this;
    this.width = width;
    this.height = height;

    this.estimate = this.allocate(this.estimate, width, height);
    this.scratch = this.allocate(this.scratch, width, height);

    if (this.estimateFramebuffer === null) this.estimateFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.estimateFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.estimate, 0);
    const estimateReady = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

    if (this.scratchFramebuffer === null) this.scratchFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scratch, 0);
    const scratchReady = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (!estimateReady || !scratchReady) {
      this.unavailable = true;
      console.warn(
        'AmbientOcclusionPass: this driver will not render to a single-channel target, so ' +
          'ambient occlusion is off. The frame itself is unaffected.',
      );
      return false;
    }
    return true;
  }

  private allocate(
    existing: WebGLTexture | null,
    width: number,
    height: number,
  ): WebGLTexture | null {
    const { gl } = this;
    const texture = existing ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    /* NEAREST, because every read of this is at a texel centre: the blur steps whole pixels
       and the composite reads the pixel it is shading. Linear would only cost filtering. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    /* Clamped, so a tap past the edge repeats the edge rather than wrapping the opposite
       side of the frame into a corner. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /**
   * Estimate occlusion from the frame's depth and blur it. Returns the texture to multiply
   * by, or null if this pass could not run, which the caller must read as "no occlusion"
   * rather than as black.
   *
   * `invProjection` is column-major, as `gl-matrix` produces it.
   */
  run(
    depth: WebGLTexture,
    width: number,
    height: number,
    radius: number,
    projScale: Float32Array,
    invProjection: Float32Array,
  ): WebGLTexture | null {
    if (!this.ensureSize(width, height)) return null;
    const { gl } = this;

    /* One triangle over a target with no depth attachment. Anything inherited from the scene
       pass would be tested against a buffer that is not there. */
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.estimateFramebuffer);
    gl.useProgram(this.estimateProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.uniform1i(this.estimateUniforms['uDepth'] ?? null, 0);
    gl.uniform2fv(this.estimateUniforms['uProjScale'] ?? null, projScale);
    gl.uniform1f(this.estimateUniforms['uRadius'] ?? null, radius);
    gl.uniformMatrix4fv(this.estimateUniforms['uInvProjection'] ?? null, false, invProjection);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /*
     * The four terms that carry a depth back to metres, read out of the inverse projection.
     * Column major, so `[2][2]` is element 10 and `[3][3]` is element 15.
     */
    this.depthToViewZ[0] = invProjection[10] ?? 0;
    this.depthToViewZ[1] = invProjection[14] ?? 0;
    this.depthToViewZ[2] = invProjection[11] ?? 0;
    this.depthToViewZ[3] = invProjection[15] ?? 1;

    gl.useProgram(this.blurProgram);
    gl.uniform1i(this.blurUniforms['uAo'] ?? null, 0);
    gl.uniform1i(this.blurUniforms['uDepth'] ?? null, 1);
    gl.uniform4fv(this.blurUniforms['uDepthToViewZ'] ?? null, this.depthToViewZ);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, depth);

    /* Across, into the scratch target. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFramebuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.estimate);
    this.step[0] = 1 / width;
    this.step[1] = 0;
    gl.uniform2fv(this.blurUniforms['uStep'] ?? null, this.step);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* And down, back into the estimate, which is the texture handed out. */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.estimateFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, this.scratch);
    this.step[0] = 0;
    this.step[1] = 1 / height;
    gl.uniform2fv(this.blurUniforms['uStep'] ?? null, this.step);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.estimate;
  }

  dispose(): void {
    const { gl } = this;
    if (this.estimateFramebuffer !== null) gl.deleteFramebuffer(this.estimateFramebuffer);
    if (this.scratchFramebuffer !== null) gl.deleteFramebuffer(this.scratchFramebuffer);
    if (this.estimate !== null) gl.deleteTexture(this.estimate);
    if (this.scratch !== null) gl.deleteTexture(this.scratch);
    gl.deleteProgram(this.estimateProgram);
    gl.deleteProgram(this.blurProgram);
    gl.deleteVertexArray(this.vao);
    this.estimateFramebuffer = null;
    this.scratchFramebuffer = null;
    this.estimate = null;
    this.scratch = null;
  }
}
