import { expect, test } from 'vitest';

import { ProbeGrid, createProbeBlend } from '../probeGrid.ts';
import {
  PROBE_VISIBILITY_SHARPNESS,
  bakeProbeVisibility,
  createProbeVisibility,
  probeUpdateSchedule,
  probeVisibilityWeight,
  sampleProbeVolume,
  visibleProbes,
} from './probeVolume.ts';

/**
 * **What this file is for: the wall.**
 *
 * A probe volume is never wrong and only ever coarse — that is what makes it the level the chain
 * can always fall back to. The one way it *is* wrong is the one every implementation of this has
 * shipped: a point in a dark room takes a trilinear share of a probe standing in the lit room next
 * door, because nothing in the blend knows there is a wall between them. Light comes out of solid
 * walls, and no amount of resolution fixes it.
 */

/** Two probes two metres apart along x, with a wall at the midpoint. */
function pair(): ProbeGrid {
  return new ProbeGrid({ origin: [0, 0, 0], spacing: [2, 1, 1], counts: [2, 1, 1] });
}

const WALL_AT = 1;
const FAR = 50;

/** What each probe sees: a wall one metre away on the side the other probe is on. */
function seal(visibility: ReturnType<typeof createProbeVisibility>): void {
  bakeProbeVisibility(visibility, 0, (dx) => (dx > 0 ? WALL_AT : FAR));
  bakeProbeVisibility(visibility, 1, (dx) => (dx < 0 ? WALL_AT : FAR));
}

test('a volume whose probes all say the same thing says exactly that, and no more', () => {
  /*
   * **The blend must not gain or lose energy**, which is the property Task 10's white furnace
   * rests on: a solution that adds a percent a bounce passes every visual check and then blows out
   * on the tenth frame. Weights that sum to one is what makes that true, and renormalising after
   * the visibility term is what keeps it true.
   */
  const grid = pair();
  const visibility = createProbeVisibility(8, grid.layers);
  seal(visibility);
  const values = new Float32Array([0.25, 0.5, 0.75, 0.25, 0.5, 0.75]);
  const blend = createProbeBlend();
  const out = new Float32Array(3);

  for (const x of [0, 0.3, 1, 1.7, 2]) {
    visibleProbes(grid, visibility, x, 0, 0, blend);
    sampleProbeVolume(blend, values, 3, out);
    expect(out[0]).toBeCloseTo(0.25, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.75, 6);
  }
});

test('VISIBILITY STOPS LIGHT CROSSING A WALL, which is the defect this volume exists to not have', () => {
  /*
   * Probe 0 stands in a dark room, probe 1 in a lit one, and a wall runs between them. A point 50
   * centimetres into the dark room is 0.75 of the way toward probe 0 by distance alone, so a plain
   * trilinear blend hands it a quarter of the lit room — a fifth of a lux of light through a solid
   * wall, at every point along it, which reads as a glow rather than as a bug.
   */
  const grid = pair();
  const visibility = createProbeVisibility(16, grid.layers);
  seal(visibility);
  const values = new Float32Array([0, 0, 0, 1, 1, 1]);
  const blend = createProbeBlend();
  const out = new Float32Array(3);

  visibleProbes(grid, visibility, 0.5, 0, 0, blend);
  sampleProbeVolume(blend, values, 3, out);
  expect(out[0]).toBeLessThan(0.01);

  /* And the other way round, so this is the wall rather than a bias toward probe zero. */
  visibleProbes(grid, visibility, 1.5, 0, 0, blend);
  sampleProbeVolume(blend, values, 3, out);
  expect(out[0]).toBeGreaterThan(0.99);
});

test('a probe is trusted in front of what it saw and distrusted behind it', () => {
  const visibility = createProbeVisibility(16, 1);
  bakeProbeVisibility(visibility, 0, (dx) => (dx > 0 ? 2 : FAR));

  /* Nearer than the wall it recorded: fully trusted. */
  expect(probeVisibilityWeight(visibility, 0, 1, 0, 0, 1)).toBeCloseTo(1, 6);
  expect(probeVisibilityWeight(visibility, 0, 1, 0, 0, 1.9)).toBeCloseTo(1, 6);
  /* Past it: the weight falls, and it falls monotonically rather than switching. */
  const beyond = [2.2, 2.6, 3.5, 6].map((d) => probeVisibilityWeight(visibility, 0, 1, 0, 0, d));
  for (let i = 1; i < beyond.length; i++) {
    expect(beyond[i] as number).toBeLessThan(beyond[i - 1] as number);
  }
  expect(beyond[beyond.length - 1] as number).toBeLessThan(0.01);

  /* In a direction with nothing in it, distance does not matter. */
  expect(probeVisibilityWeight(visibility, 0, -1, 0, 0, 20)).toBeCloseTo(1, 6);

  /* The sharpening exponent is what turns a soft falloff into an edge that reads as a wall. */
  expect(PROBE_VISIBILITY_SHARPNESS).toBeGreaterThan(1);
});

