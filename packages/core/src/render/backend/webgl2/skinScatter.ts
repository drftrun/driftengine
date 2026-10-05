/**
 * Skin's screen-space scattering on WebGL2: the target skin's diffuse half is drawn into, and the
 * two passes that spread it. `skinBlur.ts` is what the blur computes and why; the WebGPU backend's
 * `skinScatterPass.ts` is the same thing in that backend's terms.
 *
 * **Drawn as it goes, not kept**: this backend issues a draw when it is asked for, and the state a
 * skin draw reads — its joint palette, its uniforms — is rewritten by the draw after it. So the
 * renderer draws each skin three times in place: the frame's half, then at once the diffuse's light
 * alone into this target and its colour alone into the other, both sharing the frame's depth and
 * testing for equality against it. The blur spreads the light and multiplies it by the colour.
 *
 * **The units it reads are its own** — `SKIN_BLUR_TEXTURE_UNIT` and the one after — past every
 * unit a lit program binds, because it runs in the middle of a frame and the draws after it must
 * find their textures where they left them.
 */
import {
  SKIN_BLUR_ALBEDO_UNIT,
  SKIN_BLUR_DEPTH_UNIT,
  SKIN_BLUR_TEXTURE_UNIT,
} from '../../lightBudget.ts';
import { blendKeeping } from '../../sceneCoverage.ts';
import type { SceneTarget } from '../../sceneTarget.ts';
import { compileProgram, uniformLocations } from '../../shader.ts';
import { FULLSCREEN_VERT } from '../../shaders/fullscreen.ts';
import { SKIN_BLUR_FRAG } from '../../shaders/skinBlur.ts';
import { SKIN_PROFILES } from '../../skinBlur.ts';

const CLEAR = new Float32Array(4);

