import type { Vec3 } from '../math/color.ts';
import { seaStateForAgitation, seaStateForWind } from './seaState.ts';
/* Type-only, so the cycle back to `waterRenderer` is erased rather than real. */
import type { WaterBody } from './waterRenderer.ts';

/**
 * Where the sheet is laid and how hard it is blowing on it, decided for both backends.
 *
 * **The interesting half of `WaterRenderer.draw` is arithmetic, not binding.** Snapping the
 * ocean to whole cells, choosing a sea state from the wind or from an authored agitation,
 * falling back to a bearing in a dead calm — each is a rule with a reason, and a second copy
 * of any of them is a sea that behaves differently depending on which backend drew it. That is
 * the 2026-08-13 rule in `AGENTS.md`.
 */

/**
 * Everything the water shader needs that is not a colour, a matrix or the medium.
 *
 * **The three extents are pairs, and were single numbers until 2026-08-28.** A body bounded by one
 * number is a square, and the shape a consumer actually has is a channel: long in one axis, narrow
 * in the other. Each is measured along the body's **own** axes, which `forward` then turns into the
 * world — so the rim and the wave fade follow the rectangle however it is laid, and the ocean passes
 * the same number twice and is unchanged.
 */
export interface ResolvedWater {
  /** Where the sheet is centred: snapped under the camera, or the body's own middle. */
  readonly origin: Float32Array;
  /** Metres per unit of the sheet's own grid, per axis. The ocean's grid is metres, so (1, 1). */
  readonly span: Float32Array;
  /** How far the sheet carries out, per axis. */
  readonly half: Float32Array;
  /** What the wave fade is measured against, so a bowl is flat at its rim. */
  readonly nearHalf: Float32Array;
  /** The body's own +z in world XZ, unit length. (0, 1) for anything unturned. */
  readonly forward: Float32Array;
  /** Unit wind bearing, or the authored fallback in a dead calm. */
  readonly windDir: Float32Array;
  waveGain: number;
  foamGain: number;
  /** Whether this body is a bounded patch rather than the ocean. */
  bounded: boolean;
}

export function createResolvedWater(): ResolvedWater {
  return {
    origin: new Float32Array(2),
    span: new Float32Array([1, 1]),
    half: new Float32Array(2),
    nearHalf: new Float32Array(2),
    forward: new Float32Array([0, 1]),
    windDir: new Float32Array([1, 0]),
    waveGain: 0,
    foamGain: 0,
    bounded: false,
  };
}

/**
 * Lay the sheet and settle the sea, into a target the caller owns.
 *
 * `cellSize`, `nearHalfExtent` and `farHalfExtent` come from the grid the renderer built, so
 * they differ per renderer rather than being global — which is why they are arguments.
 */
export function resolveWater(
  settings: WaterBody,
  cameraX: number,
  cameraZ: number,
  cellSize: number,
  nearHalfExtent: number,
  farHalfExtent: number,
  windX: number,
  windZ: number,
  out: ResolvedWater,
): ResolvedWater {
  const bounds = settings.bounds;
  out.bounded = bounds !== undefined;
  if (bounds === undefined) {
    /*
     * Snapped to whole cells. Anything else re-samples the wave field as the camera moves,
     * which reads as the surface swimming rather than as the camera travelling over it.
     */
    out.origin[0] = Math.floor(cameraX / cellSize) * cellSize;
    out.origin[1] = Math.floor(cameraZ / cellSize) * cellSize;
    out.span[0] = 1;
    out.span[1] = 1;
    out.half[0] = farHalfExtent;
    out.half[1] = farHalfExtent;
    out.nearHalf[0] = nearHalfExtent;
    out.nearHalf[1] = nearHalfExtent;
    out.forward[0] = 0;
    out.forward[1] = 1;
  } else {
    out.origin[0] = bounds.centreX;
    out.origin[1] = bounds.centreZ;
    /*
     * **`halfM` is the square shorthand and a per-axis extent overrides it on that axis alone.**
     * The rule is applied here and nowhere else, which is what makes two spellings of a square
     * affordable: a second place resolving them is where they would begin to disagree. A body given
     * none of the three is zero-sized and draws nothing, which is a defined state and the right
     * one — the other reading of "no extent" is the unbounded ocean, and omitting `bounds` already
     * says that.
     */
    const halfX = bounds.halfX ?? bounds.halfM ?? 0;
    const halfZ = bounds.halfZ ?? bounds.halfM ?? 0;
    out.span[0] = halfX;
    out.span[1] = halfZ;
    out.half[0] = halfX;
    out.half[1] = halfZ;
    /* The wave fade measures against this, so a bounded body is flat at its own rim. */
    out.nearHalf[0] = halfX;
    out.nearHalf[1] = halfZ;
    /*
     * The direction the body's own +z takes, normalised here so that no backend has to.
     *
     * A direction of no length is read as unturned instead of divided by: the basis the shader
     * builds from this places every vertex of the sheet, so a NaN here is not a wrong sheet, it is
     * a sheet that is nowhere. `Math.sqrt` and not `Math.hypot`, as everywhere else here.
     */
    const fx = bounds.forwardX ?? 0;
    const fz = bounds.forwardZ ?? 1;
    const length = Math.sqrt(fx * fx + fz * fz);
    out.forward[0] = length > 1e-6 ? fx / length : 0;
    out.forward[1] = length > 1e-6 ? fz / length : 1;
  }

  const windSpeed = Math.hypot(windX, windZ);
  /*
   * **`agitation` is an override, not an addition.** Wind builds waves, which is right under
   * the sky and wrong for a cistern, a flooded corridor or a tank below deck — those have a
   * surface that moves with no wind to explain it, and tying them to the weather means a gale
   * outside makes the water in a sealed room choppy.
   */
  const sea =
    settings.agitation === undefined
      ? seaStateForWind(windSpeed)
      : seaStateForAgitation(settings.agitation);
  const inv = windSpeed > 1e-5 ? 1 / windSpeed : 0;
  /* Falls back to the authored bearing in a dead calm rather than collapsing every wave
     direction onto zero. */
  out.windDir[0] = inv === 0 ? 1 : windX * inv;
  out.windDir[1] = inv === 0 ? 0 : windZ * inv;
  out.waveGain = sea.steepness * (settings.waveScale ?? 1);
  out.foamGain = sea.foam;
  return out;
}

/** The body's own colours and scalars, read the same way by both backends. */
export interface WaterAppearance {
  readonly deepColor: Vec3;
  readonly shallowColor: Vec3;
  readonly level: number;
  readonly nadirOpacity: number;
  readonly visibility: number;
  readonly mirror: number;
}

/** Defaults applied once, so neither backend invents its own. */
export function waterAppearance(settings: WaterBody): WaterAppearance {
  return {
    deepColor: settings.deepColor,
    shallowColor: settings.shallowColor,
    level: settings.level,
    nadirOpacity: settings.density ?? 0.22,
    visibility: settings.visibility ?? 1,
    mirror: settings.mirror ?? 0,
  };
}
