import {
  BLOOM_DOWNSAMPLE_FRAG,
  BLOOM_PREFILTER_FRAG,
  BLOOM_UPSAMPLE_FRAG,
} from './shaders/bloom.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { BLOOM_FILTER_RADIUS_UV, bloomLevelSizes } from './bloomChain.ts';

/**
 * The bloom chain: threshold the frame, halve it repeatedly, and add it back up.
 *
 * Its own module rather than more of `SceneTarget`, for the same reason `AmbientOcclusionPass`
 * is: that class owns where the frame lands and how it reaches the canvas, and this owns one
 * effect's targets and programs. The composite adds the texture this returns and knows nothing
 * else about it.
 *
 * **A pyramid rather than one wide blur.** A gaussian broad enough to look like glare is
 * hundreds of taps at full resolution. Halving the frame six times and adding the levels back
 * costs about a third of a full-resolution pass in total, and the sum of the octaves is a
 * falloff with no end to it, which is what a real glare has and a single kernel does not.
 */
export class BloomPass {
  /** The chain, level 0 at half the frame and each one after it half again. */
  private readonly levels: {
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    width: number;
    height: number;
  }[] = [];
  private width = 0;
  private height = 0;
  /**
   * Set once if a target will not complete, after which this pass does nothing and says so once.
   *
   * The alternative to an honest "off" is a frame with a texture nobody wrote added into it,
   * and the last time an effect here sampled an unwritten target the failure presented as the
   * driver being at fault. See `sceneTarget.ts`.
   */
  private unavailable = false;
  /** Half floats where the part will render to them. See the note in `allocate`. */
  private readonly floatColor: boolean;

  private readonly prefilterProgram: WebGLProgram;
  private readonly prefilterUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly downsampleProgram: WebGLProgram;
  private readonly downsampleUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly upsampleProgram: WebGLProgram;
  private readonly upsampleUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;
  /** Scratch for the source texel size, so a per-frame pass allocates nothing. */
  private readonly texel = new Float32Array(2);

  constructor(private readonly gl: WebGL2RenderingContext) {
    /*
     * The same extension the scene target asks for, and asked for here too rather than passed
     * in: a chain of eight-bit levels would clip the very values it exists to spread, so a
     * threshold above 1 would produce a black bloom on a part that has the extension for the
     * scene and not for this. Without it the levels are eight-bit and bloom still works on
     * whatever survives below 1, which is what the scene target itself is doing in that case.
     */
    this.floatColor = gl.getExtension('EXT_color_buffer_float') !== null;

    this.prefilterProgram = compileProgram(
      gl,
      FULLSCREEN_VERT,
      BLOOM_PREFILTER_FRAG,
      'bloomPrefilter',
    );
    this.prefilterUniforms = uniformLocations(gl, this.prefilterProgram, 'bloomPrefilter');
    this.downsampleProgram = compileProgram(
      gl,
      FULLSCREEN_VERT,
      BLOOM_DOWNSAMPLE_FRAG,
      'bloomDownsample',
    );
    this.downsampleUniforms = uniformLocations(gl, this.downsampleProgram, 'bloomDownsample');
    this.upsampleProgram = compileProgram(
      gl,
      FULLSCREEN_VERT,
      BLOOM_UPSAMPLE_FRAG,
      'bloomUpsample',
    );
    this.upsampleUniforms = uniformLocations(gl, this.upsampleProgram, 'bloomUpsample');

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('BloomPass: createVertexArray failed');
    this.vao = vao;
  }

  private ensureSize(width: number, height: number): boolean {
    if (this.unavailable) return false;
    if (this.width === width && this.height === height && this.levels.length > 0) return true;
    const { gl } = this;
    this.width = width;
    this.height = height;
    this.release();

    /* The shape of the pyramid is shared, so the other backend cannot build a different one. */
    for (const { width: levelWidth, height: levelHeight } of bloomLevelSizes(width, height)) {
      const texture = this.allocate(levelWidth, levelHeight);
      const framebuffer = gl.createFramebuffer();
      if (texture === null || framebuffer === null) break;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        break;
      }
      this.levels.push({ texture, framebuffer, width: levelWidth, height: levelHeight });
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (this.levels.length === 0) {
      this.unavailable = true;
      console.warn(
        'BloomPass: no level of the chain would allocate, so bloom is off. The frame itself ' +
          'is unaffected.',
      );
      return false;
    }
    return true;
  }

