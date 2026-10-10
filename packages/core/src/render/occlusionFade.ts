/**
 * Where ambient occlusion fades out with distance: `setAmbientOcclusionFade`'s two numbers as the
 * estimate reads them, `uFade` in `shaders/ambientOcclusion.ts`.
 *
 * **Occlusion is whole up to `distance` metres from the eye and gone `radius` metres past it.** A
 * screen-space estimate reaches as far as the depth does, and far off the depth buffer's steps are
 * metres apart: a sky dome or a mountain range kilometres away is shaded in rings that follow
 * those steps, and nothing there is in contact with anything the estimate could be right about.
 * A pixel past the fade skips the estimate's walk, as the sky does, so it costs less as well.
 *
 * **What it gives up**: distant contact shade that is real — a doorway a hundred metres off — fades
 * with the rest, and the distance is the eye's and not the subject's, so a long lens fades what it
 * frames close up. What would make it wrong is a scene whose far depth is precise enough to shade,
 * which is a reason to fade further, not to leave the fade off.
 */

/** `uFade` for no fade: a distance below zero, which the estimate reads as "never". */
const NO_FADE = -1;

/**
 * `distance` and `radius` into `out`, `[distance, radius]`. A distance that is not a finite number
 * at or above zero is no fade, `[−1, 0]`, so `Infinity` reads as "never fades". A radius below zero
 * or not a number is 0, which is a cut at `distance` rather than a ramp.
 */
export function resolveOcclusionFade(distance: number, radius: number, out: Float32Array): void {
  const fades = Number.isFinite(distance) && distance >= 0;
  out[0] = fades ? distance : NO_FADE;
  out[1] = fades && Number.isFinite(radius) ? Math.max(radius, 0) : 0;
}
