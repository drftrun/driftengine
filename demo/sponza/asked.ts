/**
 * What the address bar may ask of the scene. Every one is an instrument for holding a picture still
 * or taking a part of it away, and none changes what the published loop shows.
 *
 *     ?hour=19.5                   hold an hour, adapted, with the grid baked before the frame counts
 *     ?speed=2                     run the loop at twice the rate
 *     ?eye=x,y,z&at=x,y,z&fov=60   hold the camera there, to stand where a reference was taken
 *     ?bounce=0                    no probe grid, the control the bounce is compared against
 *     ?lights=64                   shade at most this many lights at once
 *     ?candles=0.5                 the share of the pack's candles kept, 0 to 1 (0.2 by default)
 *     ?candleradius=2.5            how far a candle lights
 *     ?pointshadows=0              no fire casts
 *     ?driftlight=0                no summed candlelight: only the nearest candles light
 *     ?tree=1                      the cypress in the middle of the courtyard, left out by default
 *     ?packs=base,candles  ?cap=2048  ?maps=albedo  ?blend=0   see `packs.ts`
 *     ?grade=0                     the frame without the grade
 *     ?sun=0                       no key light: what is left is sky, bounce and fire
 *     ?ev=-1                       a stop under the palette's exposure, for matching a reference
 *     ?haze=0                      the air's density scaled: 0 is clear air, the shafts' control
 *     ?tone=none                   linear light out, for measuring albedo
 *     ?indirect=0                  the rasterised probe grid, where DriftRay traces the bounce on
 *                                  the high tier (see `isHighTier`); ?indirect=1 traces on any WebGPU
 *     ?adapt=0                     no eye adaptation: the palette's exposure alone, as before it
 *     ?local=0                     no local exposure: one exposure for the whole frame (0.2 by default)
 */
import type { Vec3 } from '../../packages/core/src/index';

export interface HeldEye {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly fovDeg: number;
}

export function askedNumber(search: URLSearchParams, name: string): number | undefined {
  const raw = search.get(name);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** `?eye=x,y,z&at=x,y,z&fov=deg`, or undefined when either point is missing or not numbers. */
export function askedEye(search: URLSearchParams): HeldEye | undefined {
  const eye = (search.get('eye') ?? '').split(/[, ]/).map(Number);
  const target = (search.get('at') ?? '').split(/[, ]/).map(Number);
  if (eye.length !== 3 || target.length !== 3) return undefined;
  if (![...eye, ...target].every(Number.isFinite)) return undefined;
  return {
    eye: [eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0],
    target: [target[0] ?? 0, target[1] ?? 0, target[2] ?? 0],
    fovDeg: askedNumber(search, 'fov') ?? 60,
  };
}
