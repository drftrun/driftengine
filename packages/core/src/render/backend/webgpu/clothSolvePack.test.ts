import { expect, it } from 'vitest';

import { CLOTH_LIMIT_BACK, CLOTH_LIMIT_MAX, packCloth } from './clothSolvePack.ts';
import type { SkinnedClothSetup } from '@driftengine/physics';

/*
 * Five particles, the first pinned. Links (1,2), (0,1), (3,4) colour 0, 1, 0 — (0,1) shares
 * particle 1 with the first, and the pinned 0 is shared freely — so batch order puts (3,4) second.
 * Tethers on particles 2, 2 and 3 colour 0, 1, 0 for the same reason, counting every particle as
 * movable: the two on particle 2 never run in one dispatch.
 */
function setup(): SkinnedClothSetup {
  return {
    positions: new Float32Array(15),
    inverseMass: new Float32Array([0, 1, 1, 1, 1]),
    distance: {
      pairs: new Uint32Array([1, 2, 0, 1, 3, 4]),
      rest: new Float32Array([0.5, 0.25, 0.75]),
      compliance: new Float32Array([0, 0.125, 0]),
    },
    tethers: {
      particles: new Uint32Array([2, 2, 3]),
      anchors: new Uint32Array([0, 0, 0]),
      lengths: new Float32Array([1, 2, 3]),
    },
    limits: {
      maxDistance: new Float32Array([0, Infinity, 0.25, Infinity, 1]),
      backstop: new Float32Array([0, 0, Infinity, 0.5, 0.125, 0.5, 0, 0, 0, 0]),
    },
    parameters: {},
  };
}

it('SORTS EVERY CONSTRAINT BY ITS BATCH, SO A BATCH IS A RANGE OF RECORDS', () => {
  const packed = packCloth(setup());
  const floats = new Float32Array(packed.constraints.buffer);
  expect(Array.from(packed.distanceBatches)).toEqual([0, 2, 3]);
  const distance = (r: number) => [
    packed.constraints[r * 4],
    packed.constraints[r * 4 + 1],
    floats[r * 4 + 2],
    floats[r * 4 + 3],
  ];
  expect([0, 1, 2].map(distance)).toEqual([
    [1, 2, 0.5, 0],
    [3, 4, 0.75, 0],
    [0, 1, 0.25, 0.125],
  ]);
  expect(Array.from(packed.tetherBatches)).toEqual([0, 2, 3]);
  const tether = (r: number) => [
    packed.constraints[12 + r * 3],
    packed.constraints[12 + r * 3 + 1],
    floats[12 + r * 3 + 2],
  ];
  expect([0, 1, 2].map(tether)).toEqual([
    [2, 0, 1],
    [3, 0, 3],
    [2, 0, 2],
  ]);
});

/* An infinity reaches no device: no max distance is −1, a stop at an infinite distance is none. */
it('says "none" to a device without an infinity', () => {
  const packed = packCloth(setup());
  const n = 5;
  expect(Array.from(packed.statics.subarray(n, 2 * n))).toEqual([0, -1, 0.25, -1, 1]);
  expect(Array.from(packed.statics.subarray(2 * n, 4 * n))).toEqual([
    0, 0, 0, 0, 0.125, 0.5, 0, 0, 0, 0,
  ]);
  expect(packed.limits).toBe(CLOTH_LIMIT_MAX | CLOTH_LIMIT_BACK);
});

/* With no rig, one joint — the model — at full weight, and a rest normal of +Z where none is given. */
it('skins a cloth with no rig by its model alone', () => {
  const packed = packCloth(setup());
  const n = 5;
  expect(packed.rigged).toBe(false);
  expect(packed.joints).toBe(1);
  expect(Array.from(packed.statics.subarray(13 * n, 13 * n + 8))).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  expect(Array.from(packed.statics.subarray(10 * n, 10 * n + 3))).toEqual([0, 0, 1]);
});
