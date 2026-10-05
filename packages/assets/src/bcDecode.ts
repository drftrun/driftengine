/**
 * Block-compressed texels to RGBA: BC1, BC2, BC3, BC4, BC5 and BC7.
 *
 * **Two callers, one decoder.** The baker turns a DDS it is told to re-encode into RGBA here, and the
 * loader decodes a container's BC payload here on a device that cannot sample the format — most
 * phones, which have ASTC and ETC2 instead. Both must read a block the same way, so the block
 * routines live in one place rather than in the DDS reader that grew them first.
 *
 * **What a channel the format does not store reads as** is what a GPU returns for it, so a texture
 * looks the same whether it was uploaded compressed or decoded here: BC4 is `(r, 0, 0, 255)` and BC5
 * `(r, g, 0, 255)`. A BC5 normal map therefore arrives with blue at zero on both paths, and the lit
 * shader rebuilds z from the two it has.
 *
 * **What it gives up.** BC1 to BC5 interpolants are rounded here where some decoders truncate, so a
 * texel may differ by one from another decoder's; the format allows either, and hardware differs too.
 * BC7 is defined exactly and decodes to the byte, in `bc7Decode.ts`.
 *
 * Runs off the frame, in the baker or the loader's worker, but a phone decodes every block of every
 * texture through here at load, so the per-block scratch lives at module scope.
 */
import type { BcFormat } from '@driftengine/drft';
import { BC_BLOCK_BYTES, DrftError } from '@driftengine/drft';

import { decodeBc7Block } from './bc7Decode.ts';

export type { BcFormat } from '@driftengine/drft';

/** A colour block's four entries, and a BC4 block's eight values, rewritten for every block. */
const PALETTE = new Uint8Array(16);
const VALUES = new Uint8Array(8);
const TEXELS = new Uint8Array(64);

/** RGB565 into the palette at `at`, opaque, with the low bits replicated so white stays white. */
function expand565(value: number, at: number): void {
  const r = (value >> 11) & 0x1f;
  const g = (value >> 5) & 0x3f;
  const b = value & 0x1f;
  PALETTE[at] = (r << 3) | (r >> 2);
  PALETTE[at + 1] = (g << 2) | (g >> 4);
  PALETTE[at + 2] = (b << 3) | (b >> 2);
  PALETTE[at + 3] = 255;
}

/**
 * One BC1 colour block into sixteen RGBA texels.
 *
 * **The endpoint comparison chooses the mode and is the thing to get right.** With `c0 > c1` the
 * block has four opaque colours; otherwise it has three and its fourth index is transparent black.
 * A decoder that always takes the first branch produces an image that looks correct until
 * something relies on the punch-through alpha, which for foliage and grilles is everything.
 *
 * `punchthrough` is false for BC2 and BC3, whatever the endpoint order: those carry alpha in their
 * own half of the block, so there is no index left over to mean transparent and the colour half is
 * always the four-colour opaque mode. That was a real defect once: reached unconditionally, a BC3
 * block written with `c0 <= c1` decoded its fourth index to transparent black — invisible in most
 * real data, because an encoder has no reason to order the endpoints the low way round.
 */
function decodeColourBlock(
  bytes: Uint8Array,
  at: number,
  out: Uint8Array,
  punchthrough: boolean,
): void {
  const c0 = (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
  const c1 = (bytes[at + 2] as number) | ((bytes[at + 3] as number) << 8);
  expand565(c0, 0);
  expand565(c1, 4);
  const four = c0 > c1 || !punchthrough;
  for (let c = 0; c < 3; c++) {
    const e0 = PALETTE[c] as number;
    const e1 = PALETTE[4 + c] as number;
    PALETTE[8 + c] = four ? Math.round((2 * e0 + e1) / 3) : Math.round((e0 + e1) / 2);
    PALETTE[12 + c] = four ? Math.round((e0 + 2 * e1) / 3) : 0;
  }
  PALETTE[11] = 255;
  PALETTE[15] = four ? 255 : 0;

  const indices =
    (bytes[at + 4] as number) |
    ((bytes[at + 5] as number) << 8) |
    ((bytes[at + 6] as number) << 16) |
    ((bytes[at + 7] as number) << 24);
  for (let texel = 0; texel < 16; texel++) {
    const index = (indices >>> (texel * 2)) & 0x3;
    out[texel * 4] = PALETTE[index * 4] as number;
    out[texel * 4 + 1] = PALETTE[index * 4 + 1] as number;
    out[texel * 4 + 2] = PALETTE[index * 4 + 2] as number;
    out[texel * 4 + 3] = PALETTE[index * 4 + 3] as number;
  }
}

/**
 * One BC4-style eight-value block, which is what BC3's alpha and both halves of BC5 are, written
 * into channel `offset` of each texel `stride` bytes apart.
 *
 * The same endpoint comparison as the colour block: with `a0 > a1` there are six interpolants, and
 * otherwise four plus a hard 0 and 255.
 */
function decodeAlphaBlock(
  bytes: Uint8Array,
  at: number,
  out: Uint8Array,
  stride: number,
  offset: number,
): void {
  const a0 = bytes[at] as number;
  const a1 = bytes[at + 1] as number;
  const values = VALUES;
  values[0] = a0;
  values[1] = a1;
  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) values[i + 1] = Math.round(((7 - i) * a0 + i * a1) / 7);
  } else {
    for (let i = 1; i <= 4; i++) values[i + 1] = Math.round(((5 - i) * a0 + i * a1) / 5);
    values[6] = 0;
    values[7] = 255;
  }

  /* Six bytes of 3-bit indices, least significant first, as one 48-bit run. */
  let low =
    (bytes[at + 2] as number) |
    ((bytes[at + 3] as number) << 8) |
    ((bytes[at + 4] as number) << 16);
  let high =
    (bytes[at + 5] as number) |
    ((bytes[at + 6] as number) << 8) |
    ((bytes[at + 7] as number) << 16);
  for (let texel = 0; texel < 8; texel++) {
    out[texel * stride + offset] = values[low & 0x7] as number;
    low >>>= 3;
  }
  for (let texel = 8; texel < 16; texel++) {
    out[texel * stride + offset] = values[high & 0x7] as number;
    high >>>= 3;
  }
}

