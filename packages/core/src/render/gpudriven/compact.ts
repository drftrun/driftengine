/**
 * Turning three flag buffers into the one list a draw can read, and the block that draws it.
 *
 * **The culls answer per cluster and a draw wants a list.** `lodCut` writes a flag, `cullClusters`
 * writes a flag, and the history is a flag — all three addressed by cluster identifier, because a
 * dispatch decides every cluster at once and cannot append in input order without a prefix sum.
 * The compaction is the step that turns the three into `[4, 17, 18, 40]` and says how many there
 * are, which is what `instanceCount` in an indirect block is.
 *
 * **Order is not part of the answer.** The device appends with an atomic and the arrival order is
 * whatever the scheduler did; this reference appends in cluster order because a loop has one. So a
 * check comparing the two sorts both — the same rule `cullClusters.ts` avoids needing by answering
 * in flags, and the reason the compaction is the one stage that cannot.
 *
 * **Four words, not `INDIRECT_DRAW_WORDS`' five, and that is the plan being wrong rather than a
 * shortcut.** The plan has this as `drawIndexedIndirect`. It cannot be: one block covers every
 * surviving cluster, each cluster's indices begin somewhere different, and an indexed draw has one
 * `firstIndex` for the whole block. So the raster shader fetches indices out of a storage buffer
 * itself — `visbufferRaster.wgsl.ts` already does — and what is issued is the non-indexed
 * `drawIndirect`, whose block is vertex count, instances, first vertex, first instance. The five
 * word block would *happen* to work, because its extra words are zero where the four-word one
 * wants zero; that is a coincidence and not a layout.
 *
 * **The history is per cluster here rather than the bit set `twoPhase.ts` holds.** A shader
 * addressing a bit needs a shift and a mask around every read and write, and the atomic that
 * records this frame's would be a read-modify-write on a word shared by thirty-two clusters. One
 * word a cluster is the device's shape; the bit set is the processor's, and they answer the same
 * question.
 */

import { CLUSTER_INDEX_CAP } from './indirect.ts';

/** Words in a non-indexed `drawIndirect` block: vertex count, instances, first vertex, first instance. */
export const DRAW_INDIRECT_WORDS = 4;

/**
 * Which half of the frame a compaction is building.
 *
 * Phase one draws what the history holds; phase two draws what it does not. **Never "whether" —
 * every live cluster is in exactly one of the two lists**, which is the invariant `twoPhase.ts`
 * exists to state and the reason a history that is entirely stale costs a test rather than a hole.
 */
export const PHASE_ONE = 0;
export const PHASE_TWO = 1;
export type ClusterPhase = typeof PHASE_ONE | typeof PHASE_TWO;

/**
 * Append every cluster this phase draws, and write the block that draws them.
 *
 * **`drawn` is next frame's history, and only phase two writes it** — for every cluster, seen last
 * frame or not, from its own cull, which is the only one that tested against this frame's pyramid.
 * That is `updateHistory` in `twoPhase.ts`: the history is replaced, not accumulated. Phase one's
 * cull has no pyramid, so a cluster it keeps may be hidden; marking it there kept every cluster ever
 * seen drawn for as long as it stayed in the frustum. The caller clears `drawn` once a frame.
 */
export function compactPhase(
  phase: ClusterPhase,
  selected: Uint32Array,
  keep: Uint32Array,
  history: Uint32Array,
  count: number,
  list: Uint32Array,
  drawn: Uint32Array,
  args: Uint32Array,
): number {
  let at = 0;
  for (let cluster = 0; cluster < count; cluster += 1) {
    const seen = (history[cluster] ?? 0) !== 0;
    const visible = (selected[cluster] ?? 0) !== 0 && (keep[cluster] ?? 0) !== 0;
    if (phase === PHASE_TWO && visible) drawn[cluster] = 1;
    if (seen !== (phase === PHASE_ONE) || !visible) continue;
    list[at] = cluster;
    at += 1;
  }
  args[0] = CLUSTER_INDEX_CAP;
  args[1] = at;
  args[2] = 0;
  args[3] = 0;
  return at;
}
