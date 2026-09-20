/**
 * Where the cloud grows and where it is thrown away: densification and pruning, as one plan.
 *
 * **A fit that only moves the Gaussians it started with cannot see detail its seeds did not.** The
 * seeds come from a sparse reconstruction — a few hundred corners — and a room has more surface
 * than that. So the busiest Gaussians are made into two: a small one is **cloned**, which puts a
 * second Gaussian where one was not enough, and a large one is **split**, which replaces a blur
 * covering several surfaces with two that can each take one. The reference implementation decides
 * between the two by the same test.
 *
 * **Busiest by rank rather than by a threshold.** The reference compares an accumulated screen-space
 * gradient against 0.0002, a number in units of that implementation's own normalisation, and a
 * number in units nobody can check is a number nobody can tune. This takes a fixed fraction of the
 * cloud — the most-moved fifth — which says the same thing scale-free: *these are the Gaussians the
 * frames keep pulling on.* What it gives up is the reference's property that a converged fit stops
 * growing on its own; the budget is what stops it here, and the pruning below is what keeps the
 * budget spent on Gaussians that are doing something.
 *
 * **Pruning is by opacity, and it happens first.** A Gaussian the fit has faded to nothing is
 * carrying a slot and contributing less light than a pixel can hold.
 */
import { exactExp, exactLog } from '@driftengine/core';

import { gather, type Family } from './adam.ts';
import { rotationFromQuaternion } from './project.ts';

/** Below this a Gaussian contributes less than a quarter of one value of an eight-bit channel. */
export const FADED = 1 / 255 / 4;

/** How much of the cloud is made into two, where there is room. */
const BUSIEST = 0.2;

/** A split halves what it divides, near enough: the reference's own divisor. */
const SPLIT_SHRINK = 1.6;

export interface RefineOptions {
  /** The most Gaussians the cloud may hold. */
  readonly budget: number;
  /** A Gaussian wider than this is split rather than cloned, in metres. */
  readonly splitAbove: number;
  readonly random: () => number;
}

/** Everything the plan rewrites, in one place. */
export interface RefineCloud {
  count: number;
  readonly families: readonly Family[];
  readonly positions: Family;
  readonly logScales: Family;
  readonly rotations: Family;
  readonly opacities: Float64Array;
  /** How hard the frames have pulled on each Gaussian since the last refinement. */
  readonly motion: Float64Array;
  readonly sources: Int32Array;
  /** Where each of today's Gaussians ended up after a prune, so a split can find its own half. */
  readonly reverse: Int32Array;
  readonly fresh: Uint8Array;
  readonly scratch: Float64Array;
}

/**
 * Prune, then grow, then rewrite every family; answers the new count.
 *
 * The cloud's own arrays are rewritten in place through its scratch, so nothing is reallocated and
 * the caller's view of it stays valid. **The materialised scales and opacities are not**: a slot
 * that has just been split holds the logarithm it was given and the metres of whatever stood there
 * before, so the caller materialises again before drawing. The fit does that at the top of every
 * step, which is why this does not do it twice.
 */
export function refineCloud(cloud: RefineCloud, options: RefineOptions): number {
  const { budget, splitAbove, random } = options;
  const { sources, fresh, motion } = cloud;

  /* Everything still worth drawing, in order, with its history intact. */
  const { reverse } = cloud;
  let kept = 0;
  for (let at = 0; at < cloud.count; at += 1) {
    reverse[at] = -1;
    if ((cloud.opacities[at] as number) < FADED) continue;
    reverse[at] = kept;
    sources[kept] = at;
    fresh[kept] = 0;
    kept += 1;
  }
  /* A prune that emptied the cloud would leave the fit nothing to descend, so it is refused. */
  if (kept === 0) return cloud.count;

  /* The busiest fifth of what is left, most-pulled first, as far as the budget allows. */
  const order = Array.from({ length: kept }, (_, slot) => slot);
  order.sort((a, b) => {
    const first = motion[sources[a] as number] as number;
    const second = motion[sources[b] as number] as number;
    return first === second ? (sources[a] as number) - (sources[b] as number) : second - first;
  });
  /*
   * At least one where there is room and something is pulling, because a fifth of a small cloud
   * rounds to none — and a cloud of four that can never grow however long it is fitted is a cliff
   * nobody would look for.
   */
  const room = budget - kept;
  const share = Math.floor(kept * BUSIEST);
  const wanted = Math.min(room, share > 1 ? share : 1);
  let total = kept;
  const rotation = new Float64Array(9);
  for (let taken = 0; taken < wanted; taken += 1) {
    const slot = order[taken] as number;
    const from = sources[slot] as number;
    if (!((motion[from] as number) > 0)) break;
    sources[total] = from;
    fresh[total] = 1;
    total += 1;
  }

  gather(cloud.families, sources, fresh, total, cloud.scratch);

  /*
   * Now the two halves are told apart. A clone is left where it was — its own gradient is what
   * separates it, and its Adam state is empty where its parent's is not. A split is shrunk and both
   * halves are moved, because two Gaussians of the parent's size in the parent's place are one
   * blur drawn twice.
   */
  for (let slot = kept; slot < total; slot += 1) {
    const parent = sources[slot] as number;
    let widest = 0;
    for (let c = 0; c < 3; c += 1) {
      const scale = exactExp(cloud.logScales.values[slot * 3 + c] as number);
      widest = scale > widest ? scale : widest;
    }
    if (widest <= splitAbove) continue;
    rotationFromQuaternion(cloud.rotations.values, slot, rotation);
    shrinkAndDisplace(cloud, slot, rotation, random);
    shrinkAndDisplace(cloud, reverse[parent] as number, rotation, random);
  }
  cloud.count = total;
  motion.fill(0);
  return total;
}

/** One half of a split: smaller than what it came from, and somewhere inside it. */
function shrinkAndDisplace(
  cloud: RefineCloud,
  slot: number,
  rotation: Float64Array,
  random: () => number,
): void {
  if (slot < 0) return;
  displace(cloud, slot, rotation, random);
  for (let c = 0; c < 3; c += 1) {
    cloud.logScales.values[slot * 3 + c] =
      (cloud.logScales.values[slot * 3 + c] as number) - exactLog(SPLIT_SHRINK);
  }
}

/** One sample from a Gaussian's own shape, added to where it stands. */
function displace(
  cloud: RefineCloud,
  slot: number,
  rotation: Float64Array,
  random: () => number,
): void {
  /*
   * A sum of three uniforms either side of zero rather than a normal deviate: the fit only needs
   * two halves to land somewhere inside the shape they came from, and a Box–Muller transform would
   * want a logarithm and a cosine for no gain the picture can show.
   */
  const local = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const spread = random() + random() + random() - 1.5;
    local[c] = spread * exactExp(cloud.logScales.values[slot * 3 + c] as number);
  }
  for (let r = 0; r < 3; r += 1) {
    let sum = 0;
    for (let c = 0; c < 3; c += 1) sum += (rotation[r * 3 + c] as number) * (local[c] as number);
    cloud.positions.values[slot * 3 + r] = (cloud.positions.values[slot * 3 + r] as number) + sum;
  }
}
