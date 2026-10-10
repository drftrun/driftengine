/**
 * What a set of garments writes once into the buffers its rounds read, and the one per-step number
 * worked out on the CPU: the constants, each round slot's first record, each colour's and each
 * garment's batch slot, and the carry a step hands a garment that keeps less than all of its
 * character's motion. Plain functions over the packed set, apart from the solver that schedules.
 */
import type { ResolvedClothParameters } from '@driftengine/physics';

import type { PackedClothSet } from './clothSetPack.ts';
import { DYNAMIC_ALIGNMENT } from './uniformRing.ts';

/** Bytes of the shader's `Constants`. */
export const CLOTH_CONSTANT_BYTES = 48;

/** The set's `Constants`: its totals, and the substep length every garment of it shares. */
export function clothConstants(packed: PackedClothSet, h: number): ArrayBuffer {
  const bytes = new ArrayBuffer(CLOTH_CONSTANT_BYTES);
  const u = new Uint32Array(bytes);
  const f = new Float32Array(bytes);
  u[0] = packed.count;
  u[1] = packed.distances;
  u[2] = packed.bendings;
  u[3] = packed.joints;
  u[4] = packed.colliders;
  f[8] = h;
  f[9] = 1 / h;
  f[10] = 1 / (h * h);
  return bytes;
}

/** Each of `rounds` round slots' first record: the round's index times the garments. */
export function clothRoundOffsets(rounds: number, garments: number): Uint32Array<ArrayBuffer> {
  const words = new Uint32Array((rounds * DYNAMIC_ALIGNMENT) / 4);
  for (let r = 0; r < rounds; r++) words[(r * DYNAMIC_ALIGNMENT) / 4] = r * garments;
  return words;
}

/**
 * Each colour's range, twice — opening a substep's iterations and not — at a slot each, kind by
 * kind; then one slot a garment for publishing, its particles' range and its index.
 */
export function clothBatchSlots(packed: PackedClothSet): Uint32Array<ArrayBuffer> {
  const { distanceBatches, bendingBatches, tetherBatches, garments } = packed;
  const kinds = [distanceBatches, bendingBatches, tetherBatches];
  let slots = garments.length;
  for (const batches of kinds) slots += (batches.length - 1) * 2;
  const words = new Uint32Array((slots * DYNAMIC_ALIGNMENT) / 4);
  let slot = 0;
  for (const batches of kinds) {
    for (let b = 0; b + 1 < batches.length; b++) {
      for (let first = 0; first < 2; first++) {
        const at = (slot * DYNAMIC_ALIGNMENT) / 4;
        words[at] = batches[b] as number;
        words[at + 1] = batches[b + 1] as number;
        words[at + 2] = first;
        slot++;
      }
    }
  }
  garments.forEach((range, g) => {
    const at = (slot * DYNAMIC_ALIGNMENT) / 4;
    words[at] = range.particleBase;
    words[at + 1] = range.particleBase + range.count;
    words[at + 2] = g;
    slot++;
  });
  return words;
}

/**
 * `carryParticles`' rotation, origin and move, into a record's head at `at`, between the model
 * matrices before and after the step; nothing where the garment keeps all of its character's
 * motion, which leaves the head's carry at 0.
 */
export function writeClothCarry(
  parameters: ResolvedClothParameters,
  previous: Float32Array,
  next: Float32Array,
  words: Uint32Array,
  f: Float32Array,
  at: number,
): void {
  const turn = 1 - parameters.angularInertia;
  const move = 1 - parameters.linearInertia;
  if (turn === 0 && move === 0) return;
  words[at + 3] = 1;
  /* Column c of R = R_next × R_previousᵀ, at turn0 … turn2. */
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += (next[k * 4 + row] as number) * (previous[k * 4 + col] as number);
      }
      f[at + 8 + col * 4 + row] = sum;
    }
  }
  for (let k = 0; k < 3; k++) {
    f[at + 20 + k] = previous[12 + k] as number;
    f[at + 24 + k] = ((next[12 + k] as number) - (previous[12 + k] as number)) * move;
  }
  f[at + 23] = turn;
}
