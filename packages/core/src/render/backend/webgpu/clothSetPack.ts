/**
 * Several garments' packs as one set of buffers, so that one dispatch solves a colour of one kind of
 * constraint for every garment at once: `packCloth`'s sections laid end to end, and each kind's
 * records regrouped so a colour of all of them is one range.
 *
 * **Why regrouping by colour keeps each garment's solve.** A batch is a set of constraints that share
 * no movable particle, and two garments share no particle at all, so colour `b` of every garment is
 * still such a set. Each garment's own colours still run in its own order, 0 then 1 then 2, so it is
 * solved exactly as it would be alone: the CPU solver, which steps garments one at a time, is the
 * reference for every one of them.
 *
 * **Every index a record or a static holds is the set's**: a particle is offset by where its garment
 * starts, a joint by where its garment's skin matrices start. A section `packCloth` lays at `s · n`
 * lies at `s · N` here, with a garment's particles at its base inside it, and one more section says
 * which garment each particle is — what a kernel reads its garment's numbers by.
 *
 * **What it gives up**: a colour is dispatched over the most records any garment has in it, so a set
 * of one garment of nine colours and fourteen of three runs nine colours' dispatches for all of them;
 * and a garment joins a set when the set is made, so changing one rebuilds the set.
 */
import { CLOTH_STATIC_FLOATS } from './clothSolvePack.ts';
import type { PackedCloth } from './clothSolvePack.ts';

/** Floats of statics a particle in a set: a garment's own, and which garment it is. */
export const CLOTH_SET_STATIC_FLOATS = CLOTH_STATIC_FLOATS + 1;

/** `packCloth`'s sections: where each starts, in particle counts, and its floats a particle. */
const SECTIONS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [2, 2],
  [4, 2],
  [6, 1],
  [7, 3],
  [10, 3],
  [13, 16],
];
/** Where the influences start, and where the garment's index sits, in particle counts. */
const INFLUENCES = 13;
const GARMENT = CLOTH_STATIC_FLOATS;

/** Where one garment sits in a set. */
export interface ClothGarmentRange {
  readonly particleBase: number;
  readonly count: number;
  readonly jointBase: number;
  readonly joints: number;
  readonly colliderBase: number;
  readonly colliders: number;
  /** `packCloth`'s limit flags, the garment's own. */
  readonly limits: number;
  readonly rigged: boolean;
}

export interface PackedClothSet {
  /** Particles across every garment. */
  readonly count: number;
  readonly statics: Float32Array;
  readonly constraints: Uint32Array;
  readonly distances: number;
  readonly bendings: number;
  readonly tethers: number;
  /** Each kind's colours across the set: colour `b` of every garment is `[b]` up to `[b + 1]`. */
  readonly distanceBatches: Uint32Array;
  readonly bendingBatches: Uint32Array;
  readonly tetherBatches: Uint32Array;
  /** Skin matrices and colliders across every garment. */
  readonly joints: number;
  readonly colliders: number;
  readonly garments: readonly ClothGarmentRange[];
}

export function packClothSet(packs: readonly PackedCloth[]): PackedClothSet {
  const garments: ClothGarmentRange[] = [];
  let count = 0;
  let joints = 0;
  let colliders = 0;
  for (const pack of packs) {
    garments.push({
      particleBase: count,
      count: pack.count,
      jointBase: joints,
      joints: pack.joints,
      colliderBase: colliders,
      colliders: pack.colliders,
      limits: pack.limits,
      rigged: pack.rigged,
    });
    count += pack.count;
    joints += pack.joints;
    colliders += pack.colliders;
  }

  const statics = new Float32Array(count * CLOTH_SET_STATIC_FLOATS);
  packs.forEach((pack, g) => {
    const { particleBase: base, count: n, jointBase } = garments[g] as ClothGarmentRange;
    for (const [start, stride] of SECTIONS) {
      const from = pack.statics.subarray(start * n, (start + stride) * n);
      statics.set(from, start * count + base * stride);
    }
    /* Each influence's joint, the set's: four joints, four weights, four joints, four weights. */
    for (let i = 0; i < n; i++) {
      const at = INFLUENCES * count + (base + i) * 16;
      for (let k = 0; k < 4; k++) {
        statics[at + k] = (statics[at + k] as number) + jointBase;
        statics[at + 8 + k] = (statics[at + 8 + k] as number) + jointBase;
      }
    }
    statics.fill(g, GARMENT * count + base, GARMENT * count + base + n);
  });

  const distances = sum(packs, (pack) => pack.distances);
  const bendings = sum(packs, (pack) => pack.bendings);
  const tethers = sum(packs, (pack) => pack.tethers);
  const constraints = new Uint32Array(distances * 4 + bendings * 6 + tethers * 3);
  /* Each kind: where its records start, a record's words, how many of them are particles. */
  const distanceBatches = regroup(packs, garments, constraints, 0, 4, 2, 'distanceBatches');
  const bendingStart = distances * 4;
  const bendingBatches = regroup(
    packs,
    garments,
    constraints,
    bendingStart,
    6,
    4,
    'bendingBatches',
  );
  const tetherStart = bendingStart + bendings * 6;
  const tetherBatches = regroup(packs, garments, constraints, tetherStart, 3, 2, 'tetherBatches');
  return {
    count,
    statics,
    constraints,
    distances,
    bendings,
    tethers,
    distanceBatches,
    bendingBatches,
    tetherBatches,
    joints,
    colliders,
    garments,
  };
}

function sum(packs: readonly PackedCloth[], of: (pack: PackedCloth) => number): number {
  let total = 0;
  for (const pack of packs) total += of(pack);
  return total;
}

/** Where one kind's records start in a garment's own pack, in words. */
function kindStart(pack: PackedCloth, kind: BatchKind): number {
  if (kind === 'distanceBatches') return 0;
  if (kind === 'bendingBatches') return pack.distances * 4;
  return pack.distances * 4 + pack.bendings * 6;
}

type BatchKind = 'distanceBatches' | 'bendingBatches' | 'tetherBatches';

/**
 * One kind's records, colour by colour and within a colour garment by garment, into `out` from
 * `start`; each record's first `ids` words offset by its garment's first particle. The set's colours.
 */
function regroup(
  packs: readonly PackedCloth[],
  garments: readonly ClothGarmentRange[],
  out: Uint32Array,
  start: number,
  words: number,
  ids: number,
  kind: BatchKind,
): Uint32Array {
  let colours = 0;
  for (const pack of packs) colours = Math.max(colours, pack[kind].length - 1);
  const batches = new Uint32Array(colours + 1);
  let record = 0;
  for (let b = 0; b < colours; b++) {
    packs.forEach((pack, g) => {
      const own = pack[kind];
      if (b + 1 >= own.length) return;
      const base = (garments[g] as ClothGarmentRange).particleBase;
      const from = kindStart(pack, kind);
      for (let r = own[b] as number; r < (own[b + 1] as number); r++) {
        const src = from + r * words;
        const dst = start + record * words;
        for (let w = 0; w < words; w++) {
          const word = pack.constraints[src + w] as number;
          out[dst + w] = w < ids ? word + base : word;
        }
        record++;
      }
    });
    batches[b + 1] = record;
  }
  return batches;
}
