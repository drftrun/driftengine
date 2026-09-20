import type { FrameView } from './frameView.ts';
import type { Vec3 } from '../math/color.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { WIND_STREAK_FRAG, WIND_STREAK_VERT } from './shaders/windStreaks.ts';
import {
  WIND_STREAK_DEFAULTS,
  buildWindStreakLattice,
  createResolvedWindStreaks,
  resolveWindStreaks,
  windStreakStrength,
  type WindStreakSettings,
} from './windStreakDraw.ts';
import type { WindField } from './windField.ts';

/**
 * Makes the wind visible once it is strong enough to be worth seeing.
 *
 * The threshold matters as much as the effect. Debris in a light breeze is
 * visual noise across the whole game; debris only when it is genuinely blowing
 * is information — it tells the player why their glide is drifting, at the one
 * moment they need to know.
 *
 * **The thresholds, the drift rate and the lattice are in `windStreakDraw.ts`**, so the WebGPU
 * pass shows the same weather rather than its own approximation of it.
 */
export type WindStreakOptions = WindStreakSettings;

export class WindStreakRenderer {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly vertexCount: number;
  private readonly count: number;
  /** Exposed so callers can size their own budgets against it. */
  private readonly cellSize: number;
  private readonly onsetSpeed: number;
  private readonly fullSpeed: number;

  constructor(gl: WebGL2RenderingContext, options: WindStreakOptions = {}) {
    this.count = options.count ?? WIND_STREAK_DEFAULTS.count;
    this.cellSize = options.cellSize ?? WIND_STREAK_DEFAULTS.cellSize;
    this.onsetSpeed = options.onsetSpeed ?? WIND_STREAK_DEFAULTS.onsetSpeed;
    this.fullSpeed = options.fullSpeed ?? WIND_STREAK_DEFAULTS.fullSpeed;

    this.program = compileProgram(gl, WIND_STREAK_VERT, WIND_STREAK_FRAG, 'windStreaks');
    this.uniforms = uniformLocations(gl, this.program, 'windStreakRenderer');

    const lattice = buildWindStreakLattice(this.count);
    const { corners, indices } = lattice;
    this.vertexCount = lattice.vertexCount;

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('WindStreakRenderer: createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);
    const attach = (data: Float32Array, location: number, size: number): void => {
      const buffer = gl.createBuffer();
      if (buffer === null) throw new Error('WindStreakRenderer: createBuffer failed');
      this.buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    attach(corners, 0, 2);
    attach(indices, 1, 1);
    gl.bindVertexArray(null);
  }

  /** How visible the wind is right now, 0 when there is nothing to show. */
  strengthFor(speed: number): number {
    return windStreakStrength(speed, this.onsetSpeed, this.fullSpeed);
  }

  /** Refilled per call rather than allocated; this is a per-frame path. */
  private readonly resolved = createResolvedWindStreaks();

  /** Answers whether it drew, which the renderer counts on its frame budget. */
  draw(
    gl: WebGL2RenderingContext,
    camera: FrameView,
    wind: WindField,
    timeSeconds: number,
    tint: Vec3,
    /** True when the camera is below the waterline. */
    submerged = false,
  ): boolean {
    /* Chosen in `windStreakDraw.ts` so both backends show the same weather. */
    const settled = resolveWindStreaks(
      wind.speed,
      wind.driftX,
      wind.driftZ,
      this.onsetSpeed,
      this.fullSpeed,
      submerged,
      this.resolved,
    );
    if (!settled.visible) return false;

    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, camera.viewProjection);
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform2f(u['uWind'] ?? null, wind.velocityX, wind.velocityZ);
    gl.uniform2f(u['uDrift'] ?? null, settled.driftX, settled.driftZ);
    gl.uniform1f(u['uSpeed'] ?? null, wind.speed);
    gl.uniform1f(u['uStrength'] ?? null, settled.strength);
    gl.uniform1f(u['uCount'] ?? null, this.count);
    gl.uniform1f(u['uCellSize'] ?? null, this.cellSize);
    gl.uniform1f(u['uTime'] ?? null, timeSeconds);
    gl.uniform3fv(u['uTint'] ?? null, tint);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    return true;
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
