/**
 * A cutout that keeps its coverage down the mip chain.
 *
 * **Averaging alpha thins everything that is thinner than a texel.** Each level of a mip chain is
 * the mean of four texels of the one above, so a needle one texel wide on a clear background is 0.5
 * at the next level, 0.25 at the one after, and gone against a cutoff of 0.5 two levels down. A
 * tree that is dense up close then stands bare a few metres off, which on a bought courtyard was a
 * cypress drawn as bare branches at 1280 pixels across and in full leaf at 2000.
 *
 * **So the test scales alpha up by the level it is sampling**: a quarter more per level, the figure
 * Ben Golus measured on foliage in "Anti-aliased Alpha Test" (2017). Only the test sees the scaled
 * value; what a translucent draw blends with is the texture's own alpha, and a material with no
 * cutoff is untouched. What it gives up is exactness: coverage is held roughly rather than measured
 * per image, which Ignacio Castaño's method would do at upload from a readback this engine does not
 * make. What would make it wrong is an image whose mips were built to keep coverage already, which
 * this would then thicken.
 *
 * The level is estimated from the texture coordinate's screen derivatives, the isotropic formula;
 * a sampler with anisotropic filtering reads a lower level at a grazing angle, so there a cutout
 * comes out slightly fuller than its own mip would have made it.
 */

/** How much more alpha each mip level down is credited with in the test. */
export const CUTOUT_MIP_SCALE = 0.25;

/**
 * `cutoutAlpha(alpha, texels)`: the alpha the cutout test should see, for a sample at `texels`, the
 * texture coordinate times the texture's size. Called in uniform control flow, since it takes
 * derivatives.
 */
export const CUTOUT_COVERAGE_GLSL = `
float cutoutAlpha(float alpha, vec2 texels) {
  vec2 dx = dFdx(texels);
  vec2 dy = dFdy(texels);
  float level = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
  return alpha * (1.0 + level * ${CUTOUT_MIP_SCALE.toFixed(2)});
}
`;

/** The same, given the level, for a test to pin: what the shader compares against the cutoff. */
export function cutoutAlpha(alpha: number, level: number): number {
  return alpha * (1 + Math.max(0, level) * CUTOUT_MIP_SCALE);
}
