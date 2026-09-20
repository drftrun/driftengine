/**
 * How alike two pictures are, structure included.
 *
 * **A squared difference is not a likeness.** It is what the fit descends, because it has a
 * gradient, and it is the wrong thing to judge the result by: a cloud that is uniformly a little
 * dark scores badly on it and looks right, and one that is right on average with the structure
 * smeared away scores well and looks wrong. Structural similarity compares local means, variances
 * and covariance, so it answers the question a reader actually asks of a capture.
 *
 * **Uniform windows rather than a Gaussian one.** The original weights each window by an 11 × 11
 * Gaussian; this walks 8 × 8 blocks with equal weight, which is the same three terms over a
 * different support and is what every fast implementation does. What it gives up is comparability
 * with a number quoted from the paper — so a floor here is measured against this implementation
 * and not lifted from one written elsewhere.
 */

/** The side of the block the three statistics are taken over. */
export const SIMILARITY_WINDOW = 8;

/*
 * The stabilisers, for values on 0 to 1. They keep a window where both pictures are flat from
 * dividing zero by zero, and they are the reason two dark patches are not declared identical on
 * the strength of a rounding difference.
 */
const C1 = 0.01 * 0.01;
const C2 = 0.03 * 0.03;

/**
 * The mean structural similarity of `a` and `b`, one value a pixel, over every window.
 *
 * A picture narrower or shorter than a window is compared as one window rather than refused: it
 * has a mean and a variance like any other, and the alternative is a measure that cannot answer
 * for a thumbnail.
 */
export function structuralSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
): number {
  let total = 0;
  let windows = 0;
  for (let top = 0; top < height; top += SIMILARITY_WINDOW) {
    for (let left = 0; left < width; left += SIMILARITY_WINDOW) {
      const right = Math.min(width, left + SIMILARITY_WINDOW);
      const bottom = Math.min(height, top + SIMILARITY_WINDOW);
      const pixels = (right - left) * (bottom - top);
      if (pixels === 0) continue;
      let sumA = 0;
      let sumB = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          sumA += a[y * width + x] as number;
          sumB += b[y * width + x] as number;
        }
      }
      const meanA = sumA / pixels;
      const meanB = sumB / pixels;
      let varianceA = 0;
      let varianceB = 0;
      let covariance = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offA = (a[y * width + x] as number) - meanA;
          const offB = (b[y * width + x] as number) - meanB;
          varianceA += offA * offA;
          varianceB += offB * offB;
          covariance += offA * offB;
        }
      }
      /*
       * Divided by n − 1 where there is more than one pixel, which is the unbiased estimate the
       * original uses. A single-pixel window has no spread to estimate and is compared by its
       * means alone.
       */
      const spread = pixels > 1 ? pixels - 1 : 1;
      varianceA /= spread;
      varianceB /= spread;
      covariance /= spread;
      const luminance = (2 * meanA * meanB + C1) / (meanA * meanA + meanB * meanB + C1);
      const structure = (2 * covariance + C2) / (varianceA + varianceB + C2);
      total += luminance * structure;
      windows += 1;
    }
  }
  return windows === 0 ? 1 : total / windows;
}