/**
 * BC2's alpha: eight bytes of explicit four-bit values, one nibble a texel, low nibble first.
 *
 * Scaled by *replication* rather than by a shift: `0xF` has to come out 255 and not 240, or a texel
 * the author wrote as fully opaque arrives at 94% and every alpha test sees a different picture.
 */
function decodeExplicitAlpha(bytes: Uint8Array, at: number, out: Uint8Array): void {
  for (let texel = 0; texel < 16; texel++) {
    const byte = bytes[at + (texel >> 1)] as number;
    const nibble = texel % 2 === 0 ? byte & 0xf : byte >> 4;
    out[texel * 4 + 3] = nibble * 17;
  }
}

/** One block of any format into sixteen RGBA texels. */
function decodeBlock(format: BcFormat, bytes: Uint8Array, at: number, out: Uint8Array): void {
  out.fill(0, 0, 64);
  if (format === 'bc1') {
    decodeColourBlock(bytes, at, out, true);
  } else if (format === 'bc2') {
    decodeColourBlock(bytes, at + 8, out, false);
    decodeExplicitAlpha(bytes, at, out);
  } else if (format === 'bc3') {
    decodeColourBlock(bytes, at + 8, out, false);
    decodeAlphaBlock(bytes, at, out, 4, 3);
  } else if (format === 'bc4') {
    decodeAlphaBlock(bytes, at, out, 4, 0);
    for (let t = 0; t < 16; t++) out[t * 4 + 3] = 255;
  } else if (format === 'bc5') {
    decodeAlphaBlock(bytes, at, out, 4, 0);
    decodeAlphaBlock(bytes, at + 8, out, 4, 1);
    for (let t = 0; t < 16; t++) out[t * 4 + 3] = 255;
  } else {
    decodeBc7Block(bytes, at, out);
  }
}

/**
 * A whole surface of blocks into RGBA, eight bits a channel, `width` by `height`. A surface that is
 * not a whole number of blocks is decoded block by block and cropped, which is what the format does:
 * the blocks cover a padded rectangle and the texels past the declared size are padding.
 */
export function decodeBc(
  format: BcFormat,
  width: number,
  height: number,
  blocks: Uint8Array,
  out: Uint8Array = new Uint8Array(width * height * 4),
): Uint8Array {
  const blockBytes = BC_BLOCK_BYTES[format];
  const across = Math.max(1, Math.ceil(width / 4));
  const down = Math.max(1, Math.ceil(height / 4));
  const needed = across * down * blockBytes;
  if (blocks.length < needed) {
    throw new DrftError(
      `bc: a ${width}x${height} ${format.toUpperCase()} surface needs ${needed} bytes of blocks and ` +
        `${blocks.length} were given`,
    );
  }
  const texels = TEXELS;
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      decodeBlock(format, blocks, (by * across + bx) * blockBytes, texels);
      for (let ty = 0; ty < 4; ty++) {
        const y = by * 4 + ty;
        if (y >= height) break;
        for (let tx = 0; tx < 4; tx++) {
          const x = bx * 4 + tx;
          if (x >= width) break;
          const from = (ty * 4 + tx) * 4;
          const to = (y * width + x) * 4;
          out[to] = texels[from] as number;
          out[to + 1] = texels[from + 1] as number;
          out[to + 2] = texels[from + 2] as number;
          out[to + 3] = texels[from + 3] as number;
        }
      }
    }
  }
  return out;
}