export class GlSkinScatter {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;
  /** Each profile's scatter distance per channel, in metres: four floats a profile. */
  private readonly profiles = new Float32Array(SKIN_PROFILES * 4);
  private readonly step = new Float32Array(2);
  private readonly depthToViewZ = new Float32Array(4);
  private diffuse: WebGLTexture | null = null;
  private across: WebGLTexture | null = null;
  private albedo: WebGLTexture | null = null;
  private multisampled: WebGLRenderbuffer | null = null;
  private albedoMultisampled: WebGLRenderbuffer | null = null;
  private drawFramebuffer: WebGLFramebuffer | null = null;
  private resolveFramebuffer: WebGLFramebuffer | null = null;
  private albedoFramebuffer: WebGLFramebuffer | null = null;
  private albedoResolveFramebuffer: WebGLFramebuffer | null = null;
  private acrossFramebuffer: WebGLFramebuffer | null = null;
  private width = 0;
  private height = 0;
  private samples = 1;
  private sharedDepth: WebGLTexture | WebGLRenderbuffer | null = null;
  /** Refused once and for good: a driver that will not render to half floats. */
  private unavailable = false;
  private cleared = false;
  private albedoCleared = false;
  private drawn = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = compileProgram(gl, FULLSCREEN_VERT, SKIN_BLUR_FRAG, 'skinBlur');
    this.uniforms = uniformLocations(gl, this.program, 'skinBlur');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('GlSkinScatter: createVertexArray failed');
    this.vao = vao;
    /*
     * Rendering to half floats is the extension's, not WebGL2's — the scene target asks for it
     * only when it keeps range, so this asks for itself. Without it, skin is drawn whole.
     */
    if (gl.getExtension('EXT_color_buffer_float') === null) this.refuse();
  }

  /** Whether any skin's diffuse was drawn this frame. */
  get pending(): boolean {
    return this.drawn;
  }

  /** What one profile scatters, per channel, in metres: the last material to name it says. */
  setProfile(index: number, r: number, g: number, b: number): void {
    const at = Math.min(Math.max(Math.round(index), 0), SKIN_PROFILES - 1) * 4;
    this.profiles[at] = r;
    this.profiles[at + 1] = g;
    this.profiles[at + 2] = b;
  }

  /**
   * Whether a skin can be drawn in two halves now: the target fits the frame and shares its depth.
   * False where this driver will not render to half floats, and then skin is drawn whole.
   */
  ready(scene: SceneTarget): boolean {
    if (this.unavailable) return false;
    const depth = scene.sharedDepth();
    const attached = depth.renderbuffer ?? depth.texture;
    if (attached === null) return false;
    if (
      this.drawFramebuffer !== null &&
      this.width === depth.width &&
      this.height === depth.height &&
      this.samples === depth.samples &&
      this.sharedDepth === attached
    ) {
      return true;
    }
    const made = this.allocate(
      depth.width,
      depth.height,
      depth.samples,
      depth.texture,
      depth.renderbuffer,
    );
    /* Asked in the middle of a frame: the frame's own framebuffer goes back as it was. */
    scene.bind();
    return made;
  }

  /** Bind the target for one skin's diffuse half, cleared the first time a frame does. */
  begin(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.drawFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    if (!this.cleared) {
      gl.clearBufferfv(gl.COLOR, 0, CLEAR);
      this.cleared = true;
    }
    this.drawn = true;
  }

  /** Bind the target for the same skin's colour half, cleared the first time a frame does. */
  beginAlbedo(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.albedoFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    if (!this.albedoCleared) {
      gl.clearBufferfv(gl.COLOR, 0, CLEAR);
      this.albedoCleared = true;
    }
  }

  /**
   * Across into the second target, then down and added into the frame, which `scene` binds. `depth`
   * is the frame's depth as a single-sampled texture, or null where none could be had — and then
   * the diffuse goes back unspread rather than not at all, so the skin keeps its light.
   */
  spread(
    scene: SceneTarget,
    depth: WebGLTexture | null,
    empty: WebGLTexture,
    projection: ArrayLike<number>,
    inverse: ArrayLike<number>,
  ): void {
    const { gl } = this;
    if (this.multisampled !== null) {
      this.resolve(this.drawFramebuffer, this.resolveFramebuffer);
      this.resolve(this.albedoFramebuffer, this.albedoResolveFramebuffer);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.program);
    const u = this.uniforms;
    gl.uniform1i(u['uSkin'] ?? null, SKIN_BLUR_TEXTURE_UNIT);
    gl.uniform1i(u['uDepth'] ?? null, SKIN_BLUR_DEPTH_UNIT);
    gl.uniform1i(u['uAlbedo'] ?? null, SKIN_BLUR_ALBEDO_UNIT);
    gl.activeTexture(gl.TEXTURE0 + SKIN_BLUR_ALBEDO_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.albedo ?? empty);
    /* The four terms that carry a depth back to view-space metres: the occlusion blur's own. */
    this.depthToViewZ[0] = (inverse[10] as number) ?? 0;
    this.depthToViewZ[1] = (inverse[14] as number) ?? 0;
    this.depthToViewZ[2] = (inverse[11] as number) ?? 0;
    this.depthToViewZ[3] = (inverse[15] as number) ?? 1;
    gl.uniform4fv(u['uDepthToViewZ'] ?? null, this.depthToViewZ);
    /* Pixels a metre spans at a metre; nothing to measure against without a depth, so nothing spreads. */
    gl.uniform1f(
      u['uFocal'] ?? null,
      depth === null ? 0 : ((projection[5] as number) * this.height) / 2,
    );
    gl.uniform4fv(u['uProfiles'] ?? null, this.profiles);
    gl.activeTexture(gl.TEXTURE0 + SKIN_BLUR_DEPTH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, depth ?? empty);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.acrossFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0 + SKIN_BLUR_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.diffuse);
    this.step[0] = 1 / this.width;
    this.step[1] = 0;
    gl.uniform2fv(u['uStep'] ?? null, this.step);
    /* The light spreads on both axes; the colour is applied once, on the one adding into the frame. */
    gl.uniform1f(u['uApplyAlbedo'] ?? null, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    scene.bind();
    gl.bindTexture(gl.TEXTURE_2D, this.across);
    this.step[0] = 0;
    this.step[1] = 1 / this.height;
    gl.uniform2fv(u['uStep'] ?? null, this.step);
    gl.uniform1f(u['uApplyAlbedo'] ?? null, 1);
    /* Added: its colour onto the frame's, the frame's alpha kept. */
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    blendKeeping(gl, gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* The world pass's own state, as the next draw expects to find it. */
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  /** Spent at the frame's start: what was drawn into the target was last frame's. */
  reset(): void {
    this.cleared = false;
    this.albedoCleared = false;
    this.drawn = false;
  }

  /** A multisampled target into its single-sampled texture. */
  private resolve(from: WebGLFramebuffer | null, to: WebGLFramebuffer | null): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      this.width,
      this.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
  }

  dispose(): void {
    const { gl } = this;
    this.release();
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }

  private allocate(
    width: number,
    height: number,
    samples: number,
    depthTexture: WebGLTexture | null,
    depthRenderbuffer: WebGLRenderbuffer | null,
  ): boolean {
    const { gl } = this;
    this.release();
    this.width = width;
    this.height = height;
    this.samples = samples;
    /* Its own unit, so making its textures unbinds nothing a lit program reads. */
    gl.activeTexture(gl.TEXTURE0 + SKIN_BLUR_TEXTURE_UNIT);
    this.sharedDepth = depthRenderbuffer ?? depthTexture;
    this.diffuse = this.halfFloatTexture(width, height);
    this.across = this.halfFloatTexture(width, height);
    this.albedo = this.halfFloatTexture(width, height);

    const multisampled = samples > 1 && depthRenderbuffer !== null;
    const diffuse = this.drawTarget(this.diffuse, multisampled, depthTexture, depthRenderbuffer);
    this.drawFramebuffer = diffuse.framebuffer;
    this.multisampled = diffuse.multisampled;
    this.resolveFramebuffer = diffuse.resolve;
    const albedo = this.drawTarget(this.albedo, multisampled, depthTexture, depthRenderbuffer);
    this.albedoFramebuffer = albedo.framebuffer;
    this.albedoMultisampled = albedo.multisampled;
    this.albedoResolveFramebuffer = albedo.resolve;

    this.acrossFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.acrossFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.across, 0);
    const acrossReady = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    if (diffuse.ready && albedo.ready && acrossReady) return true;
    this.release();
    this.refuse();
    return false;
  }

  /**
   * A framebuffer a skin half draws into against the frame's depth: the texture itself, or a
   * multisampled renderbuffer and the framebuffer that resolves it into the texture.
   */
  private drawTarget(
    texture: WebGLTexture | null,
    multisampled: boolean,
    depthTexture: WebGLTexture | null,
    depthRenderbuffer: WebGLRenderbuffer | null,
  ): {
    framebuffer: WebGLFramebuffer | null;
    multisampled: WebGLRenderbuffer | null;
    resolve: WebGLFramebuffer | null;
    ready: boolean;
  } {
    const { gl } = this;
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    let samples: WebGLRenderbuffer | null = null;
    if (multisampled && depthRenderbuffer !== null) {
      samples = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, samples);
      gl.renderbufferStorageMultisample(
        gl.RENDERBUFFER,
        this.samples,
        gl.RGBA16F,
        this.width,
        this.height,
      );
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, samples);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        depthRenderbuffer,
      );
    } else {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
    }
    const ready = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    let resolve: WebGLFramebuffer | null = null;
    if (samples !== null) {
      resolve = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, resolve);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    }
    return { framebuffer, multisampled: samples, resolve, ready };
  }

  private refuse(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    console.warn(
      "WebGL2: this driver will not render skin's diffuse to half floats, so skinScattering " +
        "'screen-space' draws skin pre-integrated. The frame is otherwise unaffected.",
    );
  }

  private halfFloatTexture(width: number, height: number): WebGLTexture | null {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    /* Linear: the blur takes taps between texels, and reads a part-covered one for the part it is. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  private release(): void {
    const { gl } = this;
    if (this.drawFramebuffer !== null) gl.deleteFramebuffer(this.drawFramebuffer);
    if (this.resolveFramebuffer !== null) gl.deleteFramebuffer(this.resolveFramebuffer);
    if (this.albedoFramebuffer !== null) gl.deleteFramebuffer(this.albedoFramebuffer);
    if (this.albedoResolveFramebuffer !== null) {
      gl.deleteFramebuffer(this.albedoResolveFramebuffer);
    }
    if (this.acrossFramebuffer !== null) gl.deleteFramebuffer(this.acrossFramebuffer);
    if (this.multisampled !== null) gl.deleteRenderbuffer(this.multisampled);
    if (this.albedoMultisampled !== null) gl.deleteRenderbuffer(this.albedoMultisampled);
    if (this.diffuse !== null) gl.deleteTexture(this.diffuse);
    if (this.across !== null) gl.deleteTexture(this.across);
    if (this.albedo !== null) gl.deleteTexture(this.albedo);
    this.drawFramebuffer = null;
    this.resolveFramebuffer = null;
    this.albedoFramebuffer = null;
    this.albedoResolveFramebuffer = null;
    this.acrossFramebuffer = null;
    this.multisampled = null;
    this.albedoMultisampled = null;
    this.diffuse = null;
    this.across = null;
    this.albedo = null;
    this.sharedDepth = null;
  }
}
