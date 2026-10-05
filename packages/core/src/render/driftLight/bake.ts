/**
 * One brick of DriftLight's volume: at every sample, the light that arrives from every light that
 * reaches it, and the direction it mostly arrives from.
 *
 * **Two texels a sample.** The first is the summed colour, and in its fourth channel whether the
 * sample is a sample at all: one standing inside solid geometry is not, and its zero lets the
 * shader's filtered lookup leave it out rather than blend darkness into the wall beside it. The
 * second is the arrival direction, weighted by each light's brightness, so it points at a lone light
 * with a length of one and shrinks towards zero as lights surround the sample from all sides. The
 * shader turns the pair back into the light on a surface of any facing: exactly Lambert for a single
 * light, a quarter of the sum, the mean of a clamped cosine, for light from everywhere.
 *
 * **What it gives up is the specular.** Two numbers of direction cannot say where a highlight
 * falls, which is why the exact lights near the camera are shaded exactly and this stands in only
 * past them, where a highlight from a candle is a fraction of a pixel.
 */

import type { PointLightFalloff } from './falloff.ts';
import { pointLightShape } from './falloff.ts';
import type { LightFieldLayout, LightReach } from './layout.ts';
import { BRICK_SAMPLES } from './layout.ts';
import type { DistanceAt } from './visibility.ts';
import { softVisibility } from './visibility.ts';

/** Samples in a brick, and so texels in each of its two blocks. */
export const BRICK_TEXELS = BRICK_SAMPLES * BRICK_SAMPLES * BRICK_SAMPLES;

/** What the bake reads of a light, which a `PointLightSource` already carries. */
export interface FieldLight extends LightReach {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** The emitter's physical radius, which widens its penumbra. */
  readonly sourceRadius: number;
  /** Its own falloff exponent, overriding the frame's above zero. See `pointLightShape`. */
  readonly falloffExponent?: number;
}

/**
 * Fill `light` and `direction`, `BRICK_TEXELS * 4` floats each, x fastest, for brick `brick`.
 * `distance` is the scene's distance field, or null for no occlusion.
 */
export function bakeBrick(
  layout: LightFieldLayout,
  brick: number,
  lights: readonly FieldLight[],
  falloff: PointLightFalloff,
  distance: DistanceAt | null,
  light: Float32Array,
  direction: Float32Array,
): void {
  const { spacing, span, origin } = layout;
  const bx = origin[0] + (layout.brickCoords[brick * 3] as number) * span;
  const by = origin[1] + (layout.brickCoords[brick * 3 + 1] as number) * span;
  const bz = origin[2] + (layout.brickCoords[brick * 3 + 2] as number) * span;
  const first = layout.lightStart[brick] as number;
  const last = layout.lightStart[brick + 1] as number;

  for (let k = 0; k < BRICK_SAMPLES; k++) {
    for (let j = 0; j < BRICK_SAMPLES; j++) {
      for (let i = 0; i < BRICK_SAMPLES; i++) {
        sampleFieldLight(
          bx + i * spacing,
          by + j * spacing,
          bz + k * spacing,
          lights,
          layout.lights,
          first,
          last,
          falloff,
          distance,
          light,
          direction,
          (i + BRICK_SAMPLES * (j + BRICK_SAMPLES * k)) * 4,
        );
      }
    }
  }
}

/**
 * One sample: the light arriving at (px, py, pz) from `lights[candidates[first..last)]`, written at
 * `texel` in `light` (colour, then 1 for a sample and 0 for one inside solid geometry) and in
 * `direction` (the brightness-weighted way it arrives from). Shared by every bake, so a brick and a
 * dense volume cannot come to disagree about what a sample is.
 */
export function sampleFieldLight(
  px: number,
  py: number,
  pz: number,
  lights: readonly FieldLight[],
  candidates: ArrayLike<number>,
  first: number,
  last: number,
  falloff: PointLightFalloff,
  distance: DistanceAt | null,
  light: Float32Array,
  direction: Float32Array,
  texel: number,
): void {
  light.fill(0, texel, texel + 4);
  direction.fill(0, texel, texel + 4);
  if (distance !== null && distance(px, py, pz) < 0) return;

  let r = 0;
  let g = 0;
  let b = 0;
  let towardX = 0;
  let towardY = 0;
  let towardZ = 0;
  let weight = 0;
  for (let listed = first; listed < last; listed++) {
    const source = lights[candidates[listed] as number];
    if (source === undefined) continue;
    const dx = source.x - px;
    const dy = source.y - py;
    const dz = source.z - pz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= source.radius) continue;
    const shape = pointLightShape(dist, source.radius, falloff, source.falloffExponent);
    if (shape <= 0) continue;
    const seen =
      distance === null
        ? 1
        : softVisibility(distance, px, py, pz, source.x, source.y, source.z, source.sourceRadius);
    if (seen <= 0) continue;
    const lr = source.r * shape * seen;
    const lg = source.g * shape * seen;
    const lb = source.b * shape * seen;
    r += lr;
    g += lg;
    b += lb;
    const bright = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    if (dist > 1e-6 && bright > 0) {
      towardX += (bright * dx) / dist;
      towardY += (bright * dy) / dist;
      towardZ += (bright * dz) / dist;
      weight += bright;
    }
  }
  light[texel] = r;
  light[texel + 1] = g;
  light[texel + 2] = b;
  light[texel + 3] = 1;
  if (weight > 0) {
    direction[texel] = towardX / weight;
    direction[texel + 1] = towardY / weight;
    direction[texel + 2] = towardZ / weight;
  }
}
