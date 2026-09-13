/**
 * Which stage a shader export is, from the name the engine already gave it.
 *
 * **Case-insensitive since 2026-08-25.** The pattern was `/VERT|VERTEX/` and only ever had to
 * match SCREAMING_CASE constants, because every permuted shader until skinning was a fragment
 * one and a permutation is a camelCase function by the convention `flatFrag` set. `flatVert`
 * matched neither arm and would have been compiled as a *fragment* shader — silently, with the
 * failure arriving at pipeline creation in a message about the stage rather than about the name.
 *
 * What it costs is that a fragment shader with "vert" anywhere in its name is now misclassified.
 * Every export in both shader roots was checked when this was widened and all forty-four
 * containing the substring are vertex shaders. What would make it wrong is naming a fragment
 * shader something like `inverted` — so do not, and this comment is the reason.
 *
 * It lives here rather than in `wgsl.ts` because `wgsl.test.mjs` runs under plain Node and cannot
 * import a TypeScript module, so a helper in there is a helper nothing can assert on.
 */
export function stageOf(name) {
  return /vert/i.test(name) ? 'vertex' : 'fragment';
}
