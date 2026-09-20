import type { FrameView } from './frameView.ts';
import type { Vec3 } from '../math/color.ts';
import { compileProgram, uniformLocations } from './shader.ts';
import { CAUSTICS_FRAG, CAUSTICS_VERT } from './shaders/caustics.ts';
import { bindAtmosphere } from './atmosphere.ts';
import type { Atmosphere } from './atmosphere.ts';
import { buildSheets } from './surfaceSheet.ts';
import type { SheetSpan } from './surfaceSheet.ts';
import { seaStateForWind } from './seaState.ts';

/**
 * A surface lit by nearby water: the floor of a pool, the bottom of a flooded
 * corridor, the underside of a bridge, an arch, a jetty, a cave mouth.
 *
 * The caller submits the lit surface and says which body of water is throwing the
 * light. Everything else — where the light lands, how sharp the net is, how it
 * moves — comes from the wave field in `shaders/gerstner.ts`, which is the same
 * field the water surface itself is displaced by.
 *
 * Either side of the surface works. The overhead case came first and passed for
 * the whole feature for a while, but a pool floor is the same optics and by far
 * the more ordinary sight; the sheet simply lies under the water instead of over
 * it.
 */
export interface CausticSheet {
  /** Cross-sections of the lit surface, in order. */
  spans: readonly SheetSpan[];
  /**
   * Resting height of the water throwing the light.
   *
   * Per sheet rather than per draw, so one batch can carry surfaces above and
   * below water at different heights — and so a caller cannot forget to keep the
   * two in step, which is the whole contract of this feature: the pattern is only
   * worth having because it is the crests the player can see.
   */
  waterY: number;
}

/**
 * How far from the water the effect has died out.
 *
 * Not a fade for performance — a physical limit. The net spreads with distance and
 * is gone by the time a soffit is a dozen metres up, or a pool that deep. A road
 * bridge over a canal is around six, which is comfortably inside it; the fade
 * starts at 45% of this so that distance is not already dimmed.
 */
export const CAUSTICS_MAX_DROP_M = 12;
const MAX_DROP_M = CAUSTICS_MAX_DROP_M;

/**
 * Cells across a lit surface.
 *
 * The pattern is a fragment computation, so this only has to be fine enough for
 * the linear terms — distance fog and the edge fade — not for the waves.
 */
export const CAUSTICS_CELL_M = 3;
const CELL_M = CAUSTICS_CELL_M;

/** Reused per frame: the colour of the light the water is reflecting. */
const scratchTint = new Float32Array(3);

export class CausticsRenderer {
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly vertexCount: number;

  constructor(gl: WebGL2RenderingContext, sheets: readonly CausticSheet[]) {
    this.program = compileProgram(gl, CAUSTICS_VERT, CAUSTICS_FRAG, 'caustics');
    this.uniforms = uniformLocations(gl, this.program, 'causticsRenderer');

    const mesh = buildSheets(sheets, CELL_M, (sheet, out) => {
      out[0] = sheet.waterY;
      out[1] = 0;
    });
    this.vertexCount = mesh.vertexCount;

    const vao = gl.createVertexArray();
    if (vao === null) throw new Error('CausticsRenderer: createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);
    const attach = (data: Float32Array, location: number, size: number): void => {
      const buffer = gl.createBuffer();
      if (buffer === null) throw new Error('CausticsRenderer: createBuffer failed');
      this.buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    attach(mesh.positions, 0, 3);
    attach(mesh.locals, 1, 2);
    attach(mesh.params, 2, 2);
    gl.bindVertexArray(null);
  }

  /**
   * Add the water's light to an already-shaded scene. Draw after the opaque
   * pass: this is light arriving at a surface, not the surface.
   *
   * @param strength scales the whole effect; 1 is the calibrated default.
   *
   * Answers whether it drew, which the renderer counts on its frame budget.
   */
  draw(
    gl: WebGL2RenderingContext,
    camera: FrameView,
    timeSeconds: number,
    directionalDir: Vec3,
    directionalColor: Vec3,
    ambient: Vec3,
    atmosphere: Atmosphere,
    underwaterEnabled: boolean,
    windX = 0,
    windZ = 0,
    strength = 1,
  ): boolean {
    if (this.vertexCount === 0) return false;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u['uViewProj'] ?? null, false, camera.viewProjection);
    gl.uniform3fv(u['uCameraPos'] ?? null, camera.position);
    gl.uniform1f(u['uTime'] ?? null, timeSeconds);
    gl.uniform1f(u['uMaxDrop'] ?? null, MAX_DROP_M);
    gl.uniform1f(u['uStrength'] ?? null, strength);
    gl.uniform3fv(u['uLightDir'] ?? null, directionalDir);

    /*
     * What the water is reflecting: the dominant source, plus a share of the
     * ambient standing in for the sky itself.
     *
     * The ambient term is not decoration. Under a bridge at night the sun
     * contributes nothing, and a caustic that switched off with the sun would
     * take the best image in the game with it — while skylight on water is a real
     * source, and it is what a phone camera sees under a bridge after dusk.
     */
    scratchTint[0] = (directionalColor[0] ?? 0) * 0.85 + (ambient[0] ?? 0) * 1.5;
    scratchTint[1] = (directionalColor[1] ?? 0) * 0.85 + (ambient[1] ?? 0) * 1.5;
    scratchTint[2] = (directionalColor[2] ?? 0) * 0.85 + (ambient[2] ?? 0) * 1.5;
    gl.uniform3fv(u['uTint'] ?? null, scratchTint);

    // The same sea state, from the same wind, as every other body of water.
    const windSpeed = Math.hypot(windX, windZ);
    const sea = seaStateForWind(windSpeed);
    const inv = windSpeed > 1e-5 ? 1 / windSpeed : 0;
    gl.uniform2f(u['uWindDir'] ?? null, inv === 0 ? 1 : windX * inv, inv === 0 ? 0 : windZ * inv);
    gl.uniform1f(u['uWaveGain'] ?? null, sea.steepness);
    bindAtmosphere(gl, u, atmosphere, camera.position[1] ?? 0, underwaterEnabled);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    /*
     * No depth write, but depth *testing* stays on: the sheet sits a couple of
     * centimetres under the surface it lights, so geometry in front of it — the
     * character, a lamp, the bridge's own parapet — still occludes the light.
     */
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
