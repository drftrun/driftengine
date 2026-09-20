/**
 * Placing a mesh's vertex in the world, for every stage of the pipeline that has to.
 *
 * **Three stages do it now and each had its own copy of it.** The visibility raster called it
 * `transformed`, the shading pass called it `worldOf`, and the two bodies were the same nine
 * multiplies; the blended raster would have been a third. What the copies would drift about is not
 * the arithmetic but the *layout* — which four floats are the translation — and a stage that reads
 * the translation from the wrong column draws a mesh somewhere else entirely while every test that
 * builds its scene at the origin passes.
 *
 * **Column major, so the translation is floats 12 to 14.** `clusterWorld.ts` writes the bounds
 * through the same convention and `sceneShadowBounds` reads them, which is what keeps a cluster's
 * bounding sphere over the geometry it bounds.
 *
 * The including module declares `transforms` — sixteen floats a mesh — at whichever binding it has
 * room for.
 */
export const MESH_TRANSFORM_WGSL = /* wgsl */ `
fn worldOf(mesh: u32, p: vec3<f32>) -> vec3<f32> {
  let m = mesh * 16u;
  return vec3<f32>(
    transforms[m] * p.x + transforms[m + 4u] * p.y + transforms[m + 8u] * p.z + transforms[m + 12u],
    transforms[m + 1u] * p.x + transforms[m + 5u] * p.y + transforms[m + 9u] * p.z + transforms[m + 13u],
    transforms[m + 2u] * p.x + transforms[m + 6u] * p.y + transforms[m + 10u] * p.z + transforms[m + 14u],
  );
}

/* Upper three-by-three only: a direction has no translation. See the header on non-uniform scale. */
fn rotatedOf(mesh: u32, n: vec3<f32>) -> vec3<f32> {
  let m = mesh * 16u;
  return vec3<f32>(
    transforms[m] * n.x + transforms[m + 4u] * n.y + transforms[m + 8u] * n.z,
    transforms[m + 1u] * n.x + transforms[m + 5u] * n.y + transforms[m + 9u] * n.z,
    transforms[m + 2u] * n.x + transforms[m + 6u] * n.y + transforms[m + 10u] * n.z,
  );
}
`;
