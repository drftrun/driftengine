/**
 * Binning the frame's pixels by material, in three dispatches.
 *
 * **Count, then sum, then scatter**, which is the only arrangement that gives each bin a
 * contiguous slice without sorting: a pixel cannot know where it belongs until every pixel before
 * it has been counted, so the count has to finish before the offsets exist and the offsets have to
 * exist before anything is written.
 *
 * **The scatter's order inside a bin is whatever the atomics produced**, and nothing downstream
 * may depend on it. Shading reads a bin as a set. `scripts/gpu-parity.mjs` compares the bins as
 * sets for the same reason, and compares the *counts* exactly — which are order-free and are where
 * a binning defect actually shows.
 *
 * **The sentinel test in the count and scatter passes survives perturbation**, and it is kept for
 * the reason `materialBin.ts` states at length: `VIS_EMPTY`'s cluster field reads as 33,554,431,
 * so the range test below it refuses the same pixels. The range test is the one a real frame
 * exercises — a visibility buffer left over from a frame with more geometry in it — and it is
 * caught.
 *
 * Hand-written for the reason `cull.wgsl.ts` gives: WebGL2 has no compute stage, so there is no
 * GLSL original and nothing this can break by being wrong.
 */

/** Shared declarations, so the three entry points cannot disagree about the layout. */
const BIN_PREAMBLE = `
const VIS_TRIANGLE_BITS: u32 = 7u;
const VIS_EMPTY: u32 = 0xffffffffu;

/** pixelCount, materialCount, groupSize. */
@group(0) @binding(0) var<storage, read> settings: array<u32, 4>;
@group(0) @binding(1) var<storage, read> visibility: array<u32>;
@group(0) @binding(2) var<storage, read> materialOf: array<u32>;
`;

/**
 * Pass one: how many pixels each material owns.
 *
 * The counts buffer must be **cleared before this runs**. A count buffer reused across frames
 * without clearing grows without bound, the offsets then run past the end of the pixel list, and
 * the shading reads a neighbouring bin — which looks like one material bleeding into another.
 */
export const MATERIAL_COUNT_WGSL = `${BIN_PREAMBLE}
@group(0) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= settings[0]) { return; }
  let packed = visibility[id.x];
  if (packed == VIS_EMPTY) { return; }
  let cluster = packed >> VIS_TRIANGLE_BITS;
  if (cluster >= arrayLength(&materialOf)) { return; }
  let material = materialOf[cluster];
  if (material >= settings[1]) { return; }
  atomicAdd(&counts[material], 1u);
}
`;

/**
 * Pass two: the offsets, as an exclusive prefix sum, and the dispatch block for each material.
 *
 * **One invocation, deliberately.** A material count is tens, not millions, and a parallel scan
 * over tens of elements costs more in barriers than the serial loop costs in cycles. The comment
 * is here because "this is not parallel" reads as an oversight in a compute shader and is a
 * measurement: the scan would be three barriers against a loop of at most a few hundred adds.
 *
 * **Every material gets a block, including an empty one**, whose group count is zero. Dropping it
 * shifts every later material's arguments and shades the scene with the wrong code. The zero is
 * the round-up's own answer rather than a branch: a `select` stood here and a perturbation
 * survived it, because `(0 + n - 1) / n` is already zero.
 */
export const MATERIAL_OFFSETS_WGSL = `${BIN_PREAMBLE}
@group(0) @binding(3) var<storage, read> counts: array<u32>;
@group(0) @binding(4) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(5) var<storage, read_write> dispatches: array<u32>;

@compute @workgroup_size(1)
fn main() {
  let materials = settings[1];
  let groupSize = max(1u, settings[2]);
  var running = 0u;
  for (var material = 0u; material < materials; material = material + 1u) {
    offsets[material] = running;
    let held = counts[material];
    running = running + held;
    /* Zero falls out of the division: an empty bin is zero groups with no special case. */
    let groups = (held + groupSize - 1u) / groupSize;
    dispatches[material * 3u] = groups;
    dispatches[material * 3u + 1u] = 1u;
    dispatches[material * 3u + 2u] = 1u;
  }
}
`;

/**
 * Pass three: every covered pixel's index into its material's slice.
 *
 * `cursors` is a copy of the offsets rather than the offsets themselves, because the offsets have
 * to survive this pass — they are what tells a shading group where its material's list begins.
 */
export const MATERIAL_SCATTER_WGSL = `${BIN_PREAMBLE}
@group(0) @binding(3) var<storage, read_write> cursors: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> pixels: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= settings[0]) { return; }
  let packed = visibility[id.x];
  if (packed == VIS_EMPTY) { return; }
  let cluster = packed >> VIS_TRIANGLE_BITS;
  if (cluster >= arrayLength(&materialOf)) { return; }
  let material = materialOf[cluster];
  if (material >= settings[1]) { return; }
  let at = atomicAdd(&cursors[material], 1u);
  pixels[at] = id.x;
}
`;
