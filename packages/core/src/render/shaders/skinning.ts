/**
 * The vertex-stage skinning prelude: the palette, its two attributes, and the weighted matrix.
 *
 * Included by `flat/index.ts` inside `#if SKINNED`, so `resolveConditionals` cuts every line of it
 * out of the unskinned variant. **Absent rather than gated**, and that is measured: the vertex
 * shader had no permutation axis at all before this, so a second variant costs **1,118 bytes
 * gzipped**, measured on the regenerated file — two 4.4 KB strings that mostly dedupe inside
 * deflate's 32 KB window — where a uniform gate
 * would cost every vertex of every static mesh in the engine a branch it can never take. The
 * 2^n cost `ARCHITECTURE.md` §1 is written about is a property of the *fragment* corpus, whose
 * permutations are each larger than that window.
 *
 * What it costs is one more axis for `scripts/wgsl.ts` to expand and a second program on WebGL2.
 * What would make it wrong is a second vertex flag: four variants dedupe less well than two, so
 * re-measure before adding one.
 */
export const SKINNING_GLSL = `
/**
 * The joint palette, four texels a matrix, one row.
 *
 * A texture rather than a \`uniform mat4[]\`. The 2026-08-07 rule that keeps samples out of
 * unprovable branches is about *implicit derivatives*, which a vertex stage does not compute, so
 * it has nothing to say here — and \`texelFetch\` takes an integer coordinate with no level
 * inferred at all. What a uniform array would have cost is the cap: MAX_VERTEX_UNIFORM_VECTORS is
 * 256 on the WebGL2 floor and this shader already spends fifteen, which leaves sixty joints.
 *
 * What this costs is a texture upload per skinned draw. What would make it wrong is a profile
 * showing that upload is the limit; the fix is one texture for every character with a row offset.
 */
uniform highp sampler2D uJointPalette;

layout(location = 11) in vec4 aJoints;
layout(location = 12) in vec4 aWeights;

/** One joint's matrix, read as four consecutive texels of row 0. */
mat4 jointMatrix(int index) {
  int x = index * 4;
  return mat4(
    texelFetch(uJointPalette, ivec2(x, 0), 0),
    texelFetch(uJointPalette, ivec2(x + 1, 0), 0),
    texelFetch(uJointPalette, ivec2(x + 2, 0), 0),
    texelFetch(uJointPalette, ivec2(x + 3, 0), 0));
}

/**
 * The four influences, weighted.
 *
 * Weights are normalised by the importer rather than here: normalising per vertex per frame costs
 * a divide on every vertex to correct data an importer should have fixed once, and \`gltfSkin.ts\`
 * warns when a set does not sum to one. What would make it wrong is a caller building a MeshData
 * by hand with unnormalised weights, which shades slightly dark or bright rather than breaking.
 */
mat4 skinMatrix() {
  return jointMatrix(int(aJoints.x)) * aWeights.x
       + jointMatrix(int(aJoints.y)) * aWeights.y
       + jointMatrix(int(aJoints.z)) * aWeights.z
       + jointMatrix(int(aJoints.w)) * aWeights.w;
}
`;