test('A POINT OUTSIDE THE VOLUME TAKES THE NEAREST PROBE rather than extrapolating past it', () => {
  /*
   * **Extrapolation past the last probe is unbounded and the clamp is not.** An object walking out
   * of a probe volume would otherwise change what lights it, faster the further it went, on
   * geometry that did not change at all. `probeGrid.ts` already clamps, with the argument written
   * out; this asserts the visibility weighting did not undo it.
   */
  const grid = pair();
  const visibility = createProbeVisibility(8, grid.layers);
  seal(visibility);
  const values = new Float32Array([0, 0, 0, 1, 1, 1]);
  const blend = createProbeBlend();
  const out = new Float32Array(3);

  visibleProbes(grid, visibility, -40, 0, 0, blend);
  sampleProbeVolume(blend, values, 3, out);
  expect(out[0]).toBeCloseTo(0, 6);

  visibleProbes(grid, visibility, 40, 0, 0, blend);
  sampleProbeVolume(blend, values, 3, out);
  expect(out[0]).toBeCloseTo(1, 6);
});

test('a point every probe is blind to takes the nearest one rather than nothing at all', () => {
  /*
   * **A volume with no answer must still answer**, because it is the last level of the chain and
   * there is nothing behind it. A point inside a solid, or in a sealed void with a probe on every
   * side of a wall, drives every visibility weight to zero — and the sum they would be divided by
   * with them. The fallback is the nearest probe by distance, which is the coarse answer this
   * level exists to always have.
   */
  const grid = pair();
  const visibility = createProbeVisibility(8, grid.layers);
  /* Every direction blocked at ten centimetres, from both probes. */
  bakeProbeVisibility(visibility, 0, () => 0.1);
  bakeProbeVisibility(visibility, 1, () => 0.1);
  const values = new Float32Array([0.2, 0.2, 0.2, 0.8, 0.8, 0.8]);
  const blend = createProbeBlend();
  const out = new Float32Array(3);

  visibleProbes(grid, visibility, 0.4, 0, 0, blend);
  sampleProbeVolume(blend, values, 3, out);
  expect(Number.isFinite(out[0] as number)).toBe(true);
  expect(out[0]).toBeCloseTo(0.2, 6);

  let total = 0;
  for (const weight of blend.weights) total += weight;
  expect(total).toBeCloseTo(1, 6);
});

test('a volume with no visibility at all behaves exactly as the grid always has', () => {
  /*
   * The published scenes do not move, which is this wave's first global constraint. Passing `null`
   * is the whole of the off switch, and it has to land on the same arithmetic `nearestProbes`
   * was already doing rather than on a path that agrees with it by construction.
   */
  const grid = pair();
  const values = new Float32Array([0, 0, 0, 1, 1, 1]);
  const blend = createProbeBlend();
  const out = new Float32Array(3);

  visibleProbes(grid, null, 0.5, 0, 0, blend);
  sampleProbeVolume(blend, values, 3, out);
  expect(out[0]).toBeCloseTo(0.25, 6);
});

test('PROBE UPDATE IS INCREMENTAL AND BOUNDED, and every probe is reached', () => {
  /*
   * **A grid rebaked in one frame is six draws of the world per probe**, which for sixty-four
   * probes is 384 submissions in one frame and a visible hitch. `EnvProbeArray` already bakes a
   * probe at a time for exactly this reason and gates the whole grid until every layer is filled.
   * What is here is the schedule: bounded per frame, and — the part that is easy to get wrong —
   * every probe reached within a bounded number of frames rather than a random subset that leaves
   * one probe stale for ever.
   */
  const layers = 17;
  const perFrame = 5;
  const out = new Int32Array(perFrame);
  const seen = new Set<number>();
  const frames = Math.ceil(layers / perFrame);

  for (let frame = 0; frame < frames; frame++) {
    const count = probeUpdateSchedule(layers, perFrame, frame, out);
    expect(count).toBeLessThanOrEqual(perFrame);
    for (let i = 0; i < count; i++) {
      const layer = out[i] as number;
      expect(layer).toBeGreaterThanOrEqual(0);
      expect(layer).toBeLessThan(layers);
      seen.add(layer);
    }
  }
  expect(seen.size).toBe(layers);

  /*
   * **Bounded by all three of what was asked for, what exists and what fits.** A count that
   * exceeded the target array would be a promise a caller cannot see broken: `Int32Array` drops a
   * write past its end in silence, so the schedule would return a count larger than the layers it
   * actually wrote and the caller would rebake probe zero however many times over.
   */
  expect(probeUpdateSchedule(layers, 99, 0, new Int32Array(5))).toBe(5);
  /* And by the budget itself, which is the one a reused buffer larger than it would hide: a
     caller holding room for eight and asking for two this frame gets two. */
  expect(probeUpdateSchedule(layers, 2, 0, new Int32Array(8))).toBe(2);
  expect(probeUpdateSchedule(3, 10, 0, new Int32Array(10))).toBe(3);
  expect(probeUpdateSchedule(0, 4, 0, new Int32Array(4))).toBe(0);

  /* And it is a schedule rather than a shuffle: the same frame asks for the same probes. */
  const again = new Int32Array(perFrame);
  probeUpdateSchedule(layers, perFrame, 2, out);
  probeUpdateSchedule(layers, perFrame, 2, again);
  expect(Array.from(again)).toEqual(Array.from(out));
});
