import { mat4 } from 'gl-matrix';
import type { ReadonlyMat4 } from 'gl-matrix';

import { mediumTargetSize } from './globalMedium.ts';
import type { GlobalMediumOptions } from './globalMedium.ts';
import { DEPTH_01_TO_CLIP } from './lightVolumeDraw.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import { MEDIUM_FRAG, MEDIUM_UPSAMPLE_FRAG } from './shaders/globalMedium.ts';

/** What the march needs about the light, which is the sun and the sky and nothing else. */
export interface MediumLight {
  /** Surface → sun, normalised. `Environment.directionalDir` unchanged. */
  readonly sunDir: ArrayLike<number>;
  readonly sunColor: ArrayLike<number>;
  /** The sky's fill, scattered isotropically, so a shadowed medium is grey rather than black. */
  readonly ambient: ArrayLike<number>;
  /** How much of the medium the sun's shadow map removes, 0 to 1. At 0 no map is sampled. */
  readonly sunShadow: number;
  /** World → light clip, **uncorrected**: the shader does its own `* 0.5 + 0.5`. */
  readonly lightViewProj: ReadonlyMat4;
  readonly staticShadowMap: WebGLTexture;
  readonly peeledShadowMap: WebGLTexture;
  readonly dynamicShadowMap: WebGLTexture;
  readonly peeledEnabled: boolean;
}

/**
 * The global participating medium on WebGL2: a half-res march, then a depth-aware composite.
 *
 * **Its own module rather than more of `SceneTarget`**, on the split `ambientOcclusionPass.ts`
 * draws: that class owns where the frame lands and how it reaches the canvas, and this owns one
 * effect's target and programs. It is patterned on `SsrPass` more closely than on the occlusion
 * pass, because it has the same shape — a march into a target of its own, then one composite done
 * by the blend state, so neither pass ever samples the colour it is modifying.
 *
 * **One target and no ping-pong.** The march writes scattered light in `rgb` and transmittance in
 * `a`; `(ONE, SRC_ALPHA)` against that is `dst * T + L`, which is the transfer equation for the
 * segment written out. There is nothing to blur — a homogeneous medium is smooth by construction,
 * and the only sharp thing in the integral is the shadow map, which the march dithers.
 */
export class GlobalMediumPass {
  private readonly march: WebGLProgram;
  private readonly marchUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly upsample: WebGLProgram;
  private readonly upsampleUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;

  private target: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private width = 0;
  private height = 0;
  /** The frame size the current target was derived from, so a resize is noticed. */
  private frameWidth = 0;
  private frameHeight = 0;
  private half = true;

  /**
   * Set once if the target will not complete, after which this pass does nothing and says so once.
   *
   * The same honest "off" `ambientOcclusionPass.ts` takes, and its note is the argument: *"the
   * alternative to an honest off is a frame multiplied by a target that was never written, and the
   * last time an effect in this renderer sampled a target nobody had filled, the failure presented
   * as the driver being at fault."* Here the multiplication is literal — a composite reading an
   * unwritten alpha would multiply the whole frame by whatever was in that memory.
   */
  private unavailable = false;

