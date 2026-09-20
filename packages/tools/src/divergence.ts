/**
 * Which of two sets of component hashes disagree.
 *
 * **Here rather than beside the divergence search, because a shipped game gets this half.** The
 * search walks a timeline, which only the editor has; comparing what two peers hashed is what an
 * in-game network panel does the moment a rollback session desynchronises, and that is a panel a
 * game carries. `editor/src/pie/divergence.ts` holds the search and imports these.
 */
/**
 * Which components two sides hash differently, into `out`. Returns how many.
 *
 * A component only one side has is a divergence too, and the loudest kind: it means one peer
 * created or destroyed something the other did not.
 */
export function divergentComponents(
  ours: ReadonlyMap<string, string>,
  theirs: ReadonlyMap<string, string>,
  out: string[],
): number {
  out.length = 0;
  for (const [name, hash] of ours) {
    if (theirs.get(name) !== hash) out.push(name);
  }
  for (const name of theirs.keys()) {
    if (!ours.has(name)) out.push(name);
  }
  return out.length;
}

/**
 * Whether the difference is in something nobody hashed.
 *
 * The honest answer when the whole-world fingerprints disagree and every recorded component
 * agrees: the state that differs was not in the breakdown. Reporting agreement there would be a
 * panel saying everything is fine on a frame that is provably not.
 */
export function divergenceIsUnaccounted(differing: number, worldsDiffer: boolean): boolean {
  return worldsDiffer && differing === 0;
}
