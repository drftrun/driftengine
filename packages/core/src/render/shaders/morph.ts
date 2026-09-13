import { MAX_MORPH_TARGETS } from '../skinPalette.ts';

/**
 * The vertex-stage morph prelude: the delta texture, the weights, and their weighted sum.
 *
 * Included by `flat/index.ts` inside `#if MORPHED`, so `resolveConditionals` cuts every line out of
 * the variants that do not morph. **The same mechanism the joint palette established**, and that
 * is why this row was affordable: eleven attribute locations were already spoken for and glTF
 * morph wants up to twenty-four more, so an attribute per target was never going to fit. A vertex
 * data texture has no such budget.
 *
 * Measured, which is what §3.2 of the plan asks for: the second vertex flag takes the shader from
 * two variants to four for **1,674 gzipped bytes**, against 246,925 for one more *fragment* flag.
 * The worry that four diverging variants would dedupe far worse than two was wrong — they cost
 * about half again as much, not an order of magnitude.
 *
 * **Both pre-build estimates came in low, and by a similar factor.** The first flag was estimated
 * at 357 and cost 1,118; this one was estimated at 230 and cost 1,674. Both estimates were made by
 * splicing hand-written WGSL into a duplicated variant, which does not model what naga emits — its
 * temporaries, its entry-point parameters, and the uniform block that grows with the flag. Simulate
 * a permutation to learn its *order of magnitude* and regenerate to learn its cost.
 *
 * **Positions only.** A morph target that also moved normals would need a second delta set and a
 * second fetch per target; what this gives up is correct shading on a strongly morphed surface,
 * which shows as lighting that lags the shape. What would make it wrong is a face rig, where it
 * would be the whole point — the fix is a second texture, not a different mechanism.
 */
export const MORPH_GLSL = `
/**
 * Every target's delta for every vertex, interleaved by vertex.
 *
 * A vertex's targets are adjacent because the shader reads all of them for one vertex and nothing
 * reads one target across many vertices — one cache line rather than \`uMorphTargetCount\` of them.
 * Wrapped onto rows, because a mesh times its targets passes WebGL2's guaranteed 2048 texels at
 * 256 vertices with eight targets, which is a small mesh.
 */
uniform highp sampler2D uMorphDeltas;
uniform float uMorphWeights[${MAX_MORPH_TARGETS}];
uniform int uMorphTargetCount;
/** The texture's width, so the shader can turn a texel index into a row and a column. */
uniform int uMorphTextureWidth;

/**
 * The weighted sum of every active target's delta for this vertex.
 *
 * The loop bound is the compile-time maximum and the *break* is on the uniform, because GLSL ES
 * 3.00 requires a constant bound. A mesh with two targets still costs two iterations rather than
 * eight, which is the point of the break — and the branch is uniform across the draw, so nothing
 * here falls foul of the 2026-08-07 rule even before the observation that a vertex stage computes
 * no derivatives.
 */
vec3 morphOffset() {
  vec3 offset = vec3(0.0);
  for (int t = 0; t < ${MAX_MORPH_TARGETS}; t++) {
    if (t >= uMorphTargetCount) break;
    int texel = gl_VertexID * uMorphTargetCount + t;
    ivec2 at = ivec2(texel % uMorphTextureWidth, texel / uMorphTextureWidth);
    offset += texelFetch(uMorphDeltas, at, 0).xyz * uMorphWeights[t];
  }
  return offset;
}
`;
