/**
 * The city's lights as the runtime takes them: every light listed in `LITE` for the exact ones it
 * selects near the eye, and all of them summed into one dense `LVOL` for everything past them,
 * occluded by the buildings.
 *
 * **The buildings occlude as the boxes their coarse level stands as** — a signed distance field,
 * negative inside, bucketed on a grid so a lookup reads the boxes near it and not the city's. Its
 * answer is capped at the grid's reach, which a sphere trace takes as a shorter step, never a
 * wrong one: every box within the cap of a point is in that point's bucket. What occludes nothing:
 * trees, furniture, and whatever a building's box leaves out.
 *
 * **The numbers are the reference's own.** A light's intensity is summed as it came, times
 * `LIGHT_UNIT`, which the runtime's exact lights must use too, or the two disagree where they
 * crossfade. The bake does not decide how bright a unit draws.
 */
import { DENSE_MAX_AXIS, bakeDenseField } from '@driftengine/core';
import type { FieldLight } from '@driftengine/core';
import type { DrftLight, DrftLightVolume } from '@driftengine/drft';

import { encodePng } from '../../../../packages/core/scripts/png.mjs';

import type { CityLight } from '../mesh/lights.ts';

/** What one of the reference's intensity units is summed as. The runtime's lights take the same. */
export const LIGHT_UNIT = 1;
/** A lamp's bulb, whose size softens the shadows it throws. */
const BULB_RADIUS = 0.2;

/** A box standing on the ground, turned by `yaw` about its centre (x, z). */
export interface Solid {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly w: number;
  readonly d: number;
  readonly bottom: number;
  readonly top: number;
}

/** The signed distance to the nearest of `solids`, never answering more than `reach`. */
export function boxField(
  solids: readonly Solid[],
  reach: number,
): (x: number, y: number, z: number) => number {
  const buckets = new Map<string, number[]>();
  const key = (i: number, j: number): string => `${i},${j}`;
  solids.forEach((s, index) => {
    /* Its footprint's box in the world, widened by the reach: every point that could be nearer. */
    const [c, sn] = [Math.abs(Math.cos(s.yaw)), Math.abs(Math.sin(s.yaw))];
    const hx = (c * s.w + sn * s.d) / 2 + reach;
    const hz = (sn * s.w + c * s.d) / 2 + reach;
    for (let i = Math.floor((s.x - hx) / reach); i <= Math.floor((s.x + hx) / reach); i++) {
      for (let j = Math.floor((s.z - hz) / reach); j <= Math.floor((s.z + hz) / reach); j++) {
        const list = buckets.get(key(i, j)) ?? [];
        list.push(index);
        buckets.set(key(i, j), list);
      }
    }
  });
  return (x, y, z) => {
    let best = reach;
    for (const index of buckets.get(key(Math.floor(x / reach), Math.floor(z / reach))) ?? []) {
      best = Math.min(best, boxDistance(solids[index] as Solid, x, y, z));
    }
    return best;
  };
}

function boxDistance(s: Solid, x: number, y: number, z: number): number {
  const [c, sn] = [Math.cos(s.yaw), Math.sin(s.yaw)];
  const [dx, dz] = [x - s.x, z - s.z];
  /* Into the box's frame: its own x is (cos, −sin) in the world, its z (sin, cos). */
  const qx = Math.abs(c * dx - sn * dz) - s.w / 2;
  const qy = Math.abs(y - (s.bottom + s.top) / 2) - (s.top - s.bottom) / 2;
  const qz = Math.abs(sn * dx + c * dz) - s.d / 2;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0);
}

/** Every light summed over the box `bounds` at `spacing` metres, occluded by `solids`. */
export function cityLightVolume(
  lights: readonly CityLight[],
  solids: readonly Solid[],
  bounds: ArrayLike<number>,
  spacing: number,
): DrftLightVolume {
  const field: FieldLight[] = lights.map((l) => ({
    x: l.position[0],
    y: l.position[1],
    z: l.position[2],
    radius: l.range,
    r: l.color[0] * l.intensity * LIGHT_UNIT,
    g: l.color[1] * l.intensity * LIGHT_UNIT,
    b: l.color[2] * l.intensity * LIGHT_UNIT,
    sourceRadius: BULB_RADIUS,
  }));
  const distance = solids.length === 0 ? null : boxField(solids, 16);
  return bakeDenseField(field, 'smooth', distance, bounds, spacing);
}

/**
 * Where the city's volume starts and stops: its first layer at a walker's waist, where the street is
 * lit and a building's ground floor is already inside it — at the ground itself a sample lies on a
 * box's base and counts as outside — and its last past the tallest roofs, where the lamps' light
 * has gone.
 */
const VOLUME_BOTTOM = 1.5;
const VOLUME_TOP = 128;

/**
 * The city's volume: every light over the regions' ground from waist height to `VOLUME_TOP`, at the
 * finest spacing that keeps the volume inside what a backend holds across.
 */
export function cityVolume(
  lights: readonly CityLight[],
  solids: readonly Solid[],
  regions: readonly { readonly bounds: ArrayLike<number> }[],
): DrftLightVolume {
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { bounds } of regions) {
    x0 = Math.min(x0, bounds[0] as number);
    z0 = Math.min(z0, bounds[2] as number);
    x1 = Math.max(x1, bounds[3] as number);
    z1 = Math.max(z1, bounds[5] as number);
  }
  const spacing = Math.ceil((Math.max(x1 - x0, z1 - z0) / (DENSE_MAX_AXIS - 1)) * 4) / 4;
  return cityLightVolume(lights, solids, [x0, VOLUME_BOTTOM, z0, x1, VOLUME_TOP, z1], spacing);
}

/** The lights as the container lists them: points, named for when they shine. */
export function liteOf(lights: readonly CityLight[]): DrftLight[] {
  return lights.map((l) => ({
    kind: 'point',
    name: l.night ? 'night' : 'always',
    position: l.position,
    direction: [0, -1, 0],
    color: l.color,
    intensity: l.intensity,
    range: l.range,
    innerConeRad: 0,
    outerConeRad: 0,
  }));
}

/**
 * One layer of a volume as a picture, north up: light tone-mapped by `x / (1 + x)`, solid black.
 * An instrument, for looking at a bake: which streets are lit, and whether buildings are solid.
 */
export function plotVolume(volume: DrftLightVolume, layer: number): Buffer {
  const [nx, , nz] = volume.dims;
  const rgba = new Uint8Array(nx * nz * 4);
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const at = ((z * volume.dims[1] + layer) * nx + x) * 4;
      const out = (z * nx + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = volume.light[at + c] as number;
        rgba[out + c] = Math.round((255 * v) / (1 + v));
      }
      rgba[out + 3] = 255;
    }
  }
  return encodePng(nx, nz, rgba);
}
