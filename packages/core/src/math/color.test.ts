import { expect, it } from 'vitest';

import { srgbColor } from './color.ts';

/*
 * **A COLOUR PICKED BY EYE COMES BACK AS THE LINEAR VALUE THE sRGB ENCODE TURNS BACK INTO IT.**
 * Hand-derived from the sRGB curve: the ends are themselves; 0.5 is ((0.5 + 0.055) / 1.055)^2.4 =
 * 0.214041; 0.04045, where the two segments meet, is 0.04045 / 12.92 = 0.0031308 on either; and a
 * channel below that is the straight segment, 0.02 / 12.92 = 0.00154799.
 */
it('DECODES EACH CHANNEL THROUGH THE sRGB CURVE, BOTH SEGMENTS', () => {
  expect(srgbColor(0, 1, 0.5)).toEqual([0, 1, expect.closeTo(0.214041, 6)]);
  expect(srgbColor(0.04045, 0.02, 0.8)).toEqual([
    expect.closeTo(0.0031308, 7),
    expect.closeTo(0.00154799, 8),
    expect.closeTo(0.603827, 6),
  ]);
});
