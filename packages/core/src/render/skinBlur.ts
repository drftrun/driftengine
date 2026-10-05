/**
 * Skin's screen-space scattering, as `shaders/skinBlur.ts` spreads it: the reference its tests hold
 * the kernel to, and nothing at run time calls it.
 *
 * **What it spreads.** With `skinScattering: 'screen-space'`, a skin draw writes its specular to the
 * frame and its diffuse — the light that went beneath the surface — to a target of its own, with the
 * profile it scatters by in the alpha. Before anything blended is drawn, that target is blurred
 * along the screen's two axes by Burley's normalised diffusion, one width per channel, and added
 * back: light that entered a cheek leaves it a centimetre away, reddest furthest, across the
 * pixels that centimetre covers at the cheek's distance. The pre-integrated fit stays in the lit
 * stage for what this cannot see — a terminator's curvature — and this carries what that cannot:
 * light crossing a shadow's edge, or a nostril's rim, in the picture rather than in a fit.
 *
 * **Separable, which the profile is not**: two 1D passes with Burley's profile integrated across a
 * line, as Jimenez's separable subsurface scattering does. What it gives up is the radial shape, a
 * blur a little squarer than the profile; what it buys is thirteen taps an axis rather than a disc.
 *
 * **Each tap is the profile's mass over its cell, in closed form**, so a channel's weights sum to
 * one before any are refused, and a channel that travels a quarter as far as the widest keeps most
 * of its light at the centre. The taps are placed in units of the widest channel's distance and
 * closer together near the centre, where the profile's sharp peak is.
 */

/** The taps' distances from the centre, one side, in units of the widest channel's distance. */
export const SKIN_BLUR_TAPS = [0, 0.4, 1.1, 2.1, 3.5, 5.6, 9] as const;

/**
 * Where each tap's cell ends, in the same units: halfway to the next tap, and the last cell runs
 * to infinity, so the profile's whole mass is somewhere.
 */
export const SKIN_BLUR_EDGES = [0.2, 0.75, 1.6, 2.8, 4.55, 7.3] as const;

/** How many profiles a frame's skin can name: `SkinModel.profile`. */
export const SKIN_PROFILES = 8;

/**
 * Burley's profile across a line, `(e^(−x/d) + e^(−x/3d)) / 8d`, integrated from 0 to `x`: half of
 * it lies on each side, so this reaches ½ at infinity.
 */
export function burleyMass(x: number, d: number): number {
  return 0.5 - (Math.exp(-x / d) + 3 * Math.exp(-x / (3 * d))) / 8;
}

/**
 * Tap `tap`'s weight for one channel scattering `d`, the taps spaced by `widest`: the centre's cell
 * is both sides of it, every other cell one side, and a tap on each side takes this weight.
 */
export function skinBlurWeight(tap: number, d: number, widest: number): number {
  if (tap === 0) return 2 * burleyMass((SKIN_BLUR_EDGES[0] as number) * widest, d);
  const inner = (SKIN_BLUR_EDGES[tap - 1] as number) * widest;
  const outer = tap < SKIN_BLUR_EDGES.length ? (SKIN_BLUR_EDGES[tap] as number) * widest : Infinity;
  return (outer === Infinity ? 0.5 : burleyMass(outer, d)) - burleyMass(inner, d);
}
