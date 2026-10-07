/**
 * KTX2 textures read as the blocks they carry, for `createSurfaceTexture`: a texture compressed
 * offline for the devices a game ships to — ASTC or ETC2 for a phone, BC for a desktop — goes up as
 * it was made, with its own chain, and nothing is decoded or encoded on the way. A game carrying a
 * phone's textures in the file is the answer to a device that cannot hold them all as RGBA even
 * for the moment `etc2Load.ts` re-encodes them in.
 *
 * **Uncompressed containers of 2D block textures only.** Refused, each by name: a supercompressed
 * file, since BasisLZ needs a transcoder and Zstandard or zlib an inflater, and this engine ships
 * neither — a texture tool writes the same blocks with supercompression off; a format no device
 * here samples as blocks — HDR BC6H, the signed BC4, BC5 and EAC, anything that is not blocks; and a
 * cube, an array or a volume, which a surface texture is none of.
 *
 * **BC1 with and without alpha are one format here**, as they are to WebGPU, so a texel a file
 * marked opaque stores in BC1's three-colour mode comes out transparent black rather than black.
 * What would make that wrong is a colour map leaning on that texel being opaque.
 *
 * The levels are views over `bytes`, not copies: the file lives as long as the source does, which is
 * until `createSurfaceTexture` has uploaded it.
 */
import { levelBytes } from '@driftengine/core';
import type { BlockFormat, CompressedTextureSource } from '@driftengine/core';

/** A KTX2 file's blocks, and the colour space its format names. */
export interface Ktx2Texture {
  /** The blocks, for `createSurfaceTexture` where `uploadsCompressed` says the device takes them. */
  readonly source: CompressedTextureSource;
  /** Whether the file's format is an sRGB one: the `colorSpace` to create the texture in. */
  readonly srgb: boolean;
}

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

const ASTC_SIZES = [
  '4x4',
  '5x4',
  '5x5',
  '6x5',
  '6x6',
  '8x5',
  '8x6',
  '8x8',
  '10x5',
  '10x6',
  '10x8',
  '10x10',
  '12x10',
  '12x12',
] as const;

/** Each Vulkan block format this engine samples, as its own format and whether it is sRGB. */
const VK_FORMATS = new Map<number, readonly [BlockFormat, boolean]>([
  [131, ['bc1', false]],
  [132, ['bc1', true]],
  [133, ['bc1', false]],
  [134, ['bc1', true]],
  [135, ['bc2', false]],
  [136, ['bc2', true]],
  [137, ['bc3', false]],
  [138, ['bc3', true]],
  [139, ['bc4', false]],
  [141, ['bc5', false]],
  [145, ['bc7', false]],
  [146, ['bc7', true]],
  [147, ['etc2-rgb8', false]],
  [148, ['etc2-rgb8', true]],
  [149, ['etc2-rgb8a1', false]],
  [150, ['etc2-rgb8a1', true]],
  [151, ['etc2-rgba8', false]],
  [152, ['etc2-rgba8', true]],
  [153, ['eac-r11', false]],
  [155, ['eac-rg11', false]],
  ...ASTC_SIZES.flatMap((size, i): [number, readonly [BlockFormat, boolean]][] => [
    [157 + i * 2, [`astc-${size}`, false]],
    [158 + i * 2, [`astc-${size}`, true]],
  ]),
]);

/** The block formats a file may name that this engine does not sample, and why. */
const REFUSED: ReadonlyMap<number, string> = new Map([
  [140, 'signed BC4'],
  [142, 'signed BC5'],
  [143, 'HDR BC6H'],
  [144, 'signed HDR BC6H'],
  [154, 'signed EAC R11'],
  [156, 'signed EAC RG11'],
]);

const SUPERCOMPRESSION = ['', 'BasisLZ', 'Zstandard', 'zlib'];

/** `bytes` as a KTX2 file of one 2D block texture. Throws, naming the reason, on anything else. */
export function readKtx2(bytes: Uint8Array): Ktx2Texture {
  if (bytes.length < 80 || IDENTIFIER.some((byte, i) => bytes[i] !== byte)) {
    throw new Error('readKtx2: not a KTX2 file (its first twelve bytes are not the identifier)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number): number => view.getUint32(at, true);
  const u64 = (at: number): number => {
    if (u32(at + 4) !== 0) throw new Error('readKtx2: an offset past four gigabytes');
    return u32(at);
  };
  const vkFormat = u32(12);
  const width = u32(20);
  const height = u32(24);
  const depth = u32(28);
  const layers = u32(32);
  const faces = u32(36);
  const levelCount = Math.max(1, u32(40));
  const scheme = u32(44);

  if (scheme !== 0) {
    throw new Error(
      `readKtx2: the file is supercompressed with ${SUPERCOMPRESSION[scheme] ?? `scheme ${scheme}`}, ` +
        'which this engine does not undo; write it with supercompression off',
    );
  }
  const known = VK_FORMATS.get(vkFormat);
  if (known === undefined) {
    const named = REFUSED.get(vkFormat);
    throw new Error(
      named !== undefined
        ? `readKtx2: ${named} is not a format this engine samples`
        : `readKtx2: vkFormat ${vkFormat} is not a block format this engine samples`,
    );
  }
  if (faces !== 1) throw new Error(`readKtx2: a cube of ${faces} faces, not a 2D texture`);
  if (layers > 1) throw new Error(`readKtx2: an array of ${layers} layers, not a 2D texture`);
  if (depth > 0) throw new Error(`readKtx2: a volume ${depth} deep, not a 2D texture`);
  if (width === 0 || height === 0) throw new Error('readKtx2: a texture with no height is 1D');

  const [format, srgb] = known;
  const levels: Uint8Array[] = [];
  for (let level = 0; level < levelCount; level++) {
    const entry = 80 + level * 24;
    if (entry + 24 > bytes.length) throw new Error('readKtx2: the level index runs past the file');
    const offset = u64(entry);
    const length = u64(entry + 8);
    const expected = levelBytes(format, width, height, level);
    if (length !== expected) {
      throw new Error(
        `readKtx2: level ${level} of a ${width}x${height} ${format} texture is ${expected} bytes, ` +
          `and the file gives it ${length}`,
      );
    }
    if (offset + length > bytes.length) {
      throw new Error(`readKtx2: level ${level} runs past the end of the file`);
    }
    levels.push(bytes.subarray(offset, offset + length));
  }
  return { source: { format, width, height, levels }, srgb };
}
