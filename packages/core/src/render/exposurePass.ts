import {
  EXPOSURE_ADAPT_FRAG,
  EXPOSURE_METER_FRAG,
  METER_GRID,
  adaptBlend,
} from './shaders/exposure.ts';
import { EXPOSURE_LOCAL_FRAG, LOCAL_GRID_WIDTH } from './shaders/localExposure.ts';
import { FULLSCREEN_VERT } from './shaders/fullscreen.ts';
import { compileProgram, uniformLocations } from './shader.ts';

/**
 * Eye adaptation on WebGL2: meter the finished scene, and follow it with a held brightness the
 * composite reads. See `shaders/exposure.ts` for the design; this owns the targets and the draws.
 *
 * **Two one-texel targets that swap roles each frame**, because the adaptation reads what it held
 * and a texture cannot be read and written in one draw. The composite is handed whichever was
 * written last. `R16F`, because the held value is in stops and eight bits of a range twenty stops
 * wide is an exposure that steps visibly as it moves.
 *
 * **And local exposure's grid, when that is asked for**: `RG16F`, a sum and a count per tile per
 * band, filtered linearly because the composite reads it between tiles. See `localExposure.ts`.
 */
export class ExposurePass {
  private meter: WebGLTexture | null = null;
  private meterFramebuffer: WebGLFramebuffer | null = null;
  private localGrid: WebGLTexture | null = null;
  private localFramebuffer: WebGLFramebuffer | null = null;
  private readonly held: (WebGLTexture | null)[] = [null, null];
  private readonly heldFramebuffers: (WebGLFramebuffer | null)[] = [null, null];
  /** Which of the two held texels the next adaptation writes. */
  private writing = 0;
  /** Whether anything is held yet: the first frame, and the first after a cut, snaps. */
  private holding = false;
  private allocated = false;
  /** Set once if a half-float target will not complete; the pass is then off and says so once. */
  private unavailable = false;

  private readonly meterProgram: WebGLProgram;
  private readonly meterUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly adaptProgram: WebGLProgram;
  private readonly adaptUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly localProgram: WebGLProgram;
  private readonly localUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.meterProgram = compileProgram(gl, FULLSCREEN_VERT, EXPOSURE_METER_FRAG, 'exposureMeter');
    this.meterUniforms = uniformLocations(gl, this.meterProgram, 'exposureMeter');
    this.adaptProgram = compileProgram(gl, FULLSCREEN_VERT, EXPOSURE_ADAPT_FRAG, 'exposureAdapt');
    this.adaptUniforms = uniformLocations(gl, this.adaptProgram, 'exposureAdapt');
    this.localProgram = compileProgram(gl, FULLSCREEN_VERT, EXPOSURE_LOCAL_FRAG, 'exposureLocal');
    this.localUniforms = uniformLocations(gl, this.localProgram, 'exposureLocal');
    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('ExposurePass: createVertexArray failed');
    this.vao = vao;
  }

  /** Forget what is held, so the next frame meters afresh rather than easing from another shot. */
  cut(): void {
    this.holding = false;
  }

  private ensure(): boolean {
    if (this.unavailable) return false;
    if (this.allocated) return true;
    const { gl } = this;
    const target = (
      size: number,
      height = size,
      pair = false,
    ): { texture: WebGLTexture | null; framebuffer: WebGLFramebuffer | null; ok: boolean } => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (pair)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, size, height, 0, gl.RG, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, size, height, 0, gl.RED, gl.HALF_FLOAT, null);
      const filter = pair ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      return { texture, framebuffer, ok };
    };
    const meter = target(METER_GRID);
    const first = target(1);
    const second = target(1);
    const local = target(LOCAL_GRID_WIDTH, METER_GRID, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.meter = meter.texture;
    this.meterFramebuffer = meter.framebuffer;
    this.held[0] = first.texture;
    this.held[1] = second.texture;
    this.heldFramebuffers[0] = first.framebuffer;
    this.heldFramebuffers[1] = second.framebuffer;
    this.localGrid = local.texture;
    this.localFramebuffer = local.framebuffer;
    this.allocated = true;
    if (!meter.ok || !first.ok || !second.ok || !local.ok) {
      this.unavailable = true;
      console.warn(
        'ExposurePass: this driver will not render to a half-float target, so eye adaptation is ' +
          'off and the exposure is the one set. The frame itself is unaffected.',
      );
      return false;
    }
    return true;
  }

  /**
   * Meter `scene` and move the held brightness toward it by `dtSec` of adaptation, and with `local`
   * draw local exposure's grid too. Returns the texel the composite reads, or null where this pass
   * could not run, which the caller reads as off.
   */
  run(scene: WebGLTexture, dtSec: number, local = false): WebGLTexture | null {
    if (!this.ensure()) return null;
    const { gl } = this;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterFramebuffer);
    gl.viewport(0, 0, METER_GRID, METER_GRID);
    gl.useProgram(this.meterProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene);
    gl.uniform1i(this.meterUniforms['uScene'] ?? null, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (local) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.localFramebuffer);
      gl.viewport(0, 0, LOCAL_GRID_WIDTH, METER_GRID);
      gl.useProgram(this.localProgram);
      gl.uniform1i(this.localUniforms['uScene'] ?? null, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const into = this.writing;
    const from = 1 - into;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heldFramebuffers[into] ?? null);
    gl.viewport(0, 0, 1, 1);
    gl.useProgram(this.adaptProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.meter);
    gl.uniform1i(this.adaptUniforms['uMeter'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.held[from] ?? null);
    gl.uniform1i(this.adaptUniforms['uHeld'] ?? null, 1);
    gl.uniform1f(this.adaptUniforms['uBlend'] ?? null, adaptBlend(dtSec, !this.holding));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.holding = true;
    this.writing = from;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.held[into] ?? null;
  }

  /** Local exposure's grid as the last `run` drew it, or null before one has. */
  get localTexture(): WebGLTexture | null {
    return this.localGrid;
  }

  dispose(): void {
    const { gl } = this;
    for (const framebuffer of [
      this.meterFramebuffer,
      this.localFramebuffer,
      ...this.heldFramebuffers,
    ]) {
      if (framebuffer !== null) gl.deleteFramebuffer(framebuffer);
    }
    for (const texture of [this.meter, this.localGrid, ...this.held])
      if (texture !== null) gl.deleteTexture(texture);
    gl.deleteProgram(this.meterProgram);
    gl.deleteProgram(this.localProgram);
    gl.deleteProgram(this.adaptProgram);
    gl.deleteVertexArray(this.vao);
  }
}
