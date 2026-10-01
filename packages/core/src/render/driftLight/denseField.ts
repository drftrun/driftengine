/**
 * DriftLight for a whole world: every fixed light summed into one dense grid, baked offline.
 *
 * **Dense, where the courtyard field is sparse, because a city is lit nearly everywhere.** A brick
 * earns its index and its shared faces where light is rare; street lamps reaching thirty metres
 * forty metres apart leave almost no cell dark, so the sparseness buys nothing and the shared
 * faces cost 2.4× the samples. At 8 m a sample, a two-kilometre city 128 m tall is 256 × 16 × 256
 * samples, two half-float texels each: 16 MB on the GPU, and the renderer's lookup is one filtered
 * fetch for the light and one for its direction.
 *
 * **The same sample as every other bake.** `sampleFieldLight` is shared with `bakeBrick`, so a dense
 * volume and a brick agree bit for bit wherever both have a sample. The order a sample's lights are
 * summed in does not have to match for that: the sum runs in double precision and is stored in
 * single, which the last bits of a few terms in another order do not reach.
 *
 * **Lights are bucketed first**, four samples a bucket on every axis, so a sample sums only the
 * lights whose reach touches its bucket rather than all of them: a city of ten thousand lamps is a
 * few dozen candidates a sample. Offline and allocation-free per sample; it may take seconds.
 *
 * What it gives up is resolution: at 8 m a lamp's pool is a few samples across, which is why this
 * stands in only past the exact lights, where a pool is a few dozen pixels.
 */

import type { FieldLight } from './bake.ts';
import { sampleFieldLight } from './bake.ts';
import type { PointLightFalloff } from './falloff.ts';
import type { DistanceAt } from './visibility.ts';

/** The most samples along x or z: WebGL2 promises 256 on every axis of a 3D texture. */
export const DENSE_MAX_AXIS = 256;
/** The most along y, which holds the light and then the direction: two layers in 256. */
export const DENSE_MAX_HEIGHT = 128;
/** Samples a bucket spans on each axis. */
const BUCKET = 4;

export interface DenseLightVolume {
  /** The world position of sample (0, 0, 0). */
  readonly origin: readonly [number, number, number];
  /** Metres between two samples. */
  readonly spacing: number;
  /** Samples on each axis. */
  readonly dims: readonly [number, number, number];
  /** Four floats a sample, x fastest then y then z: the colour, then 1 for a sample and 0 inside. */
  readonly light: Float32Array;
  /** Four floats a sample: the direction light arrives from, weighted by brightness, then 0. */
  readonly direction: Float32Array;
}

/**
 * Sum `lights` over the box `bounds` (min xyz, max xyz) at `spacing` metres. `distance` occludes, or
 * null for none. The first sample stands on the box's min corner.
 */
export function bakeDenseField(
  lights: readonly FieldLight[],
  falloff: PointLightFalloff,
  distance: DistanceAt | null,
  bounds: ArrayLike<number>,
  spacing: number,
): DenseLightVolume {
  if (!(spacing > 0)) throw new Error(`bakeDenseField: spacing is ${String(spacing)}`);
  const origin: [number, number, number] = [
    bounds[0] as number,
    bounds[1] as number,
    bounds[2] as number,
  ];
  const dims: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const extent = (bounds[axis + 3] as number) - (origin[axis] as number);
    dims[axis] = Math.max(1, Math.floor(extent / spacing + 1e-9) + 1);
  }
  if (dims[0] > DENSE_MAX_AXIS || dims[2] > DENSE_MAX_AXIS || dims[1] > DENSE_MAX_HEIGHT) {
    throw new Error(
      `bakeDenseField: ${dims.join(' × ')} samples, and a volume holds ${DENSE_MAX_AXIS} across, ` +
        `${DENSE_MAX_HEIGHT} up and ${DENSE_MAX_AXIS} deep; a coarser spacing fits it.`,
    );
  }

  /* Each light listed in every bucket its reach touches, in the order the scene listed them. */
  const buckets = [
    Math.ceil(dims[0] / BUCKET),
    Math.ceil(dims[1] / BUCKET),
    Math.ceil(dims[2] / BUCKET),
  ] as const;
  const bucketCount = buckets[0] * buckets[1] * buckets[2];
  const span = spacing * BUCKET;
  const range = (light: FieldLight, axis: number, out: Int32Array): boolean => {
    const at = axis === 0 ? light.x : axis === 1 ? light.y : light.z;
    const lo = Math.floor((at - light.radius - (origin[axis] as number)) / span);
    const hi = Math.floor((at + light.radius - (origin[axis] as number)) / span);
    out[axis * 2] = Math.max(0, lo);
    out[axis * 2 + 1] = Math.min((buckets[axis] as number) - 1, hi);
    return (out[axis * 2] as number) <= (out[axis * 2 + 1] as number);
  };
  const cells = new Int32Array(6);
  const start = new Uint32Array(bucketCount + 1);
  const each = (fill: (bucket: number, light: number) => void): void => {
    for (let index = 0; index < lights.length; index++) {
      const light = lights[index] as FieldLight;
      if (!(light.radius > 0)) continue;
      if (!range(light, 0, cells) || !range(light, 1, cells) || !range(light, 2, cells)) continue;
      for (let z = cells[4] as number; z <= (cells[5] as number); z++) {
        for (let y = cells[2] as number; y <= (cells[3] as number); y++) {
          for (let x = cells[0] as number; x <= (cells[1] as number); x++) {
            fill(x + buckets[0] * (y + buckets[1] * z), index);
          }
        }
      }
    }
  };
  each((bucket) => {
    start[bucket + 1] = (start[bucket + 1] as number) + 1;
  });
  for (let b = 0; b < bucketCount; b++)
    start[b + 1] = (start[b + 1] as number) + (start[b] as number);
  const listed = new Uint32Array(start[bucketCount] as number);
  const cursor = start.slice(0, bucketCount);
  each((bucket, light) => {
    listed[cursor[bucket] as number] = light;
    cursor[bucket] = (cursor[bucket] as number) + 1;
  });

  const count = dims[0] * dims[1] * dims[2];
  const light = new Float32Array(count * 4);
  const direction = new Float32Array(count * 4);
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        const bucket =
          Math.floor(i / BUCKET) +
          buckets[0] * (Math.floor(j / BUCKET) + buckets[1] * Math.floor(k / BUCKET));
        sampleFieldLight(
          origin[0] + i * spacing,
          origin[1] + j * spacing,
          origin[2] + k * spacing,
          lights,
          listed,
          start[bucket] as number,
          start[bucket + 1] as number,
          falloff,
          distance,
          light,
          direction,
          (i + dims[0] * (j + dims[1] * k)) * 4,
        );
      }
    }
  }
  return { origin, spacing, dims, light, direction };
}
