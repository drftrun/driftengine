/**
 * The arguments a culled frame hands the rasteriser, written by the device and read by it.
 *
 * **The whole pipeline exists so that the processor never learns how much there is to draw.** A
 * cull dispatch writes the count into a buffer and the draw reads it from the same buffer; the
 * frame is submitted before either number exists. So these are layouts rather than calls: what a
 * block holds, in what order, and what a caller must have cleared before the dispatch runs.
 *
 * **One draw for the whole frame, not one per cluster.** Every surviving cluster is an *instance*
 * of a fixed 128-triangle draw, which is what `VIS_MAX_TRIANGLES` is for: the index count is the
 * same for all of them, so there is one block instead of thousands and no multi-draw extension is
 * needed. A cluster with fewer triangles emits degenerate ones for the remainder — see
 * `clusterVertexCluster` — and a degenerate triangle covers no pixel, so the picture is unchanged
 * and the cost is the vertex stage running on indices that produce nothing.
 *
 * **What that costs, stated rather than hidden**: a scene whose clusters average 64 triangles runs
 * the vertex stage twice for every triangle it draws. The alternative is a block per cluster and a
 * loop of indirect draws on the processor, which is the draw-call bound this pipeline exists to
 * remove. If a consumer's clusters are persistently half full, the fix is in the *baker* — see
 * `assets/src/bake/cluster.ts`, whose target is the full 128.
 */

import { VIS_MAX_TRIANGLES } from './visbuffer.ts';

/** Words in a `drawIndexedIndirect` block: index count, instances, first index, base vertex, first instance. */
export const INDIRECT_DRAW_WORDS = 5;

/** Words in a `dispatchWorkgroups` block: three group counts. */
export const INDIRECT_DISPATCH_WORDS = 3;

/** Indices a cluster draw always issues, whatever the cluster actually holds. */
export const CLUSTER_INDEX_CAP = VIS_MAX_TRIANGLES * 3;

/**
 * The draw block for a frame that kept `clusters` of them.
 *
 * `firstInstance` is zero and the *instance index* is the slot in the kept list rather than the
 * cluster identifier: the list is compacted, so slot and identifier differ, and the shader reads
 * the identifier out of the list. Putting the identifier here instead would need a block per
 * cluster, which is the thing this avoids.
 */
export function writeClusterDrawArgs(out: Uint32Array, at: number, clusters: number): void {
  out[at] = CLUSTER_INDEX_CAP;
  out[at + 1] = Math.max(0, clusters);
  out[at + 2] = 0;
  out[at + 3] = 0;
  out[at + 4] = 0;
}

/**
 * The dispatch block for `count` items at `groupSize` a group.
 *
 * **Rounded up, and zero items is zero groups rather than one.** A group that runs with nothing to
 * do is harmless in this pipeline — every entry point range-checks its own invocation — but a
 * dispatch of one group over an empty list still reads a buffer that a caller may not have bound,
 * and "nothing to do" is the case a frame hits before anything has streamed in.
 *
 * **Zero falls out of the division rather than out of a special case**, and the special case that
 * stood here is gone because a perturbation survived it: `ceil(0 / n)` is already 0, so the branch
 * changed no answer and was a second statement of the rule to keep in step. The behaviour is still
 * held by a test — what is gone is the code that was not doing the holding.
 */
export function writeDispatchArgs(
  out: Uint32Array,
  at: number,
  count: number,
  groupSize: number,
): void {
  const groups = Math.ceil(Math.max(0, count) / Math.max(1, groupSize));
  out[at] = groups;
  out[at + 1] = 1;
  out[at + 2] = 1;
}

/**
 * Which slot of the kept list a vertex belongs to, and which triangle of that cluster.
 *
 * The vertex stage's whole addressing, on the processor so a test can read it. `vertex` is
 * `@builtin(vertex_index)` and runs to `CLUSTER_INDEX_CAP`; `instance` is
 * `@builtin(instance_index)` and is the slot.
 *
 * **A triangle past the cluster's own count is reported rather than clamped.** Clamping draws the
 * last triangle of the cluster over and over, which is a visible sliver on every cluster that is
 * not exactly full; reporting it lets the shader emit a degenerate triangle, which covers nothing.
 */
export function clusterVertexCluster(vertex: number, instance: number, triangleCount: number) {
  const triangle = Math.floor(vertex / 3);
  return { slot: instance, triangle, corner: vertex % 3, degenerate: triangle >= triangleCount };
}
