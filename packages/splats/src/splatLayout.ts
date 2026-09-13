/** How a capture is laid out in its two textures, shared by both backends so they cannot disagree. */

/**
 * Splats per row.
 *
 * **A power of two, so the shader's divide is a shift** and the two textures index alike: the data
 * texture is twice this wide because a splat is two texels, and the order texture is exactly this
 * wide because a slot is one.
 *
 * 1024 puts a million splats in 977 rows, comfortably inside WebGL2's guaranteed 2048 — see
 * `splatRows`, which is where that limit is checked rather than assumed.
 */
export const SPLAT_STRIDE = 1024;

/** How many rows a capture of `count` splats needs. Both textures share it. */
export function splatRows(count: number): number {
  return Math.max(1, Math.ceil(count / SPLAT_STRIDE));
}

/**
 * Texels one splat occupies in the data texture, from its record width.
 *
 * Two for a capture with no view-dependent colour and three for one with the l=1 band. **A
 * function of the record rather than a constant**, because the width is the *file's* — a `SPLT`
 * block carries its own `wordsPerSplat` and `FORMAT.md` §4.7 designed it to grow exactly this way.
 */
export function splatTexels(wordsPerSplat: number): number {
  return wordsPerSplat / 4;
}

/**
 * Refuse a capture that will not fit, naming both numbers.
 *
 * **WebGL2 guarantees `MAX_TEXTURE_SIZE` of 2048**, which at two texels a splat is 2,097,152
 * splats — so the ceiling is stated here rather than re-derived by whoever hits it. A device
 * usually offers far more; the guaranteed floor is what a refusal has to be written against,
 * because a capture that loads on a workstation and refuses on a phone is worse than one that
 * refuses on both. **A capture with view-dependent colour is three texels a splat**, so its width
 * is 3,072 and a device at the guaranteed floor refuses it — which is the honest answer rather
 * than a silently narrower row.
 */
export function checkSplatCapacity(count: number, maxTextureSize: number, wordsPerSplat = 8): void {
  const rows = splatRows(count);
  const width = SPLAT_STRIDE * splatTexels(wordsPerSplat);
  if (rows <= maxTextureSize && width <= maxTextureSize) return;
  throw new Error(
    `a capture of ${count} splats needs ${width} by ${rows} texels and this device ` +
      `allows ${maxTextureSize}. At ${SPLAT_STRIDE} splats a row the ceiling is ` +
      `${SPLAT_STRIDE * maxTextureSize} splats.`,
  );
}

/** Words per row of the data texture: `SPLAT_STRIDE` splats of `wordsPerSplat` each. */
export function splatRowWords(wordsPerSplat: number): number {
  return SPLAT_STRIDE * wordsPerSplat;
}

/**
 * A source covering exactly `rows` whole rows of packed data, starting at `firstRow`.
 *
 * **Both backends need this and only one of them had it, which is how it was found.** A texture
 * upload takes a *rectangle*, and a capture whose splat count is not a multiple of
 * `SPLAT_STRIDE` ends in a partial row — so a plain `subarray` to the end of the packed data is
 * shorter than the rectangle it is being handed to. WebGPU refuses that at `submit` and takes the
 * command buffer with it; WebGL2 raises `INVALID_OPERATION` and *skips the upload*, which is
 * worse: the last row keeps whatever it held and the capture draws with up to a thousand splats
 * missing. Measured as 59,585 pixels between the two backends on a streaming load, at the last
 * block and no earlier.
 *
 * Copies only when the tail is short, which is at most once per capture and at most one row —
 * 32 KB. The whole-row case is the common one and is a view.
 */
export function splatRowSource(
  packed: Uint32Array,
  firstRow: number,
  rows: number,
  wordsPerSplat = 8,
): Uint32Array {
  const rowWords = splatRowWords(wordsPerSplat);
  const from = firstRow * rowWords;
  const needed = rows * rowWords;
  if (from + needed <= packed.length) return packed.subarray(from, from + needed);
  const padded = new Uint32Array(needed);
  padded.set(packed.subarray(from, Math.min(packed.length, from + needed)));
  return padded;
}
