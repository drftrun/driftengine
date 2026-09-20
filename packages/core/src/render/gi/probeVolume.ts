/** The last level of the chain: a probe volume that knows where the walls are. */

import { nearestProbes } from '../probeGrid.ts';
import { octInsetDir, octInsetUv } from '../shaders/octahedral.ts';

import type { vec2, vec3 } from 'gl-matrix';
import type { Vec3 } from '../../math/color.ts';
import type { ProbeBlend, ProbeGrid } from '../probeGrid.ts';

/**
 * **A probe volume is never wrong and only ever coarse, and that is what it is for.**
 *
 * It is the level the chain falls back to when the screen could not answer and the world field
 * could not either, so it has nothing behind it and must always answer. What makes that safe is
 * that it is an interpolation between measurements rather than a trace: no ray to escape, no frame
 * to leave, no resolution to run out of. The cost is that it is smooth where the world is not.
 *
 * **The one way it *is* wrong is the wall, and every implementation of this has shipped it.**
 * `probeGrid.ts`'s blend is eight corners and three lerps — it reads the lattice and the point and
 * nothing else — so a point in a dark room takes a trilinear share of a probe standing in the lit
 * room next door. Light comes out of solid walls, and no amount of probe density fixes it: halving
 * the spacing halves the width of the glow and leaves it exactly as bright.
 *
 * That is not a defect in `probeGrid.ts`. Its header argues for a bare lattice at length and the
 * argument is about *uniform pressure* — free placement wants a position and an extent per probe
 * against a flat shader already 1.7x over WebGL2's guaranteed `MAX_FRAGMENT_UNIFORM_VECTORS`. This
 * adds the term that was missing without touching any of that: a second array beside the radiance
 * one, holding what each probe could see, and a weight computed from it.
 *
 * **Passing `null` for the visibility is the whole of the off switch**, and it lands on
 * `nearestProbes` itself rather than on a path that reproduces it — so a scene with no visibility
 * volume renders exactly the frame it rendered before this file existed.
 */

/**
 * What each probe could see, as one octahedral map of depth moments per probe.
 *
 * **Two moments and not one distance.** A single distance gives a binary answer — in front of the
 * wall or behind it — and a binary answer aliases along every edge in the scene, because the probe
 * that can see a point and the probe that cannot are adjacent. The mean and the mean of squares
 * give a *variance*, and a Chebyshev bound on that variance is a soft weight: confident where the
 * geometry is flat, uncertain where it is not, which is exactly where a hard answer would be wrong.
 * It is the same arithmetic a variance shadow map uses, for the same reason.
 *
 * Octahedral rather than a cube, matching `EnvProbeArray`: one layer a probe, no faces to seam, and
 * no sampler per probe. `octInsetUv` is the mapping, so a direction lands in the same texel here as
 * it does in the radiance map.
 */
export interface ProbeVisibility {
  /** Two floats a texel: mean distance, then mean of squares. One map a probe, layer-major. */
  readonly moments: Float32Array;
  /** Texels a side, the outer ring being the gutter `octInsetUv` insets past. */
  readonly edge: number;
  readonly layers: number;
}

/**
 * The least variance a texel is treated as having, in square metres.
 *
 * **Without it the falloff is a step**, because a probe looking at a flat wall records the same
 * distance in every direction of the cone and the variance is exactly zero — so the Chebyshev
 * bound is zero everywhere past the wall and one everywhere in front of it, and the seam between
 * them is a hard line that crawls as the probes are rebaked. Two hundredths of a square metre is
 * about fourteen centimetres of slop, which is below a probe spacing anybody would choose and
 * above the depth error of a bake.
 */
export const PROBE_VISIBILITY_VARIANCE_FLOOR = 0.02;

/**
 * How sharply the Chebyshev bound is turned into a weight.
 *
 * The bound is generous by construction — it is an inequality, not a measurement — so a probe that
 * is mostly occluded still scores a third of a fully visible one. Cubing it turns that third into
 * a twenty-seventh, which is the difference between a wall that reads as a wall and one that reads
 * as a curtain. Three is what the technique this follows uses, and it is here as a constant so the
 * next person can see it is a choice.
 */
export const PROBE_VISIBILITY_SHARPNESS = 3;

