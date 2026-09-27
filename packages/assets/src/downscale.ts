/**
 * Shrinking a decoded image to a texture cap, offline, for the baker.
 *
 * **Halving rather than an arbitrary ratio**, so each output texel covers a whole block of source
 * texels and a box average is exact. The cost is that a cap is reached in powers of two: a
 * 3000-wide map capped at 1024 comes out 750, not 1024. What would make that wrong is a budget
 * tight enough that the lost resolution is worth an arbitrary-ratio filter.
 *
 * **Averaged in the encoded values, not in linear light.** For a normal or ORM map that is
 * correct, because those values are linear data. For an sRGB colour map it darkens fine,
 * high-contrast detail slightly, since the mean of two sRGB values is darker than the sRGB of
 * their mean. What would make that wrong is a capped bake whose distant albedo reads visibly
 * darker than the uncapped one; the fix then is to linearise the colour slot before averaging.
 */

/** The size `width` by `height` is halved to until its longer side is at most `maxSide`. */
export function cappedSize(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  let w = width;
  let h = height;
  while (Math.max(w, h) > maxSide) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return { width: w, height: h };
}

/**
 * A box average from `width`×`height` down to `outWidth`×`outHeight`, four bytes a texel.
 *
 * Each output texel averages the source rectangle it covers, rounded to nearest.
 */
export function downscaleRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let oy = 0; oy < outHeight; oy++) {
    const y0 = Math.floor((oy * height) / outHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / outHeight));
    for (let ox = 0; ox < outWidth; ox++) {
      const x0 = Math.floor((ox * width) / outWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / outWidth));
      const count = (x1 - x0) * (y1 - y0);
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) sum += rgba[(y * width + x) * 4 + c] ?? 0;
        }
        out[(oy * outWidth + ox) * 4 + c] = Math.round(sum / count);
      }
    }
  }
  return out;
}
