/**
 * A `CODEC_BC` texture payload: which block format, what colour space its author declared, and
 * every stored mip level, largest first.
 *
 * **The layout** (FORMAT.md §4.5, 1.24), little-endian after the `TEXS` prefix that already carries
 * the codec, width and height:
 *
 *     u32 format   the format's own digit: 1, 2, 3, 4, 5 or 7 for BC1 to BC7
 *     u32 flags    bit 0: the author declared the texels sRGB
 *     u32 levels   how many mip levels follow, 1 to the full chain
 *     u32 0        reserved
 *     ...          each level's blocks, back to back, largest first
 *
 * **A level's size is derived, never stored.** Level `i` is `max(1, width >> i)` by
 * `max(1, height >> i)` texels, rounded up to whole 4x4 blocks — so a level smaller than a block
 * still costs one, which is how every DDS writer and every GPU lays them out. Storing the sizes
 * would be a second statement of the same fact, free to disagree with the first.
 *
 * **What it gives up**: a chain is whole levels from the top. A file that wanted to drop its top
 * level to save bytes has to say a smaller width and height, which is also what it then is.
 *
 * Unknown flag bits are ignored, which is rule 4 of the compatibility contract; a format number
 * this reader does not know is refused by name. A signed or HDR format would be a new number rather
 * than a flag, because a decoder that ignored it would produce wrong values rather than none.
 */
import { BC_BLOCK_BYTES, DrftError } from './drftFormat.ts';
import type { BcFormat } from './drftFormat.ts';

/** A block-compressed image, as a `CODEC_BC` payload holds it. */
export interface BcImage {
  readonly format: BcFormat;
  /**
   * What the author's header said of its texels. How a material slot samples them is still the
   * renderer's decision, as for every other codec: a colour map is read as sRGB and a normal map as
   * linear whatever its file claimed, so this is the author's statement rather than an instruction.
   */
  readonly srgb: boolean;
  readonly width: number;
  readonly height: number;
  /** Level 0 first. Views over the payload when read, never copies. */
  readonly levels: readonly Uint8Array[];
}

const HEADER_BYTES = 16;
const FLAG_SRGB = 1;

const FORMAT_NUMBER: Readonly<Record<BcFormat, number>> = {
  bc1: 1,
  bc2: 2,
  bc3: 3,
  bc4: 4,
  bc5: 5,
  bc7: 7,
};
const FORMAT_OF: Readonly<Record<number, BcFormat>> = {
  1: 'bc1',
  2: 'bc2',
  3: 'bc3',
  4: 'bc4',
  5: 'bc5',
  7: 'bc7',
};

/** How many levels a full chain from `width` by `height` down to 1x1 has. */
export function bcChainLength(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

/** The bytes level `level` of a `width` by `height` surface takes in `format`. */
export function bcLevelBytes(
  format: BcFormat,
  width: number,
  height: number,
  level: number,
): number {
  const w = Math.max(1, width >> level);
  const h = Math.max(1, height >> level);
  return Math.ceil(w / 4) * Math.ceil(h / 4) * BC_BLOCK_BYTES[format];
}

/** The payload for `image`. Refuses a level whose size is not the one its position requires. */
export function writeBcPayload(image: BcImage): Uint8Array {
  const { format, width, height, levels } = image;
  checkChain(levels.length, width, height);
  let total = HEADER_BYTES;
  for (let i = 0; i < levels.length; i++) {
    const want = bcLevelBytes(format, width, height, i);
    const level = levels[i] as Uint8Array;
    if (level.length !== want) {
      throw new DrftError(
        `bc: level ${i} of a ${width}x${height} ${format.toUpperCase()} image is ${want} bytes, and ` +
          `${level.length} were given`,
      );
    }
    total += want;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, FORMAT_NUMBER[format], true);
  view.setUint32(4, image.srgb ? FLAG_SRGB : 0, true);
  view.setUint32(8, levels.length, true);
  let at = HEADER_BYTES;
  for (const level of levels) {
    out.set(level, at);
    at += level.length;
  }
  return out;
}

/** A payload read back, its levels as views over `bytes`. */
export function readBcPayload(width: number, height: number, bytes: Uint8Array): BcImage {
  if (bytes.length < HEADER_BYTES) {
    throw new DrftError(`bc: a payload of ${bytes.length} bytes is shorter than its header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const number = view.getUint32(0, true);
  const format = FORMAT_OF[number];
  if (format === undefined) {
    throw new DrftError(
      `bc: block format ${number} is not one this reader knows; it reads 1, 2, 3, 4, 5 and 7 ` +
        '(BC1 to BC5 and BC7)',
    );
  }
  const count = view.getUint32(8, true);
  checkChain(count, width, height);
  let needed = HEADER_BYTES;
  for (let i = 0; i < count; i++) needed += bcLevelBytes(format, width, height, i);
  if (bytes.length < needed) {
    throw new DrftError(
      `bc: ${count} levels of a ${width}x${height} ${format.toUpperCase()} image needs ` +
        `${needed} bytes and the payload is ${bytes.length}`,
    );
  }
  const levels: Uint8Array[] = [];
  let at = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const size = bcLevelBytes(format, width, height, i);
    levels.push(bytes.subarray(at, at + size));
    at += size;
  }
  return { format, srgb: (view.getUint32(4, true) & FLAG_SRGB) !== 0, width, height, levels };
}

function checkChain(count: number, width: number, height: number): void {
  const most = bcChainLength(width, height);
  if (width < 1 || height < 1 || count < 1 || count > most) {
    throw new DrftError(
      `bc: ${count} levels for a ${width}x${height} image, which has at least 1 and at most ${most}`,
    );
  }
}
