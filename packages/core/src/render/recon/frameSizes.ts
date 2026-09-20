/**
 * The two sizes a reconstructed frame has.
 *
 * **A frame with a reconstruction has a render size and an output size, and every texel size is
 * taken from the target it belongs to.** The scene, its depth, the multisampled pair, decals,
 * reflections, the translucent set, the medium and the motion target are the render size; the
 * resolve, the history, bloom and the composite are the output size. The two are one number apart
 * and confusing them does not fail — it draws a picture that is subtly the wrong shape.
 *
 * **The projection is built from the output's aspect and never from the render's.** Each axis is
 * rounded up on its own, so a render size's aspect differs from its output's by up to a texel's
 * worth: at 1280 by 720 and a ratio of 1.7 that is 753 by 424, an aspect of 1.7759 against 1.7778.
 * A projection built from the render size stretches the picture by that much — a fraction of a per
 * cent, invisible in a screenshot and visible as a wobble every time the drawing buffer resizes.
 */

/**
 * Why a multisampled frame is not reconstructed, in words, so both backends read the same sentence.
 *
 * **The motion pass is what forbids it.** That pass draws the frame's movers again with the depth
 * the scene left, testing for equality so only the pixels the scene kept are written — and an
 * attachment's sample count has to agree with every other attachment in its pass, so a
 * multisampled depth wants a multisampled motion target, a resolve of it, and a second set of
 * everything downstream.
 *
 * It is also a choice nobody should want. A reconstruction's own accumulation is what antialiases
 * the picture; paying for a second antialiasing at four times the fragment work, and then throwing
 * three quarters of it away in a resolve, is the cost this feature exists to avoid.
 */
export const RECONSTRUCTION_MULTISAMPLE_REFUSAL =
  'driftengine: a reconstruction draws its movers again against the depth the scene left, and ' +
  'every attachment in a pass must agree about its sample count — so reconstruction is off ' +
  'wherever `sceneSamples` is above one. The accumulation is the antialiasing; the two are a ' +
  'choice of one.';

/** The render size for an output size and a `quality.reconstruction` ratio; 0 is off. */
export function reconRenderSize(
  outputWidth: number,
  outputHeight: number,
  ratio: number,
): { width: number; height: number } {
  const width = Math.max(1, Math.floor(outputWidth));
  const height = Math.max(1, Math.floor(outputHeight));
  /*
   * **Anything that is not a ratio above one draws at the output size**: off, a ratio of exactly
   * one, and — the case that matters — a ratio *below* one, which divides the other way and would
   * ask the renderer to draw more pixels than it shows. `resolveRenderQuality` never produces one,
   * and this is a public function that a caller reaches with whatever number they have. `NaN`
   * lands here too, which `ratio <= 0` would have sent through the divide to a size of `NaN`.
   */
  if (!(ratio > 1)) return { width, height };
  /*
   * Up, never down: rounding down draws fewer pixels than the ratio says, which is a frame-rate win
   * nobody asked for and a softer picture they did not agree to.
   *
   * **The floor of one is not redundant**, which taking it out and watching nothing fail suggested
   * it was. A ceiling of a positive quotient is at least one for every finite ratio — and an
   * infinite one divides to zero, so the size comes back zero by zero, which a device refuses.
   */
  return {
    width: Math.max(1, Math.ceil(width / ratio)),
    height: Math.max(1, Math.ceil(height / ratio)),
  };
}
