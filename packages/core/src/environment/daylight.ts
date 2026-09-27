/**
 * A day's lighting as a palette keyed by one number, and an exposure that follows it in time.
 *
 * **Keyed by any scalar a caller chooses.** A courtyard keys it by the sun's elevation in degrees,
 * because what the light does there is a function of how high the sun stands; a scene that lerps
 * between a night and a day by a day factor keys it at 0 and 1 and gets exactly the blend it had.
 * The palette is data — colours, a density, a strength, an exposure — so which hours exist and what
 * they look like stay the scene's, and the mechanism is the engine's.
 *
 * **Linear between keys, and in stops for exposure.** Colours and densities blend linearly, which
 * is what every hand-written day cycle in this repository did; exposure blends in log2, because two
 * keys a stop apart should pass through half a stop and not through the arithmetic mean, which sits
 * nearer the brighter key. What that gives up is smoothness at a key: the blend has a corner there.
 * What would make it wrong is a palette so sparse that the corner shows as a change of pace in the
 * sky, and the answer then is more keys rather than a curve.
 *
 * Nothing here allocates after construction: `resolveDaylight` writes into a caller-owned state.
 */
import type { Vec3 } from '../math/color.ts';

/** The lighting at one point of the palette's scalar. Every colour is linear and may exceed one. */
export interface DaylightKey {
  /** Where on the palette's scalar this key sits: a sun elevation, a day factor, an hour. */
  readonly at: number;
  /** The sun's radiance at the surface it lights, which is the directional light while it is up. */
  readonly sunColor: Readonly<Vec3>;
  /** The moon's, for whichever part of the palette the moon lights. */
  readonly moonColor: Readonly<Vec3>;
  readonly skyTop: Readonly<Vec3>;
  readonly skyHorizon: Readonly<Vec3>;
  readonly skyDeep: Readonly<Vec3>;
  /** The hemisphere's sky half. */
  readonly ambient: Readonly<Vec3>;
  /** The hemisphere's ground half: what the floor throws back up. */
  readonly ambientGround: Readonly<Vec3>;
  readonly fogColor: Readonly<Vec3>;
  readonly fogDensity: number;
  /** How dark a directional shadow is, 0 to 1. */
  readonly shadowStrength: number;
  /** The emissive master gain: how strongly lamps and flames read against this light. */
  readonly emissiveGain: number;
  /** The exposure a viewer's eye settles on here. Positive; blended in stops. */
  readonly exposure: number;
}

/** Keys in ascending order of `at`, validated once. Build with `createDaylightPalette`. */
export interface DaylightPalette {
  readonly keys: readonly DaylightKey[];
}

/** One moment of the palette, written in place by `resolveDaylight`. */
export interface DaylightState {
  sunColor: Vec3;
  moonColor: Vec3;
  skyTop: Vec3;
  skyHorizon: Vec3;
  skyDeep: Vec3;
  ambient: Vec3;
  ambientGround: Vec3;
  fogColor: Vec3;
  fogDensity: number;
  shadowStrength: number;
  emissiveGain: number;
  exposure: number;
}

/** Sort and check the keys. Throws at construction, so a bad palette never reaches a frame. */
export function createDaylightPalette(keys: readonly DaylightKey[]): DaylightPalette {
  if (keys.length === 0) throw new Error('a daylight palette needs at least one key');
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i] as DaylightKey;
    if (!(current.exposure > 0)) {
      throw new Error(`the key at ${current.at} has exposure ${current.exposure}; it must be > 0`);
    }
    if (i > 0 && (sorted[i - 1] as DaylightKey).at === current.at) {
      throw new Error(`a daylight palette has two keys at ${current.at}`);
    }
  }
  return { keys: sorted };
}

export function createDaylightState(): DaylightState {
  return {
    sunColor: [0, 0, 0],
    moonColor: [0, 0, 0],
    skyTop: [0, 0, 0],
    skyHorizon: [0, 0, 0],
    skyDeep: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    fogColor: [0, 0, 0],
    fogDensity: 0,
    shadowStrength: 0,
    emissiveGain: 0,
    exposure: 1,
  };
}

function blendInto(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/** The palette at `at`, into `out`. Past either end the nearest key holds. */
export function resolveDaylight(
  at: number,
  palette: DaylightPalette,
  out: DaylightState,
): DaylightState {
  const keys = palette.keys;
  let upper = 0;
  while (upper < keys.length && (keys[upper] as DaylightKey).at < at) upper++;
  const b = keys[Math.min(upper, keys.length - 1)] as DaylightKey;
  const a = keys[Math.max(upper - 1, 0)] as DaylightKey;
  const t = a === b ? 0 : (at - a.at) / (b.at - a.at);
  blendInto(out.sunColor, a.sunColor, b.sunColor, t);
  blendInto(out.moonColor, a.moonColor, b.moonColor, t);
  blendInto(out.skyTop, a.skyTop, b.skyTop, t);
  blendInto(out.skyHorizon, a.skyHorizon, b.skyHorizon, t);
  blendInto(out.skyDeep, a.skyDeep, b.skyDeep, t);
  blendInto(out.ambient, a.ambient, b.ambient, t);
  blendInto(out.ambientGround, a.ambientGround, b.ambientGround, t);
  blendInto(out.fogColor, a.fogColor, b.fogColor, t);
  out.fogDensity = a.fogDensity + (b.fogDensity - a.fogDensity) * t;
  out.shadowStrength = a.shadowStrength + (b.shadowStrength - a.shadowStrength) * t;
  out.emissiveGain = a.emissiveGain + (b.emissiveGain - a.emissiveGain) * t;
  out.exposure = t === 0 ? a.exposure : a.exposure * (b.exposure / a.exposure) ** t;
  return out;
}

/**
 * `current` moved toward `target` over `dtSec`, closing half the distance in stops every
 * `halfLifeSec`.
 *
 * **In time, not per frame**, so a 144 Hz display adapts exactly as fast as a 60 Hz one: the
 * remaining distance after any number of steps is `2^(−elapsed / halfLife)` of what it was, however
 * the elapsed time was cut up. A half-life of zero is a cut to the target. Both exposures must be
 * positive, which is what an exposure is.
 */
export function easeExposure(
  current: number,
  target: number,
  dtSec: number,
  halfLifeSec: number,
): number {
  if (halfLifeSec <= 0) return target;
  if (dtSec <= 0) return current;
  const closed = 1 - 2 ** (-dtSec / halfLifeSec);
  return current * (target / current) ** closed;
}
