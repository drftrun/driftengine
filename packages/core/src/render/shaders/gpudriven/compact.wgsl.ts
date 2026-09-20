/**
 * Three flag buffers into one list, and the block that draws it.
 *
 * **Hand-written WGSL for the reason `cull.wgsl.ts` gives**: there is no GLSL original, because
 * WebGL2 has neither a compute stage nor an indirect draw. What keeps it honest is
 * `scripts/gpu-parity.mjs`, which runs it against `gpudriven/compact.ts` over generated flags.
 *
 * **The atomic is the whole of it and it is on the draw block rather than on a counter beside
 * it.** `instanceCount` is the number of clusters this phase draws; incrementing it *is* claiming
 * a slot in the list, so a separate counter would be the same number in two places and the block
 * would be written by whoever remembered. The other three words never change — the vertex count is
 * a cluster's index cap and the two firsts are zero — so a caller writes them once at creation and
 * clears the one word a frame.
 *
 * **Which phase is a setting rather than two shaders.** The two differ only in which side of the
 * history they take, and a second entry point would be a second place for the cut and the cull to
 * be applied — which is the half that must be identical in both. See `compact.ts` for the
 * invariant this is obeying: the history decides which phase a cluster is judged in and never
 * whether it is judged.
 */

/**
 * One invocation a cluster.
 *
 * `settings` is the phase — 0 for the half the history holds, 1 for the rest — and the cluster
 * count. `drawn` is next frame's history and **only phase two writes it**, for every cluster it
 * keeps whichever half judged it, because only phase two's cull has seen this frame's pyramid; see
 * `compactPhase` in `compact.ts`. A caller clears it once a frame.
 */
export const COMPACT_CLUSTERS_WGSL = `
/** phase, clusterCount. */
@group(0) @binding(0) var<storage, read> settings: array<u32, 2>;
@group(0) @binding(1) var<storage, read> selected: array<u32>;
@group(0) @binding(2) var<storage, read> keep: array<u32>;
@group(0) @binding(3) var<storage, read> history: array<u32>;
@group(0) @binding(4) var<storage, read_write> list: array<u32>;
@group(0) @binding(5) var<storage, read_write> drawn: array<u32>;
/** A four-word non-indexed draw block. Only word one is touched here; see the header. */
@group(0) @binding(6) var<storage, read_write> args: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= settings[1]) { return; }

  let seen = history[id.x] != 0u;
  let phaseOne = settings[0] == 0u;
  let visible = selected[id.x] != 0u && keep[id.x] != 0u;
  /* Next frame's history is phase two's answer, for the clusters phase one drew as well. */
  if (!phaseOne && visible) { drawn[id.x] = 1u; }

  /* The history decides which half judges this cluster, never whether one does. */
  if (seen != phaseOne || !visible) { return; }

  /* Claiming the slot and counting the instance are one operation, which is why the atomic is on
     the draw block. The order slots are handed out in is the scheduler's and is not an answer. */
  let slot = atomicAdd(&args[1], 1u);
  list[slot] = id.x;
}
`;