/**
 * Below this share, a probe is treated as contributing nothing at all.
 *
 * **A weight that is merely very small is not the same as zero, and the difference is the last
 * percent of the leak.** A probe on the far side of a wall scores about four ten-thousandths here;
 * kept, it puts that fraction of the lit room into the dark one, which is faint and is visible
 * because the eye reads a gradient in a dark room extremely well. Crushed, the wall is a wall.
 *
 * It is applied to the *product* of the trilinear weight and the visibility, because that is what a
 * probe actually contributes, and it is applied in `visibleProbes` rather than in
 * `probeVisibilityWeight` — the raw bound stays continuous, which is what lets it be tested as a
 * falloff rather than as a switch.
 */
export const PROBE_VISIBILITY_CRUSH = 1e-2;

export function createProbeVisibility(edge: number, layers: number): ProbeVisibility {
  const side = Math.trunc(edge);
  if (!(side >= 4)) {
    throw new Error(
      `createProbeVisibility: edge is ${String(edge)} and the minimum is 4. The outer ring is a ` +
        'gutter, so anything smaller is two real texels a side.',
    );
  }
  const count = Math.max(1, Math.trunc(layers));
  return { moments: new Float32Array(side * side * 2 * count), edge: side, layers: count };
}

/** Scratch, so neither baking nor sampling allocates. */
const UV: vec2 = [0, 0] as unknown as vec2;
const DIR: vec3 = [0, 0, 0] as unknown as vec3;
const PROBE_AT: Vec3 = [0, 0, 0];

/**
 * Fill one probe's map from what it can see.
 *
 * `distanceInDirection` is the bake: how far the geometry is from this probe along a direction.
 * Given as a callback because how that is measured is the caller's business — a `traceField` march
 * offline, a depth cube read back, or a closed form in a test.
 */
export function bakeProbeVisibility(
  visibility: ProbeVisibility,
  layer: number,
  distanceInDirection: (x: number, y: number, z: number) => number,
): void {
  const { edge, moments } = visibility;
  const base = layer * edge * edge * 2;
  for (let ty = 0; ty < edge; ty++) {
    for (let tx = 0; tx < edge; tx++) {
      octInsetDir((tx + 0.5) / edge, (ty + 0.5) / edge, edge, DIR);
      const distance = distanceInDirection(DIR[0], DIR[1], DIR[2]);
      const at = base + (tx + ty * edge) * 2;
      moments[at] = distance;
      moments[at + 1] = distance * distance;
    }
  }
}

/** The moments one probe recorded in one direction, as a two-element read. */
function momentsAt(
  visibility: ProbeVisibility,
  layer: number,
  x: number,
  y: number,
  z: number,
): { mean: number; meanSquare: number } {
  const { edge, moments } = visibility;
  octInsetUv(x, y, z, edge, UV);
  const tx = clampTexel(Math.floor(UV[0] * edge), edge);
  const ty = clampTexel(Math.floor(UV[1] * edge), edge);
  const at = layer * edge * edge * 2 + (tx + ty * edge) * 2;
  return { mean: moments[at] as number, meanSquare: moments[at + 1] as number };
}

function clampTexel(value: number, edge: number): number {
  return value < 0 ? 0 : value > edge - 1 ? edge - 1 : value;
}

/**
 * How much a probe's answer is trusted at a point this far away in this direction.
 *
 * One in front of what the probe saw; a Chebyshev bound on the depth variance behind it, cubed.
 * Continuous everywhere, which is what `visibleProbes` then crushes rather than this.
 */
export function probeVisibilityWeight(
  visibility: ProbeVisibility,
  layer: number,
  x: number,
  y: number,
  z: number,
  distanceM: number,
): number {
  const { mean, meanSquare } = momentsAt(visibility, layer, x, y, z);
  if (distanceM <= mean) return 1;
  const variance = Math.max(Math.abs(mean * mean - meanSquare), PROBE_VISIBILITY_VARIANCE_FLOOR);
  const beyond = distanceM - mean;
  const chebyshev = variance / (variance + beyond * beyond);
  return chebyshev ** PROBE_VISIBILITY_SHARPNESS;
}

