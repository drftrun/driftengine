/**
 * Four levels of detail, and every one of them conserves.
 *
 * **`§14`'s table.** A parcel far away or barely doing anything does not need sixteen shells and a
 * tick of its own; a burning log in the player's hand does. The tiers are the two axes that matter:
 * how finely the depth is resolved, and how often the chemistry runs.
 *
 * | Tier | Shells | Chemistry | Substeps |
 * |---|---|---|---|
 * | `Hero` | as declared | every tick | 32 |
 * | `Near` | 4 | every tick | 8 |
 * | `Far` | 2 | every 4th tick, 4× step | 4 |
 * | `Distant` | 1 | every 16th tick, 16× step | 2 |
 *
 * **A tier only ever reduces resolution.** `Hero` is what the substance's author asked for, and a
 * tier that invented shells would be inventing a depth profile nobody measured.
 *
 * **`Far` and `Distant` integrate the same `dt`, just less often**, with the accumulated step handed
 * over when their turn comes. That is what makes a cadence conserving for free: the same seconds are
 * integrated either way, at a coarser resolution in time.
 */

export const TIER_HERO = 0;
export const TIER_NEAR = 1;
export const TIER_FAR = 2;
export const TIER_DISTANT = 3;

export type Tier = typeof TIER_HERO | typeof TIER_NEAR | typeof TIER_FAR | typeof TIER_DISTANT;

export const TIER_COUNT = 4;

/** Shells each tier resolves to, capped by what the substance declared. */
export const TIER_SHELLS: readonly number[] = [16, 4, 2, 1];

/** Ticks between updates. A parcel skipped for three ticks is stepped with four ticks of `dt`. */
export const TIER_CADENCE: readonly number[] = [1, 1, 4, 16];

/** The most sub-steps a reaction solve will take at this tier. */
export const TIER_SUBSTEPS: readonly number[] = [32, 8, 4, 2];

/**
 * Which shells of an `n`-shell parcel make up target shell `j` of `m`, as a half-open range in
 * **fractional** shell coordinates.
 *
 * The fold is a proportional redistribution: target `j` takes `[j·n/m, (j+1)·n/m)`, splitting a
 * source shell where the ratio is not an integer. Every target ends with exactly `n/m` shells' worth
 * of mass, which is what keeps the result equal-mass — and equal mass is the invariant conduction
 * rests on, so this is not a detail.
 */
export function foldSpan(from: number, to: number, target: number): { start: number; end: number } {
  const width = from / to;
  return { start: target * width, end: (target + 1) * width };
}

/** How much of source shell `i` belongs to a target spanning `[start, end)`. 0 to 1. */
export function foldShare(i: number, start: number, end: number): number {
  const low = i > start ? i : start;
  const high = i + 1 < end ? i + 1 : end;
  return high > low ? high - low : 0;
}