  /** `inverse(viewProjection) * DEPTH_01_TO_CLIP`, rebuilt once a frame. See `SsrPass`. */
  private readonly depthToWorld = new Float32Array(16);
  /** The four terms the upsample linearises a depth with, so a per-frame pass allocates nothing. */
  private readonly depthToViewZ = new Float32Array(4);
  private readonly mediumTexel = new Float32Array(2);
  private readonly invProjection = new Float32Array(16);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    /**
     * Whether a half-float target is available, which is `EXT_color_buffer_float`.
     *
     * `RGBA8` is a real fallback rather than a refusal: transmittance lives in 0 to 1 by
     * definition, and the inscatter only leaves that range against an HDR scene — where the
     * fallback clips a bright fog to white instead of losing it. `SceneTarget.keepsRange` makes
     * the same trade for the frame itself.
     */
    private readonly floatColor: boolean,
  ) {
    this.march = compileProgram(gl, FULLSCREEN_VERT, MEDIUM_FRAG, 'medium');
    this.marchUniforms = uniformLocations(gl, this.march, 'medium');
    this.upsample = compileProgram(gl, FULLSCREEN_VERT, MEDIUM_UPSAMPLE_FRAG, 'mediumUpsample');
    this.upsampleUniforms = uniformLocations(gl, this.upsample, 'mediumUpsample');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('GlobalMediumPass: createVertexArray failed');
    this.vao = vao;
  }

  private ensureSize(frameWidth: number, frameHeight: number, half: boolean): boolean {
    if (this.unavailable) return false;
    if (
      this.frameWidth === frameWidth &&
      this.frameHeight === frameHeight &&
      this.half === half &&
      this.target !== null
    ) {
      return true;
    }
    const { gl } = this;
    const size = mediumTargetSize(frameWidth, frameHeight, half);
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.half = half;
    this.width = size.width;
    this.height = size.height;

    /* Unit 0, chosen rather than inherited, for the reason `SsrPass.ensureSize` gives. */
    gl.activeTexture(gl.TEXTURE0);
    if (this.target === null) this.target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.floatColor ? gl.RGBA16F : gl.RGBA8,
      size.width,
      size.height,
      0,
      gl.RGBA,
      this.floatColor ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    /*
     * NEAREST, and it is the upsample's design rather than a saving. That pass computes the four
     * bilinear weights itself so that it can *refuse* one of them across a depth edge, and it
     * fetches each texel at its own centre — where a linear filter returns the texel exactly.
     * Asking the hardware to blend as well would blend the taps this pass exists to separate.
     */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (this.framebuffer === null) this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
    const ready = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (!ready) {
      this.unavailable = true;
      console.warn(
        "GlobalMediumPass: this driver will not render to the medium's target, so the global " +
          'medium is off. The frame itself is unaffected.',
      );
      return false;
    }
    return true;
  }

  /**
   * March the medium into this pass's own target. Returns false if it could not run, which the
   * caller must read as "no medium" rather than composite something nobody wrote.
   *
   * `viewProjection` and `projection` are the **raw** camera matrices, as `SsrPass` takes them:
   * `DEPTH_01_TO_CLIP` carries a stored depth back into the clip space the first was built in,
   * and pairing either with a clip-corrected matrix applies the remap twice.
   */
  marchMedium(
    depth: WebGLTexture,
    frameWidth: number,
    frameHeight: number,
    half: boolean,
    steps: number,
    options: GlobalMediumOptions,
    viewProjection: ReadonlyMat4,
    projection: ReadonlyMat4,
    eye: ArrayLike<number>,
    light: MediumLight,
  ): boolean {
    if (!this.ensureSize(frameWidth, frameHeight, half)) return false;
    const { gl } = this;
    const u = this.marchUniforms;

    mat4.invert(this.depthToWorld, viewProjection);
    mat4.multiply(this.depthToWorld, this.depthToWorld, DEPTH_01_TO_CLIP);
    /*
     * The upsample's four terms, taken here because this is the frame the march ran against.
     * Column major, so `[2][2]` is element 10 and `[3][3]` is element 15 — the same four
     * `ambientOcclusionPass.ts` reads, in the same order.
     */
    mat4.invert(this.invProjection, projection);
    this.depthToViewZ[0] = this.invProjection[10] ?? 0;
    this.depthToViewZ[1] = this.invProjection[14] ?? 0;
    this.depthToViewZ[2] = this.invProjection[11] ?? 0;
    this.depthToViewZ[3] = this.invProjection[15] ?? 1;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    /* One triangle over a target with no depth attachment, so nothing inherited from the scene
       pass is tested against a buffer that is not there. */
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);

    gl.useProgram(this.march);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.uniform1i(u['uDepth'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, light.staticShadowMap);
    gl.uniform1i(u['uStaticShadowMap'] ?? null, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, light.peeledShadowMap);
    gl.uniform1i(u['uPeeledShadowMap'] ?? null, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, light.dynamicShadowMap);
    gl.uniform1i(u['uDynamicShadowMap'] ?? null, 3);

    gl.uniformMatrix4fv(u['uDepthToWorld'] ?? null, false, this.depthToWorld);
    gl.uniform3f(u['uCameraPos'] ?? null, eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0);
    gl.uniform3f(
      u['uSunDir'] ?? null,
      light.sunDir[0] ?? 0,
      light.sunDir[1] ?? 1,
      light.sunDir[2] ?? 0,
    );
    gl.uniform3f(
      u['uSunColor'] ?? null,
      light.sunColor[0] ?? 0,
      light.sunColor[1] ?? 0,
      light.sunColor[2] ?? 0,
    );
    gl.uniform3f(
      u['uAmbient'] ?? null,
      light.ambient[0] ?? 0,
      light.ambient[1] ?? 0,
      light.ambient[2] ?? 0,
    );
    gl.uniform1f(u['uDensity'] ?? null, options.density);
    gl.uniform1f(u['uAlbedo'] ?? null, options.albedo);
    gl.uniform1f(u['uAnisotropy'] ?? null, options.anisotropy);
    gl.uniform1f(u['uMaxDistance'] ?? null, options.maxDistance);
    gl.uniform1i(u['uSteps'] ?? null, steps);
    gl.uniform1f(u['uSunShadow'] ?? null, light.sunShadow);
    gl.uniformMatrix4fv(u['uLightViewProj'] ?? null, false, light.lightViewProj as Float32Array);
    gl.uniform1i(u['uPeeledShadowEnabled'] ?? null, light.peeledEnabled ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    /* Released down to unit 0, for the reason `SsrPass` records: a binding outlives the frame that
       made it, and the next frame attaches one of these as a target while a sampler still names it. */
    for (const unit of [gl.TEXTURE3, gl.TEXTURE2, gl.TEXTURE1, gl.TEXTURE0]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  /**
   * Composite the march over whatever framebuffer is bound, upsampled depth-aware.
   *
   * `(ONE, SRC_ALPHA)` on colour is `dst * transmittance + inscatter`; alpha is left alone with
   * `(ZERO, ONE)`, because the frame's own alpha is not the medium's to spend.
   */
  compositeMedium(depth: WebGLTexture, frameWidth: number, frameHeight: number): void {
    if (this.target === null || this.unavailable) return;
    const { gl } = this;
    const u = this.upsampleUniforms;

    gl.viewport(0, 0, frameWidth, frameHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.SRC_ALPHA, gl.ZERO, gl.ONE);

    gl.useProgram(this.upsample);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.uniform1i(u['uMedium'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.uniform1i(u['uDepth'] ?? null, 1);
    this.mediumTexel[0] = 1 / Math.max(1, this.width);
    this.mediumTexel[1] = 1 / Math.max(1, this.height);
    gl.uniform2fv(u['uMediumTexel'] ?? null, this.mediumTexel);
    gl.uniform4fv(u['uDepthToViewZ'] ?? null, this.depthToViewZ);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    /* Back to the blend every other pass in this renderer assumes it inherits. */
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  dispose(): void {
    const { gl } = this;
    if (this.framebuffer !== null) gl.deleteFramebuffer(this.framebuffer);
    if (this.target !== null) gl.deleteTexture(this.target);
    gl.deleteProgram(this.march);
    gl.deleteProgram(this.upsample);
    gl.deleteVertexArray(this.vao);
    this.framebuffer = null;
    this.target = null;
    this.width = 0;
    this.height = 0;
    this.frameWidth = 0;
    this.frameHeight = 0;
  }
}
