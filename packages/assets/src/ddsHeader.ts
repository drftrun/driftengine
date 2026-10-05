/**
 * A DDS header, read as far as which blocks follow it: the block format and the colour space its
 * author declared, in either header spelling, the size, the stored mip count, and where the surface
 * starts. Shared by `dds.ts`, which decodes the blocks, and `ddsBlocks.ts`, which keeps them.
 *
 * **Two spellings of one thing.** A classic header names the format in the four characters at byte
 * 84 and the surface follows at 128; a `DX10` header puts `DX10` there instead and states the real
 * format in a 20-byte extension, so the surface starts at 148. Nothing else differs — the blocks are
 * the same blocks — which is why both resolve to one name and one offset.
 *
 * What it refuses, by name: BC6H, signed BC4 and BC5, the premultiplied DXT2 and DXT4, and from a
 * `DX10` header a cube map, an array or anything but a plain 2D texture. A format identified and
 * declined is worth more than one half-decoded, which is `recognise.ts`'s principle applied one
 * level down.
 */
import { DrftError } from '@driftengine/drft';
import type { BcFormat } from '@driftengine/drft';

export const HEADER_BYTES = 128;
/** `DDS_HEADER_DXT10`: the extension a `DX10` FourCC puts between the header and the surface. */
const DX10_EXTENSION_BYTES = 20;
/** `DDPF_FOURCC`: the pixel format names a compression rather than describing channels. */
export const DDPF_FOURCC = 0x4;

/** Whether these bytes are a DDS at all. The magic, and nothing inferred from a file name. */
export function isDds(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x44 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x20
  );
}

/**
 * The DXGI block formats, and which of them declare sRGB.
 *
 * **sRGB is a statement about how the values are *read* rather than about how they are stored.**
 * BC3 announced as `DXGI_FORMAT_BC3_UNORM_SRGB` is bit for bit the BC3 announced as `DXT5`: the
 * same blocks and the same mip chain. Measured from outside on one bundle's paint texture —
 * 5,592,580 bytes against 5,592,560 for the classic spelling of the same 2048² chain, which is
 * 148 + 5,592,432 against 128 + 5,592,432. The typeless spellings read as linear.
 *
 * **What is deliberately absent.** `BC4_SNORM` (81) and `BC5_SNORM` (84), whose values are signed,
 * and BC6H (94–96), whose values are half floats — mapping any of them would decode to wrong numbers
 * rather than to an error, which is the one failure this reader is written to avoid.
 */
const DXGI_BLOCK: Readonly<Record<number, readonly [BcFormat, boolean]>> = {
  70: ['bc1', false],
  71: ['bc1', false],
  72: ['bc1', true],
  73: ['bc2', false],
  74: ['bc2', false],
  75: ['bc2', true],
  76: ['bc3', false],
  77: ['bc3', false],
  78: ['bc3', true],
  79: ['bc4', false],
  80: ['bc4', false],
  82: ['bc5', false],
  83: ['bc5', false],
  97: ['bc7', false],
  98: ['bc7', false],
  99: ['bc7', true],
};

/** The classic spellings. BC7 has none: only a `DX10` header can name it. */
const FOURCC_BLOCK: Readonly<Record<string, BcFormat>> = {
  DXT1: 'bc1',
  DXT3: 'bc2',
  DXT5: 'bc3',
  ATI1: 'bc4',
  BC4U: 'bc4',
  ATI2: 'bc5',
  BC5U: 'bc5',
};

/** What a block-compressed DDS holds, read from its header alone. */
export interface DdsSurface {
  readonly format: BcFormat;
  readonly srgb: boolean;
  readonly width: number;
  readonly height: number;
  /**
   * The levels the header says follow. Zero is read as one, which is what Microsoft's own loader
   * does: many writers leave the count zero, and its flag unset, on a surface with no chain.
   */
  readonly mipCount: number;
  /** Where level 0's first block starts. */
  readonly dataAt: number;
  /** How the header named the format, for a message: a FourCC, or `DXGI <n>`. */
  readonly named: string;
}

/**
 * The surface a block-compressed DDS declares. The caller has checked the magic, the length of the
 * classic header and that the pixel format names a compression.
 *
 * **What a `DX10` header can say that a reader must refuse.** `resourceDimension` other than 3
 * (`TEXTURE2D`), `miscFlag` bit 2 (a cube map) or an `arraySize` above 1. Taking one would hand the
 * caller six faces or twenty slices claiming to be a single surface — a picture rather than an
 * error.
 */
export function readDdsSurface(bytes: Uint8Array, view: DataView): DdsSurface {
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const mipCount = Math.max(1, view.getUint32(28, true));
  const fourcc = String.fromCharCode(
    bytes[84] as number,
    bytes[85] as number,
    bytes[86] as number,
    bytes[87] as number,
  );
  if (fourcc !== 'DX10') {
    const format = FOURCC_BLOCK[fourcc];
    if (format === undefined) {
      throw new DrftError(
        `dds: "${fourcc}" is not a format this reader decodes. It reads BC1 (DXT1), BC2 (DXT3), ` +
          'BC3 (DXT5), BC4 (ATI1) and BC5 (ATI2), and BC7 behind a DX10 header. Convert the ' +
          'texture to PNG, or re-export it as one of those.',
      );
    }
    return { format, srgb: false, width, height, mipCount, dataAt: HEADER_BYTES, named: fourcc };
  }

  const dataAt = HEADER_BYTES + DX10_EXTENSION_BYTES;
  if (bytes.length < dataAt) {
    throw new DrftError(
      'dds: a DX10 header is declared and the twenty-byte extension is not there',
    );
  }
  const dxgi = view.getUint32(HEADER_BYTES, true);
  const dimension = view.getUint32(HEADER_BYTES + 4, true);
  const miscFlag = view.getUint32(HEADER_BYTES + 8, true);
  const arraySize = view.getUint32(HEADER_BYTES + 12, true);
  if (dimension !== 3) {
    throw new DrftError(
      `dds: this DX10 surface declares resourceDimension ${dimension}, and only 3 (a plain 2D ` +
        'texture) is read here. A 1D or volume texture is a different thing wearing the same header.',
    );
  }
  if ((miscFlag & 0x4) !== 0) {
    throw new DrftError('dds: this is a cube map, and only a plain 2D texture is read here.');
  }
  if (arraySize > 1) {
    throw new DrftError(
      `dds: this is a texture array of ${arraySize}, and only a plain 2D texture is read here.`,
    );
  }
  const entry = DXGI_BLOCK[dxgi];
  if (entry === undefined) {
    throw new DrftError(
      `dds: DXGI format ${dxgi} is not one this reader decodes. It reads BC1 to BC5 and BC7, ` +
        'unsigned. Convert the texture to PNG, or re-export it as one of those.',
    );
  }
  const [format, srgb] = entry;
  return { format, srgb, width, height, mipCount, dataAt, named: `DXGI ${dxgi}` };
}
