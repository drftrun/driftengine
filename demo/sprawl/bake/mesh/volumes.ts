/**
 * Light standing in the air — a lamp's cone, a beam from a pylon — as the volume the runtime draws
 * it with (`drawLightVolume`) rather than as a surface.
 *
 * **An additive frustum or cone is a volume of light.** The scripts shape a shaft of light as the
 * solid it fills and let their engine add it, and a surface cannot be light: added as a mesh it
 * showed by day as a lit, fogged solid wherever the air was thick, and at night as a hard-edged
 * shape rather than a glow. So a part of that shape and blend leaves the geometry and becomes
 * this record, and the runtime walks the view ray through it, fading it at its length, its
 * aperture and its distance, and by the city's night.
 *
 * **A volume opens from its apex along its axis**, which is how the engine's hull is built: the
 * frustum's narrow end is a slice of a cone whose apex lies beyond it, `near` metres from the apex,
 * and its light reaches `length`. Whichever end is narrower is the near one, so a lamp's cone
 * opens down and a beam widening upward opens up.
 *
 * **Its colour is the reference's arithmetic as far as the scripts give it**: the glow's colour,
 * linear, times its night strength, its alpha and its volume's intensity. How bright one of those
 * units draws is the runtime's, like the lamps' exposure.
 *
 * What it gives up: a `VolumeGlow`'s edge power, axis falloff and head fade, which the engine's
 * march replaces with its own falloffs; and a beam's texture, whose gradient the march's axial
 * fade stands in for.
 */
import type { Value } from '../script/values.ts';
import { multiply } from './flatten.ts';
import type { Matrix, Part } from './flatten.ts';
import { surfaceOf } from './materials.ts';

type P3 = readonly [number, number, number];

export interface CityVolume {
  /** Where the light opens from, world metres. */
  readonly apex: P3;
  /** Which way it opens, a unit vector. */
  readonly axis: P3;
  /** Where the drawn light starts along the axis, and where it ends, in metres from the apex. */
  readonly near: number;
  readonly length: number;
  /** Half-width over distance. */
  readonly spread: number;
  /** Linear, at full night. */
  readonly color: P3;
  /** Metres from the eye over which it fades out, or 0 and 0 for no fade. */
  readonly fadeStart: number;
  readonly fadeEnd: number;
  /** Metres from the eye inside which it fades out, or 0. */
  readonly nearFade: number;
  /** Its brightness's pulse: how often, in hertz, and how deep, 0 to 1. */
  readonly pulse: readonly [number, number];
}

/** The narrowest aperture a volume keeps: a cylinder is a cone this slow, its apex far behind it. */
const MIN_SPREAD = 0.01;

const field = (v: Value | undefined, key: string): Value | undefined =>
  v?.k === 'struct' ? v.fields?.get(key) : undefined;
const num = (v: Value | undefined, key: string, fallback: number): number => {
  const f = field(v, key);
  return f?.k === 'num' ? f.v : fallback;
};

/** `m · (x, y, z, w)`, column-major. */
function apply(m: Matrix, x: number, y: number, z: number, w: number): [number, number, number] {
  const at = (i: number): number => m[i] as number;
  return [
    at(0) * x + at(4) * y + at(8) * z + at(12) * w,
    at(1) * x + at(5) * y + at(9) * z + at(13) * w,
    at(2) * x + at(6) * y + at(10) * z + at(14) * w,
  ];
}

/** The part as a volume of light, placed by `place` where it was flattened at the origin; else null. */
export function volumeOf(part: Part, place?: Matrix): CityVolume | null {
  if ((part.kind !== 'Frustum' && part.kind !== 'Cone') || part.csg !== null) return null;
  const surface = surfaceOf(part.material);
  if (surface.blend !== 'additive') return null;
  const m = place === undefined ? part.matrix : multiply(place, part.matrix);
  const half = num(part.spec, 'length', 1) / 2;
  /* A cone's base is its bottom and its apex its top: a frustum with no top. */
  const cone = part.kind === 'Cone';
  const bottomRadius = cone ? num(part.spec, 'radius', 0.5) : num(part.spec, 'radius_bottom', 0.5);
  const topRadius = cone ? 0 : num(part.spec, 'radius_top', 0.5);
  /* The solid is round about its own y, so its across-axis scale is its x column's. */
  const across = Math.hypot(...apply(m, 1, 0, 0, 0));
  const top = apply(m, 0, half, 0, 1);
  const bottom = apply(m, 0, -half, 0, 1);
  const opensDown = bottomRadius >= topRadius;
  const [from, to] = opensDown ? [top, bottom] : [bottom, top];
  const [narrow, wide] = opensDown ? [topRadius, bottomRadius] : [bottomRadius, topRadius];
  const span = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  if (!(span > 0)) return null;
  const axis: P3 = [(to[0] - from[0]) / span, (to[1] - from[1]) / span, (to[2] - from[2]) / span];
  const spread = Math.max(((wide - narrow) * across) / span, MIN_SPREAD);
  const near = (narrow * across) / spread;

  const c = part.material.components;
  const glow = c.get('VolumeGlow');
  const anim = c.get('MaterialAnim');
  const tint = surface.emissiveColor ?? surface.color;
  const energy = surface.emissive * surface.alpha * num(glow, 'intensity', 1);
  return {
    apex: [from[0] - axis[0] * near, from[1] - axis[1] * near, from[2] - axis[2] * near],
    axis,
    near,
    length: near + span,
    spread,
    color: [tint[0] * energy, tint[1] * energy, tint[2] * energy],
    fadeStart: num(anim, 'emissive_fade_start', 0),
    fadeEnd: num(anim, 'emissive_fade_end', 0),
    nearFade: num(glow, 'near_fade', 0),
    pulse: [num(anim, 'emissive_pulse_hz', 0), num(anim, 'emissive_pulse_depth', 0)],
  };
}
