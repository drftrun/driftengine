/**
 * A vertex's joint influences, sorted, cut to eight and normalised into the two sets a mesh carries.
 *
 * **Eight and not four, since 4.8.4.** A rig authored for eight — a face, a shoulder, a hand — loses
 * the shape of its deformation when the four lightest are dropped, and both importers dropped them.
 * Heaviest first is the contract the format relies on: the first set always holds the four that
 * matter most, so a renderer or an older pipeline reading only that set keeps the best four, and
 * the second set holds what is left. Shared by the glTF and FBX readers so both cut and order the
 * same way.
 *
 * **What it gives up** is anything past eight, renormalised over what is kept, as four was before.
 * Runs at import, off the frame, so it allocates where that is clearer.
 */

/** One joint and how much of a vertex it moves. */
export interface Influence {
  readonly joint: number;
  readonly weight: number;
}

/** The four arrays a mesh's influences land in, four floats per vertex each. */
export interface InfluenceSets {
  readonly joints: Float32Array;
  readonly weights: Float32Array;
  readonly joints2: Float32Array;
  readonly weights2: Float32Array;
}

/** What a vertex's influences needed: dropping past eight, rescaling, and a second set at all. */
export interface InfluenceReport {
  readonly dropped: boolean;
  readonly rescaled: boolean;
  readonly second: boolean;
}

/** The most influences a vertex keeps: two sets of four. */
export const MAX_INFLUENCES = 8;

const NONE: InfluenceReport = Object.freeze({ dropped: false, rescaled: false, second: false });

/**
 * Write vertex `at`'s influences into `out`, heaviest first: the four heaviest into `joints` and
 * `weights`, the next four into `joints2` and `weights2`, normalised to sum to one over all kept.
 * A vertex with no positive weight is left all zero and reported as nothing, because inventing an
 * influence would move geometry nobody rigged.
 */
export function writeInfluences(
  influences: readonly Influence[] | undefined,
  out: InfluenceSets,
  at: number,
): InfluenceReport {
  if (influences === undefined || influences.length === 0) return NONE;
  /* Stable, so equal weights keep the order they arrived in: set 0 before set 1. */
  const sorted = influences
    .map((influence, order) => ({ ...influence, order }))
    .filter((influence) => influence.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.order - b.order);
  const kept = sorted.slice(0, MAX_INFLUENCES);
  let sum = 0;
  for (const influence of kept) sum += influence.weight;
  if (sum <= 0) return NONE;
  for (let i = 0; i < kept.length; i++) {
    const influence = kept[i] as Influence;
    const joints = i < 4 ? out.joints : out.joints2;
    const weights = i < 4 ? out.weights : out.weights2;
    joints[at * 4 + (i % 4)] = influence.joint;
    weights[at * 4 + (i % 4)] = influence.weight / sum;
  }
  let total = 0;
  for (const influence of sorted) total += influence.weight;
  return {
    dropped: sorted.length > MAX_INFLUENCES,
    /* A tenth of a per cent, which is wider than float noise and narrower than an authoring slip. */
    rescaled: Math.abs(total - 1) > 1e-3,
    second: kept.length > 4,
  };
}
