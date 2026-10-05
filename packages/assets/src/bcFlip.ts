/**
 * A BC5 normal map's green turned over in its blocks — `255 − g` at every texel — without decoding.
 *
 * **Why in the blocks.** A DirectX normal map points green down where glTF points it up, and the
 * baker turns such a map over on the way in. For a PNG that is a pass over the texels; for BC5 the
 * same pass would mean decoding and re-encoding, and this engine has no encoder — so the map would
 * leave the bake uncompressed, and BC5 is what normal maps are stored as. Turning a BC4 half over
 * is exact in its own terms instead: swap the two endpoints and turn each over, then renumber the
 * indices so each texel names the value that is now its opposite.
 *
 * **Swapping keeps the mode**, which is the point of swapping: `a0 > a1` selects six interpolants
 * and `a0 ≤ a1` four plus a hard 0 and 255, and `255 − a1 > 255 − a0` exactly when `a0 > a1`.
 * Within a mode, index `i` of the interpolants counts from the first endpoint, so it becomes the
 * one counting the same distance from the other end; the hard 0 and 255 trade places.
 *
 * **What it gives up**: an interpolant that falls on a half rounds the same way both before and
 * after, so a texel at such a value lands one away from `255 − g`. That is inside the error the
 * format already carries. Runs in the baker, so it copies.
 */

/** Six-value mode: endpoints trade places, interpolant `i` becomes `9 − i`. */
const SIX = [1, 0, 7, 6, 5, 4, 3, 2];
/** Four-value mode: endpoints trade, interpolant `i` becomes `7 − i`, and 0 and 255 trade. */
const FOUR = [1, 0, 5, 4, 3, 2, 7, 6];

/** A copy of `blocks`, a level of BC5, with every block's green half turned over. */
export function flipBc5Green(blocks: Uint8Array): Uint8Array {
  const out = new Uint8Array(blocks);
  for (let at = 8; at + 8 <= out.length; at += 16) flipHalf(out, at);
  return out;
}

function flipHalf(bytes: Uint8Array, at: number): void {
  const a0 = bytes[at] as number;
  const a1 = bytes[at + 1] as number;
  const map = a0 > a1 ? SIX : FOUR;
  bytes[at] = 255 - a1;
  bytes[at + 1] = 255 - a0;
  /* Sixteen three-bit indices in two 24-bit runs, least significant first. */
  for (let half = 0; half < 2; half++) {
    const base = at + 2 + half * 3;
    let run =
      (bytes[base] as number) |
      ((bytes[base + 1] as number) << 8) |
      ((bytes[base + 2] as number) << 16);
    let flipped = 0;
    for (let texel = 0; texel < 8; texel++) {
      flipped |= (map[run & 7] as number) << (texel * 3);
      run >>>= 3;
    }
    bytes[base] = flipped & 0xff;
    bytes[base + 1] = (flipped >> 8) & 0xff;
    bytes[base + 2] = (flipped >> 16) & 0xff;
  }
}
