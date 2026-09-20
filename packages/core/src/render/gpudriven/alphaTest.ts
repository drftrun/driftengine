/**
 * Whether a fragment survives its material's alpha test.
 *
 * **The reference the raster's WGSL is checked against**, which is `gpu-parity.mjs`'s pattern and
 * is not about the arithmetic being hard: a term that exists only as a shader is a term nothing
 * can disagree with. The rule here is four lines; the boundary conditions are where every alpha
 * test goes wrong, and they are what the tests beside this are about.
 *
 * **`>=` rather than `>`**, which is GLSL's own convention and the boundary every alpha test gets
 * wrong. At `>` a texel exactly at the cutoff is discarded, which puts a one-texel seam around
 * every leaf and reads as a mipmap problem rather than as a comparison.
 *
 * **The zero case is a branch and not just an arithmetic identity.** It is what lets a material
 * that says nothing about cutout skip the base-colour fetch entirely, which is the promise every
 * term in this pipeline has made since it was four lines: a frame that asked for nothing draws
 * exactly the frame it drew before, and pays for nothing.
 *
 * **The guard is written as a negated `>` rather than as `<=`, and a device is why.** WGSL does not
 * require an implementation to support NaN, so a shader may assume one never arrives; written
 * `cutoff <= 0` this file discarded every fragment of a material whose cutoff was not a number and
 * the device kept every one of them, which `scripts/gpu-parity.mjs` reported as four disagreements
 * the first time it ran. Negating the comparison makes both keep it, and keeping is also the right
 * answer: a cutoff that is not a number is not a test, and a surface a consumer can see is
 * findable where one that silently vanished is not.
 */

/** A material that never asked for a test. Zero, so an unset field is off. */
export const ALPHA_TEST_OFF = 0;

export function alphaKept(alpha: number, cutoff: number): boolean {
  if (!(cutoff > ALPHA_TEST_OFF)) return true;
  return alpha >= cutoff;
}
