import { expect, it } from 'vitest';

import { packCloth } from './clothSolvePack.ts';
import { CLOTH_SET_STATIC_FLOATS, packClothSet } from './clothSetPack.ts';
import type { SkinnedClothSetup } from '@driftengine/physics';

/** A chain of `n` hanging from a pinned particle: links coloured 0, 1, 0, 1 down it. */
function chain(n: number): SkinnedClothSetup {
  const pairs: number[] = [];
  for (let i = 0; i + 1 < n; i++) pairs.push(i, i + 1);
  return {
    positions: new Float32Array(n * 3),
    inverseMass: new Float32Array(n).fill(1).fill(0, 0, 1),
    distance: {
      pairs: new Uint32Array(pairs),
      rest: new Float32Array(n - 1).map((_, k) => k + 1),
      compliance: new Float32Array(n - 1),
    },
    parameters: {},
  };
}

/*
 * **Colour `b` of every garment is one range, and every index is the set's.** A chain of three
 * (links (0,1) colour 0, (1,2) colour 1) and a chain of four ((0,1) 0, (1,2) 1, (2,3) 0) set side by
 * side: the second's particles start at 3, so colour 0 is (0,1) of the first and (3,4), (5,6) of the
 * second, and colour 1 is (1,2) and (4,5) — five records in two ranges. Written by hand from the
 * chains, not read back through `packCloth`.
 */
it("REGROUPS EVERY GARMENT'S CONSTRAINTS BY COLOUR, ITS PARTICLES OFFSET BY WHERE IT STARTS", () => {
  const set = packClothSet([packCloth(chain(3)), packCloth(chain(4))]);
  expect(set.count).toBe(7);
  expect(Array.from(set.distanceBatches)).toEqual([0, 3, 5]);
  const floats = new Float32Array(set.constraints.buffer);
  const record = (r: number) => [
    set.constraints[r * 4],
    set.constraints[r * 4 + 1],
    floats[r * 4 + 2],
  ];
  expect([0, 1, 2, 3, 4].map(record)).toEqual([
    [0, 1, 1],
    [3, 4, 1],
    [5, 6, 3],
    [1, 2, 2],
    [4, 5, 2],
  ]);
  expect(set.garments.map((g) => [g.particleBase, g.count, g.jointBase])).toEqual([
    [0, 3, 0],
    [3, 4, 1],
  ]);
});

/*
 * **A section lies at its start times the set's count, with each garment at its base**: the inverse
 * masses of both chains end to end, the second's unrigged joint the set's joint 1 at weight 1, and
 * the last section naming each particle's garment.
 */
it("LAYS EACH SECTION END TO END, A GARMENT'S JOINTS OFFSET, AND SAYS WHOSE EACH PARTICLE IS", () => {
  const set = packClothSet([packCloth(chain(3)), packCloth(chain(4))]);
  const n = set.count;
  expect(set.statics.length).toBe(n * CLOTH_SET_STATIC_FLOATS);
  expect(Array.from(set.statics.subarray(0, n))).toEqual([0, 1, 1, 0, 1, 1, 1]);
  /* Particle 4, the second chain's second: its first influence is joint 1 at weight 1. */
  const influence = 13 * n + 4 * 16;
  expect([set.statics[influence], set.statics[influence + 4]]).toEqual([1, 1]);
  expect(Array.from(set.statics.subarray(29 * n, 30 * n))).toEqual([0, 0, 0, 1, 1, 1, 1]);
});
