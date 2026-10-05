/**
 * A skinned cloth's set-up as the buffers `shaders/clothSolve.wgsl.ts` reads: per-particle
 * statics in sections, and every constraint as a record sorted by batch.
 *
 * **Sorted by batch so a batch is a range**: a dispatch runs records `begin` to `end`, and a
 * multiplier sits at its record's index. The batches are `batchesOf`'s — the set-up's own where it
 * gives them, coloured otherwise — the same ones the CPU solver walks, so the two solve each batch
 * in the same order.
 *
 * **What a device cannot be handed is said another way here.** An infinite max distance is −1, an
 * infinite stop distance is a stop of radius 0: shader compilers may assume no infinity, and a
 * comparison against one is then whatever the optimiser made of it. Tethers are coloured too, with
 * every particle counted as movable, so two tethers on one particle never run in one dispatch —
 * which keeps the CPU's order for that particle while the rest run at once.
 *
 * A cloth with no rig is skinned by its model matrix alone: one joint, weight 1, whose matrix the
 * solver uploads as the model.
 */
import { batchesOf } from '@driftengine/physics';
import type { ClothBatches, SkinnedClothSetup } from '@driftengine/physics';

/** Floats of statics a particle, across its sections. */
export const CLOTH_STATIC_FLOATS = 29;

/** Bit flags of the limits a set-up has: a max distance, a backstop, a frontstop. */
export const CLOTH_LIMIT_MAX = 1;
export const CLOTH_LIMIT_BACK = 2;
export const CLOTH_LIMIT_FRONT = 4;

export interface PackedCloth {
  readonly count: number;
  /** inverse mass, max distance, backstop ×2, frontstop ×2, thickness, rest ×3, normal ×3, influences ×16. */
  readonly statics: Float32Array;
  /** Distance records (a, b, rest, compliance), bending (four ids, rest, compliance), tethers (particle, anchor, length). */
  readonly constraints: Uint32Array;
  readonly distances: number;
  readonly bendings: number;
  readonly tethers: number;
  /** Each kind's batches as offsets into its sorted records: batch b is `[b]` up to `[b + 1]`. */
  readonly distanceBatches: Uint32Array;
  readonly bendingBatches: Uint32Array;
  readonly tetherBatches: Uint32Array;
  readonly limits: number;
  /** Skin matrices the solver uploads a pose: the rig's joints, or one for the model alone. */
  readonly joints: number;
  readonly rigged: boolean;
  readonly colliders: number;
}

/** Whether a set-up is skinned by a rig, as `ClothTargets` decides it. */
function riggedOf(setup: SkinnedClothSetup): boolean {
  return (
    setup.joints !== undefined &&
    setup.weights !== undefined &&
    (setup.inverseBind?.length ?? 0) >= 16
  );
}

export function packCloth(setup: SkinnedClothSetup): PackedCloth {
  const n = setup.positions.length / 3;
  const inverseMass = setup.inverseMass;
  const limits = setup.limits ?? {};
  const statics = new Float32Array(n * CLOTH_STATIC_FLOATS);
  statics.set(inverseMass, 0);
  const rigged = riggedOf(setup);
  for (let i = 0; i < n; i++) {
    const max = limits.maxDistance?.[i] ?? Infinity;
    statics[n + i] = max < Infinity ? max : -1;
    for (const [stops, at] of [
      [limits.backstop, 2 * n],
      [limits.frontstop, 4 * n],
    ] as const) {
      const distance = stops?.[i * 2] ?? Infinity;
      const radius = stops?.[i * 2 + 1] ?? 0;
      const real = distance < Infinity && radius > 0;
      statics[at + i * 2] = real ? distance : 0;
      statics[at + i * 2 + 1] = real ? radius : 0;
    }
    statics[6 * n + i] = limits.thickness?.[i] ?? 0;
    for (let k = 0; k < 3; k++) {
      statics[7 * n + i * 3 + k] = setup.positions[i * 3 + k] as number;
      statics[10 * n + i * 3 + k] = setup.normals?.[i * 3 + k] ?? (k === 2 ? 1 : 0);
    }
    const at = 13 * n + i * 16;
    if (!rigged) {
      statics[at + 4] = 1;
      continue;
    }
    for (let k = 0; k < 4; k++) {
      statics[at + k] = setup.joints?.[i * 4 + k] ?? 0;
      statics[at + 4 + k] = setup.weights?.[i * 4 + k] ?? 0;
      statics[at + 8 + k] = setup.joints2?.[i * 4 + k] ?? 0;
      statics[at + 12 + k] = setup.weights2?.[i * 4 + k] ?? 0;
    }
  }

  const { distance, bending, tethers } = setup;
  const distances = distance.rest.length;
  const bendings = bending?.rest.length ?? 0;
  const tetherCount = tethers?.lengths.length ?? 0;
  const words = new Uint32Array(distances * 4 + bendings * 6 + tetherCount * 3);
  const floats = new Float32Array(words.buffer);

  const distanceBatches = batchesOf('distance', distance.pairs, 2, inverseMass, distance.batches);
  sorted(distanceBatches, (k, r) => {
    const at = r * 4;
    words[at] = distance.pairs[k * 2] as number;
    words[at + 1] = distance.pairs[k * 2 + 1] as number;
    floats[at + 2] = distance.rest[k] as number;
    floats[at + 3] = distance.compliance[k] as number;
  });

  let bendingBatches: Uint32Array = new Uint32Array([0]);
  if (bending !== undefined) {
    const batches = batchesOf('bending', bending.quads, 4, inverseMass, bending.batches);
    bendingBatches = batches.batches;
    sorted(batches, (k, r) => {
      const at = distances * 4 + r * 6;
      for (let j = 0; j < 4; j++) words[at + j] = bending.quads[k * 4 + j] as number;
      floats[at + 4] = bending.rest[k] as number;
      floats[at + 5] = bending.compliance[k] as number;
    });
  }

  let tetherBatches: Uint32Array = new Uint32Array([0]);
  if (tethers !== undefined) {
    const movable = new Float32Array(n).fill(1);
    const batches = batchesOf('tethers', tethers.particles, 1, movable, undefined);
    tetherBatches = batches.batches;
    sorted(batches, (k, r) => {
      const at = distances * 4 + bendings * 6 + r * 3;
      words[at] = tethers.particles[k] as number;
      words[at + 1] = tethers.anchors[k] as number;
      floats[at + 2] = tethers.lengths[k] as number;
    });
  }

  return {
    count: n,
    statics,
    constraints: words,
    distances,
    bendings,
    tethers: tetherCount,
    distanceBatches: distanceBatches.batches,
    bendingBatches,
    tetherBatches,
    limits:
      (limits.maxDistance !== undefined ? CLOTH_LIMIT_MAX : 0) |
      (limits.backstop !== undefined ? CLOTH_LIMIT_BACK : 0) |
      (limits.frontstop !== undefined ? CLOTH_LIMIT_FRONT : 0),
    joints: rigged ? (setup.inverseBind?.length ?? 0) / 16 : 1,
    rigged,
    colliders: setup.colliders?.length ?? 0,
  };
}

/** Each constraint `k` with the place `r` it takes in batch order. */
function sorted(batches: ClothBatches, write: (k: number, r: number) => void): void {
  for (let r = 0; r < batches.order.length; r++) write(batches.order[r] as number, r);
}
