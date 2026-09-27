/**
 * How a point light's brightness falls with distance, as the lit shader draws it, for the light
 * DriftLight sums into its volume.
 *
 * **One formula in two languages, tied by a test.** The frame shades a light in GLSL; the volume is
 * summed in TypeScript. If they disagree the summed light and the exact light differ where they
 * crossfade, and a seam follows the camera across every surface. `falloff.test.ts` reads the
 * shader's lines and asserts these numbers against them.
 *
 * Both of the renderer's falloffs: `smooth`, the default, is a linear ramp squared, reaching zero at
 * the radius; `inverseSquare` is physical, windowed so it still reaches zero at the radius, and
 * floored at ten centimetres so a surface touching a light is not infinitely bright.
 */

export type PointLightFalloff = 'smooth' | 'inverseSquare';

/** The shader's `shape` for an unshaped point light: no cone, no photometric profile. */
export function pointLightShape(dist: number, radius: number, falloff: PointLightFalloff): number {
  if (falloff === 'inverseSquare') {
    const ratio = dist / Math.max(radius, 1e-4);
    const window = Math.min(1, Math.max(0, 1 - ratio ** 4));
    return (window * window) / Math.max(dist * dist, 0.01);
  }
  const linear = Math.min(1, Math.max(0, 1 - dist / radius));
  return linear * linear;
}
