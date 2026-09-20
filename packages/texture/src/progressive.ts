/**
 * The order tiles are sent in, so a material is usable long before it is complete.
 *
 * **There is precedent in this repository and this follows it.** `drft/coarseFirst.ts` opens a
 * splat capture in a fourteenth of its bytes through a Morton quantisation and a bit-reversal
 * walk, and the principle is the same: a prefix of the stream should be spread over the whole
 * image rather than filling one corner of it.
 *
 * **Bit-reversal is what spreads it.** Counting 0, 1, 2, 3 fills left to right; counting with the
 * index's bits reversed visits 0, 4, 2, 6, 1, 5, 3, 7 — every prefix roughly uniform over the
 * range, so an interrupted download is a coarse version of the whole material rather than a sharp
 * version of part of it.
 */

function reverseBits(value: number, bits: number): number {
  let out = 0;
  for (let i = 0; i < bits; i += 1) out = (out << 1) | ((value >>> i) & 1);
  return out >>> 0;
}

/**
 * Fill `out` with the order to send `tileCount` tiles in. Returns how many were written.
 *
 * A permutation: every tile appears exactly once, which the test asserts because an ordering that
 * drops one is a material that never completes and never says why.
 */
export function progressiveOrder(tileCount: number, out: Uint32Array): number {
  if (tileCount <= 0) return 0;
  const bits = Math.max(1, Math.ceil(Math.log2(tileCount)));
  const span = 1 << bits;
  let written = 0;
  for (let i = 0; i < span; i += 1) {
    const tile = reverseBits(i, bits);
    /* The reversal walks a power-of-two range; anything past the real count is skipped. */
    if (tile < tileCount) {
      out[written] = tile;
      written += 1;
    }
  }
  return written;
}

/**
 * What level this many received bytes supports.
 *
 * Levels rise monotonically with bytes, which is what lets a loader show something immediately and
 * refine without ever going backwards.
 */
export function usableAt(
  bytesReceived: number,
  tileBytes: number,
  tileCount: number,
): { level: number; complete: boolean } {
  if (tileBytes <= 0 || tileCount <= 0) return { level: 0, complete: true };
  const tiles = Math.min(tileCount, Math.floor(bytesReceived / tileBytes));
  const complete = tiles >= tileCount;
  /* Each doubling of received tiles is one more level of detail. */
  const level = tiles <= 0 ? 0 : Math.floor(Math.log2(tiles)) + 1;
  return { level, complete };
}