  private allocate(width: number, height: number): WebGLTexture | null {
    const { gl } = this;
    const texture = gl.createTexture();
    if (texture === null) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    /*
     * `RGBA16F` where it is renderable. Half floats are filterable in WebGL2 without an
     * extension — it is *rendering* to them that needs `EXT_color_buffer_float` — so linear
     * filtering below is safe either way.
     */
    if (this.floatColor) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    /* Linear, because every stage samples between texels on purpose: that is where the spread
       comes from, and NEAREST here would show the pyramid as blocks. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    /* Clamped, or a tap past the edge pulls the opposite side of the screen into the corner —
       and at the deepest level, where one texel is a large part of the frame, that is a bright
       smear from somewhere the viewer is not looking. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /**
   * Build the frame's bloom. Returns the texture to add, or null if this pass could not run,
   * which the caller must read as "no bloom" rather than as black.
   *
   * `threshold` is in scene units, so it only separates a light from white paint on a target
   * that kept the range. The caller owns that decision and the warning that goes with it.
   */
  run(scene: WebGLTexture, width: number, height: number, threshold: number): WebGLTexture | null {
    if (!this.ensureSize(width, height)) return null;
    const { gl } = this;
    const levels = this.levels;
    const top = levels[0];
    if (top === undefined) return null;

    /* One triangle over targets with no depth attachment. Anything inherited from the scene
       pass would be tested against a buffer that is not there. */
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);

    /* Threshold, full resolution into level 0. The only stage that reads the scene. */
    gl.useProgram(this.prefilterProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, top.framebuffer);
    gl.viewport(0, 0, top.width, top.height);
    gl.bindTexture(gl.TEXTURE_2D, scene);
    gl.uniform1i(this.prefilterUniforms['uSource'] ?? null, 0);
    gl.uniform1f(this.prefilterUniforms['uThreshold'] ?? null, threshold);
    this.uploadTexel(this.prefilterUniforms, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* Down the chain. Each level reads the one above it, which was written a draw ago. */
    gl.useProgram(this.downsampleProgram);
    gl.uniform1i(this.downsampleUniforms['uSource'] ?? null, 0);
    for (let index = 1; index < levels.length; index++) {
      const target = levels[index];
      const source = levels[index - 1];
      if (target === undefined || source === undefined) break;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      this.uploadTexel(this.downsampleUniforms, source.width, source.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /*
     * And back up, adding into each level rather than replacing it, so level 0 ends up holding
     * every octave at once. Additive blending rather than a second target to ping-pong through:
     * a level is only ever read while a *different* level is bound, so there is no feedback.
     */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.upsampleProgram);
    gl.uniform1i(this.upsampleUniforms['uSource'] ?? null, 0);
    gl.uniform1f(this.upsampleUniforms['uRadius'] ?? null, BLOOM_FILTER_RADIUS_UV);
    for (let index = levels.length - 1; index > 0; index--) {
      const target = levels[index - 1];
      const source = levels[index];
      if (target === undefined || source === undefined) break;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return top.texture;
  }

  /** One source texel in UV, which is what the thirteen taps are laid out in. */
  private uploadTexel(
    uniforms: Record<string, WebGLUniformLocation | null>,
    width: number,
    height: number,
  ): void {
    this.texel[0] = 1 / width;
    this.texel[1] = 1 / height;
    this.gl.uniform2fv(uniforms['uTexel'] ?? null, this.texel);
  }

  private release(): void {
    const { gl } = this;
    for (const level of this.levels) {
      gl.deleteFramebuffer(level.framebuffer);
      gl.deleteTexture(level.texture);
    }
    this.levels.length = 0;
  }

  dispose(): void {
    const { gl } = this;
    this.release();
    gl.deleteProgram(this.prefilterProgram);
    gl.deleteProgram(this.downsampleProgram);
    gl.deleteProgram(this.upsampleProgram);
    gl.deleteVertexArray(this.vao);
  }
}
