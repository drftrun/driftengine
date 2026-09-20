/**
 * What the refinement network sees of a pixel, and what it is asked for.
 *
 * **Colour in display space, from the reconstructed frame alone.** The network runs on the frame the
 * composite has already graded, so its inputs are what a pair's PNG holds: eight-bit values over
 * 255. Two neighbourhoods are offered, and the trainer measures both:
 *
 * - **`luma`, eleven inputs**: the centre's three channels, and each of the eight neighbours' luma
 *   less the centre's. The differences carry the edge structure a reconstruction softens, centred so
 *   a flat region reads as zero whatever its brightness.
 * - **`rgb`, twenty-seven inputs**: the centre, then each neighbour's three channels less the
 *   centre's, for a network that needs colour edges a luma edge does not see.
 *
 * **The target is a residual**, native less reconstructed at the centre, which the tier blends by a
 * stated factor — so a network that learned nothing moves nothing, and a bad one degrades a frame
 * rather than replacing it.
 *
 * What it gives up: a border pixel reads its missing neighbours as itself, a zero difference, which
 * is one row of the frame against a network that has only seen the inside.
 */
import type { RgbaImage } from '../../packages/core/scripts/png.mjs';

export type FeatureSet = 'luma' | 'rgb';

export const FEATURE_COUNT: Readonly<Record<FeatureSet, number>> = { luma: 11, rgb: 27 };

/* Rec. 709 weights, applied to display values: an edge detector's measure, not a light level. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/* The eight neighbours, row by row, the centre skipped. */
const OFFSETS_X = [-1, 0, 1, -1, 1, -1, 0, 1];
const OFFSETS_Y = [-1, -1, -1, 0, 0, 1, 1, 1];

function channel(image: RgbaImage, x: number, y: number, c: number): number {
  const cx = x < 0 ? 0 : x >= image.width ? image.width - 1 : x;
  const cy = y < 0 ? 0 : y >= image.height ? image.height - 1 : y;
  return (image.rgba[(cy * image.width + cx) * 4 + c] as number) / 255;
}

/** Write a pixel's features into `out`, which holds at least `FEATURE_COUNT[set]`. */
export function features(
  image: RgbaImage,
  x: number,
  y: number,
  set: FeatureSet,
  out: Float64Array,
): void {
  const r = channel(image, x, y, 0);
  const g = channel(image, x, y, 1);
  const b = channel(image, x, y, 2);
  out[0] = r;
  out[1] = g;
  out[2] = b;
  const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  for (let n = 0; n < 8; n += 1) {
    const nx = x + (OFFSETS_X[n] as number);
    const ny = y + (OFFSETS_Y[n] as number);
    const nr = channel(image, nx, ny, 0);
    const ng = channel(image, nx, ny, 1);
    const nb = channel(image, nx, ny, 2);
    if (set === 'luma') {
      out[3 + n] = LUMA_R * nr + LUMA_G * ng + LUMA_B * nb - luma;
    } else {
      out[3 + n * 3] = nr - r;
      out[4 + n * 3] = ng - g;
      out[5 + n * 3] = nb - b;
    }
  }
}

/** Native less reconstructed, at one pixel, into `out[0..2]`. */
export function residual(
  reconstructed: RgbaImage,
  native: RgbaImage,
  x: number,
  y: number,
  out: Float64Array,
): void {
  for (let c = 0; c < 3; c += 1) {
    out[c] = channel(native, x, y, c) - channel(reconstructed, x, y, c);
  }
}