/**
 * The eight probes around a point, weighted by what each of them can actually see.
 *
 * With `visibility` null this is `nearestProbes` and nothing else — see the module header for why
 * that matters. With one, each corner's trilinear weight is multiplied by its visibility, the
 * result is crushed and the eight are renormalised so they still sum to one. **Renormalising is
 * what keeps the blend from losing energy**, which is the property the white furnace in Task 10
 * rests on: a solution that quietly drops a share of its probes darkens every bounce.
 *
 * **A point every probe is blind to still gets an answer**, because this is the last level of the
 * chain and there is nothing behind it. When every weight crushes to zero — a point inside a solid,
 * or a sealed void with a probe on each side of a wall — the nearest probe by distance takes the
 * whole weight. That is the coarse answer this level exists to always have.
 */
export function visibleProbes(
  grid: ProbeGrid,
  visibility: ProbeVisibility | null,
  x: number,
  y: number,
  z: number,
  out: ProbeBlend,
): ProbeBlend {
  nearestProbes(grid, x, y, z, out);
  if (visibility === null) return out;

  let total = 0;
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let slot = 0; slot < out.layers.length; slot++) {
    const layer = out.layers[slot] as number;
    grid.positionOf(layer, PROBE_AT);
    const dx = x - PROBE_AT[0];
    const dy = y - PROBE_AT[1];
    const dz = z - PROBE_AT[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = slot;
    }
    /* A point standing exactly on a probe is seen by it, and has no direction to ask about. */
    const seen = distance > 0 ? probeVisibilityWeight(visibility, layer, dx, dy, dz, distance) : 1;
    const weight = (out.weights[slot] as number) * seen;
    const kept = weight < PROBE_VISIBILITY_CRUSH ? 0 : weight;
    out.weights[slot] = kept;
    total += kept;
  }

  if (total > 0) {
    for (let slot = 0; slot < out.weights.length; slot++) {
      out.weights[slot] = (out.weights[slot] as number) / total;
    }
    return out;
  }

  out.weights.fill(0);
  out.weights[nearest] = 1;
  return out;
}

/**
 * Blend what the probes carry, `channels` floats each, into a target the caller owns.
 *
 * Channel count rather than a fixed three, because what a probe carries is the caller's decision:
 * three for an ambient colour, nine for a spherical-harmonic band, a whole octahedral map for a
 * directional one. The blend is the same arithmetic whatever it is, and writing it once is what
 * stops two of them disagreeing about what the weights mean.
 */
export function sampleProbeVolume(
  blend: ProbeBlend,
  values: Float32Array,
  channels: number,
  out: Float32Array,
): Float32Array {
  for (let channel = 0; channel < channels; channel++) out[channel] = 0;
  for (let slot = 0; slot < blend.layers.length; slot++) {
    const weight = blend.weights[slot] as number;
    if (weight === 0) continue;
    const base = (blend.layers[slot] as number) * channels;
    for (let channel = 0; channel < channels; channel++) {
      out[channel] = (out[channel] as number) + (values[base + channel] as number) * weight;
    }
  }
  return out;
}

/**
 * Which probes to rebake on this frame.
 *
 * **A grid rebaked in one frame is six draws of the world per probe.** Sixty-four probes is 384
 * submissions in one frame and a hitch a viewer sees; `EnvProbeArray` already bakes a probe at a
 * time for that reason and gates the whole grid until every layer is filled. What is here is the
 * schedule, and the part of it that is easy to get wrong is not the bound — it is that **every
 * probe is reached**. A subset chosen by distance, or by what moved, leaves some probe stale for
 * ever, and a stale probe in a room whose light changed is a room lit by the previous scene.
 *
 * A plain round robin, so it is also reproducible: the same frame index asks for the same probes,
 * which is what the replay fingerprint needs and what makes a bug in it repeatable.
 */
export function probeUpdateSchedule(
  layers: number,
  perFrame: number,
  frameIndex: number,
  out: Int32Array,
): number {
  const count = Math.min(Math.max(0, Math.trunc(perFrame)), layers, out.length);
  if (count < 1 || layers < 1) return 0;
  const start = (((Math.trunc(frameIndex) * count) % layers) + layers) % layers;
  for (let i = 0; i < count; i++) out[i] = (start + i) % layers;
  return count;
}
