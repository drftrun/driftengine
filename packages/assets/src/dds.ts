/**
 * DDS surfaces to RGBA: BC1, BC2, BC3 and BC5 in either header spelling, and the uncompressed
 * layouts, by the masks their own header carries.
 *
 * **It exists because a third of a shipped vehicle's textures are in it.** The car this was built
 * against carries 81 textures and 34 of them are DDS — 25 DXT5 and 9 DXT1 — which are its paint,
 * its interior and most of its normal maps. `imageInfo.ts` identifies PNG, JPEG and WEBP, so
 * without this the model imports correctly shaped and visibly half-painted.
 *
 * **It runs in the baker and never in a frame.** RGBA is larger than the compressed source it came
 * from, and the bake re-encodes to whatever the texture pipeline wants; nothing ships a block
 * decoder into a running game. That is what makes the cost acceptable and it is the only reason
 * decoding to RGBA rather than uploading the blocks directly is the right call here.
 *
 * **Only the mips are dropped, deliberately.** A DDS carries a full chain and the container
 * generates its own, so decoding level 0 and discarding the rest is not a loss — it is declining
 * to carry two answers to the same question.
 *
 * **Both header spellings, as of 3.30.2.** A `DX10` header names the format in a 20-byte extension
 * rather than in the four characters at byte 84, and the blocks behind it are the same blocks. This
 * reader took the classic spelling and refused the other, which cost one consumer 20 textures of a
 * single car — its paint, its wheels, its lamps, its plate and seven interior maps — and cost them
 * as a *lighting* bug rather than as a missing texture: their baker substitutes a 1x1 white pixel,
 * and white in an ORM map is roughness 1 **and** metallic 1, which in the flat shader leaves no
 * diffuse and no sun term at all. The bodywork became a blurred mirror of the field it was parked
 * in, and the report said so in those words.
 *
 * What it refuses, by name: BC7, BC6H, BC4, signed BC5, cube maps, arrays and volumes. A format
 * identified and declined is worth more than one half-decoded, which is `recognise.ts`'s principle
 * applied one level down — and the last three of those are refused *because* a classic header has
 * no way to state them, so accepting one would answer with a picture instead of an error.
 */

import { DrftError } from '@driftengine/drft';

const HEADER_BYTES = 128;
/** `DDS_HEADER_DXT10`: the extension a `DX10` FourCC puts between the header and the surface. */
const DX10_EXTENSION_BYTES = 20;
/** `DDPF_FOURCC`: the pixel format names a compression rather than describing channels. */
const DDPF_FOURCC = 0x4;

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

/** RGB565 to three bytes, with the low bits replicated so white stays white. */
function expand565(value: number): [number, number, number] {
  const r = (value >> 11) & 0x1f;
  const g = (value >> 5) & 0x3f;
  const b = value & 0x1f;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * One BC1 colour block into a 16-entry RGBA palette lookup.
 *
 * **The endpoint comparison chooses the mode and is the thing to get right.** With `c0 > c1` the
 * block has four opaque colours; otherwise it has three and its fourth index is transparent black.
 * A decoder that always takes the first branch produces an image that looks correct until
 * something relies on the punch-through alpha, which for foliage and grilles is everything.
 */
function decodeColourBlock(
  bytes: Uint8Array,
  at: number,
  out: Uint8Array,
  /**
   * Whether the block may take BC1's three-colour mode.
   *
   * **False for BC2 and BC3, whatever the endpoint order, and that is the correction of a real
   * defect.** Those two carry alpha in their own half of the block, so there is no index left over
   * to mean transparent and the colour half is always the four-colour opaque mode. This function
   * was reached unconditionally, so a BC3 block written with `c0 <= c1` decoded its fourth index to
   * transparent black instead of to the interpolant — invisible in every test here and in most real
   * data, because an encoder that has no reason to order the endpoints the low way usually does not.
   * Found while adding BC2, whose specification says the same thing about the same bytes.
   */
  punchthrough: boolean,
): void {
  const c0 = bytes[at]! | (bytes[at + 1]! << 8);
  const c1 = bytes[at + 2]! | (bytes[at + 3]! << 8);
  const [r0, g0, b0] = expand565(c0);
  const [r1, g1, b1] = expand565(c1);

  const palette = new Uint8Array(16);
  palette.set([r0, g0, b0, 255], 0);
  palette.set([r1, g1, b1, 255], 4);
  if (c0 > c1 || !punchthrough) {
    palette.set(
      [
        Math.round((2 * r0 + r1) / 3),
        Math.round((2 * g0 + g1) / 3),
        Math.round((2 * b0 + b1) / 3),
        255,
        Math.round((r0 + 2 * r1) / 3),
        Math.round((g0 + 2 * g1) / 3),
        Math.round((b0 + 2 * b1) / 3),
        255,
      ],
      8,
    );
  } else {
    palette.set(
      [
        Math.round((r0 + r1) / 2),
        Math.round((g0 + g1) / 2),
        Math.round((b0 + b1) / 2),
        255,
        0,
        0,
        0,
        0,
      ],
      8,
    );
  }

  const indices =
    bytes[at + 4]! | (bytes[at + 5]! << 8) | (bytes[at + 6]! << 16) | (bytes[at + 7]! << 24);
  for (let texel = 0; texel < 16; texel++) {
    const index = (indices >>> (texel * 2)) & 0x3;
    out[texel * 4] = palette[index * 4]!;
    out[texel * 4 + 1] = palette[index * 4 + 1]!;
    out[texel * 4 + 2] = palette[index * 4 + 2]!;
    out[texel * 4 + 3] = palette[index * 4 + 3]!;
  }
}

/**
 * One BC4-style eight-value block, which is what BC3's alpha and both halves of BC5 are.
 *
 * The same endpoint comparison as the colour block, and the same consequence for getting it
 * backwards: with `a0 > a1` there are six interpolants, and otherwise four plus a hard 0 and 255.
 */
function decodeAlphaBlock(
  bytes: Uint8Array,
  at: number,
  out: Uint8Array,
  stride: number,
  offset: number,
): void {
  const a0 = bytes[at]!;
  const a1 = bytes[at + 1]!;
  const values = new Uint8Array(8);
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
  let low = bytes[at + 2]! | (bytes[at + 3]! << 8) | (bytes[at + 4]! << 16);
  let high = bytes[at + 5]! | (bytes[at + 6]! << 8) | (bytes[at + 7]! << 16);
  for (let texel = 0; texel < 8; texel++) {
    out[texel * stride + offset] = values[low & 0x7]!;
    low >>>= 3;
  }
  for (let texel = 8; texel < 16; texel++) {
    out[texel * stride + offset] = values[high & 0x7]!;
    high >>>= 3;
  }
}

/**
 * BC2's alpha: eight bytes of explicit four-bit values, one nibble a texel, in row order.
 *
 * **No interpolation and no mode**, which is the whole difference from BC3 and the reason this is
 * four lines rather than the twenty above. Sixteen texels, low nibble of each byte first.
 *
 * The nibble is scaled by *replication* rather than by a shift: `0xF` has to come out 255 and not
 * 240, or a texel the author wrote as fully opaque arrives at 94% and every alpha test in the
 * pipeline sees a different picture from the one that was exported.
 */
function decodeExplicitAlpha(bytes: Uint8Array, at: number, out: Uint8Array): void {
  for (let texel = 0; texel < 16; texel++) {
    const byte = bytes[at + (texel >> 1)]!;
    const nibble = texel % 2 === 0 ? byte & 0xf : byte >> 4;
    out[texel * 4 + 3] = nibble * 17;
  }
}

/** The block formats this reader decodes, named once so nothing compares FourCC strings twice. */
type BlockFormat = 'bc1' | 'bc2' | 'bc3' | 'bc5';

/**
 * The DXGI block formats, as the same blocks this reader already decodes.
 *
 * **A `DX10` header states the format in a 20-byte extension instead of in the four characters at
 * byte 84, and that is the whole of the difference.** BC3 announced as `DXGI_FORMAT_BC3_UNORM_SRGB`
 * is bit for bit the BC3 announced as `DXT5`: the same blocks, the same mip chain, and sRGB is a
 * statement about how the values are *read* rather than about how they are stored. Measured from
 * outside on one bundle's paint texture — 5,592,580 bytes against 5,592,560 for the classic
 * spelling of the same 2048² chain, which is 148 + 5,592,432 against 128 + 5,592,432.
 *
 * The typeless and sRGB spellings sit beside the plain `UNORM` ones for that reason.
 *
 * **What is deliberately absent.** BC4 (79–81), which this reader does not decode at all; and
 * `BC5_SNORM` (84), whose values are signed — mapping it would decode to wrong numbers rather than
 * to an error, which is the one failure this file is written to avoid.
 */
const DXGI_BLOCK: Readonly<Record<number, BlockFormat>> = {
  70: 'bc1',
  71: 'bc1',
  72: 'bc1',
  73: 'bc2',
  74: 'bc2',
  75: 'bc2',
  76: 'bc3',
  77: 'bc3',
  78: 'bc3',
  82: 'bc5',
  83: 'bc5',
};

const FOURCC_BLOCK: Readonly<Record<string, BlockFormat>> = {
  DXT1: 'bc1',
  DXT3: 'bc2',
  DXT5: 'bc3',
  ATI2: 'bc5',
  BC5U: 'bc5',
};

/** What a decoded surface is: level 0, RGBA, eight bits a channel. */
export interface DdsImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/**
 * Decode a DDS surface's level 0 into RGBA.
 *
 * A surface whose dimensions are not multiples of four is decoded block by block and cropped, which
 * is what the format itself does: the blocks cover a padded rectangle and the texels outside the
 * declared size are padding rather than image.
 */

/** `DDPF_ALPHAPIXELS`, `DDPF_RGB`, `DDPF_LUMINANCE`: what the pixel format says it describes. */
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;
/** `DDSD_PITCH`: the header's row stride is meant to be read rather than derived. */
const DDSD_PITCH = 0x8;

/**
 * One channel's mask turned into the shift and the scale that read it.
 *
 * **Scaled by replication rather than by a shift, which is the one place this goes quietly wrong.**
 * Five bits of `0x1F` is white; shifting it left by three gives 248, so a surface that should be
 * pure white comes back very slightly grey on every texel and nothing raises. Multiplying by
 * `255 / (2^bits - 1)` is the same thing replication does and is exact at both ends.
 */
function channelFromMask(mask: number): { shift: number; max: number; scale: number } | null {
  if (mask === 0) return null;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  for (let at = shift; at < 32 && ((mask >>> at) & 1) === 1; at += 1) bits += 1;
  const max = (1 << bits) - 1;
  return { shift, max, scale: 255 / max };
}

/** One channel out of a texel, as eight bits. */
function take(texel: number, channel: { shift: number; max: number; scale: number }): number {
  return Math.round(((texel >>> channel.shift) & channel.max) * channel.scale);
}

/**
 * An uncompressed surface into RGBA, by the masks its own header carries.
 *
 * **No per-format branch, because the masks are the format.** The six vehicle bundles this was
 * written against carry five shapes between them — 32-bit BGRA and RGBA, 24-bit BGR, and 8- and
 * 16-bit luminance with and without alpha — and one mask walk reads all five. A reader with a case
 * per layout is a reader with a case missing.
 *
 * **A luminance surface fills all three colour channels from the one it has**, which is what
 * `DDPF_LUMINANCE` means: a single-channel image is grey, not red.
 *
 * **A row stride is read where the header declares one.** Rows can be padded, and a decoder that
 * assumes `width * bytes` walks diagonally through a padded surface — an image that is recognisably
 * the right picture and progressively more sheared down the frame, which reads as a bad texture
 * rather than as a bad reader.
 */
function uncompressedToRgba(
  bytes: Uint8Array,
  view: DataView,
  width: number,
  height: number,
  flags: number,
): DdsImage {
  const bits = view.getUint32(88, true);
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) {
    throw new DrftError(
      `dds: this surface is ${bits} bits a texel, and 8, 16, 24 and 32 are what this reader walks.`,
    );
  }
  const bytesPerTexel = bits / 8;

  const luminance = (flags & DDPF_LUMINANCE) !== 0;
  const red = channelFromMask(view.getUint32(92, true));
  const green = luminance ? red : channelFromMask(view.getUint32(96, true));
  const blue = luminance ? red : channelFromMask(view.getUint32(100, true));
  const alpha =
    (flags & DDPF_ALPHAPIXELS) === 0 ? null : channelFromMask(view.getUint32(104, true));
  if (red === null) {
    throw new DrftError(
      'dds: this uncompressed surface declares no channel mask, so nothing says where its ' +
        'colours are. Convert it to PNG.',
    );
  }

  const declaredPitch = view.getUint32(20, true);
  const stride =
    (view.getUint32(8, true) & DDSD_PITCH) !== 0 && declaredPitch >= width * bytesPerTexel
      ? declaredPitch
      : width * bytesPerTexel;

  const needed = stride * (height - 1) + width * bytesPerTexel;
  if (bytes.length - HEADER_BYTES < needed) {
    throw new DrftError(
      `dds: the surface is short — ${width}x${height} at ${bits} bits a texel needs ${needed} ` +
        `bytes and ${bytes.length - HEADER_BYTES} follow the header.`,
    );
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = HEADER_BYTES + y * stride + x * bytesPerTexel;
      /* Little-endian, however many bytes wide, so one expression reads all four widths. */
      let texel = 0;
      for (let b = 0; b < bytesPerTexel; b++) texel |= bytes[at + b]! << (b * 8);
      texel >>>= 0;

      const to = (y * width + x) * 4;
      rgba[to] = take(texel, red);
      rgba[to + 1] = green === null ? 0 : take(texel, green);
      rgba[to + 2] = blue === null ? 0 : take(texel, blue);
      rgba[to + 3] = alpha === null ? 255 : take(texel, alpha);
    }
  }

  return { width, height, rgba };
}

/**
 * Which blocks the file holds, and where they start.
 *
 * **Two spellings of one thing.** A classic header names the format in the four characters at byte
 * 84 and the surface follows at 128; a `DX10` header puts `DX10` there instead and states the real
 * format in a 20-byte extension, so the surface starts at 148. Nothing else differs — the blocks
 * are the same blocks — which is why this resolves both to one name and one offset rather than
 * growing a second decoder.
 *
 * **What a `DX10` header can say that a reader must refuse.** `resourceDimension` other than 3
 * (`TEXTURE2D`), `miscFlag` bit 2 (a cube map) or an `arraySize` above 1. The classic header has no
 * way to state any of them, so taking one would hand the caller six faces or twenty slices claiming
 * to be a single surface — a picture rather than an error.
 */
function resolveSurface(
  bytes: Uint8Array,
  view: DataView,
  fourcc: string,
): { format: BlockFormat; dataAt: number } {
  if (fourcc !== 'DX10') {
    const format = FOURCC_BLOCK[fourcc];
    if (format === undefined) {
      throw new DrftError(
        `dds: "${fourcc}" is not a format this reader decodes. It reads BC1 (DXT1), BC2 (DXT3), ` +
          'BC3 (DXT5) and BC5 (ATI2). Convert the texture to PNG, or re-export it as one of those.',
      );
    }
    return { format, dataAt: HEADER_BYTES };
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

  const format = DXGI_BLOCK[dxgi];
  if (format === undefined) {
    throw new DrftError(
      `dds: DXGI format ${dxgi} is not one this reader decodes. It reads BC1, BC2, BC3 and BC5 ` +
        '(unsigned). Convert the texture to PNG, or re-export it as one of those.',
    );
  }
  return { format, dataAt };
}

export function ddsToRgba(bytes: Uint8Array): DdsImage {
  if (!isDds(bytes)) throw new DrftError('dds: these bytes do not begin "DDS "');
  if (bytes.length < HEADER_BYTES)
    throw new DrftError('dds: the file is shorter than its own header');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const pixelFlags = view.getUint32(80, true);
  const fourcc = String.fromCharCode(bytes[84]!, bytes[85]!, bytes[86]!, bytes[87]!);

  /*
   * A pixel format that describes channels rather than naming a compression. There is no block to
   * decode, so it is a bit count, four masks and a copy — and it is 289 of one consumer's 766
   * surfaces, which is why it stopped being worth refusing.
   */
  if ((pixelFlags & DDPF_FOURCC) === 0) {
    if ((pixelFlags & (DDPF_RGB | DDPF_LUMINANCE)) === 0) {
      throw new DrftError(
        `dds: this surface's pixel format declares flags ${pixelFlags} — neither a compression, ` +
          'nor RGB, nor luminance — so nothing says what its bytes hold. Convert it to PNG.',
      );
    }
    return uncompressedToRgba(bytes, view, width, height, pixelFlags);
  }

  const { format, dataAt } = resolveSurface(bytes, view, fourcc);
  const blockBytes = format === 'bc1' ? 8 : 16;

  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));
  const needed = blocksX * blocksY * blockBytes;
  if (bytes.length - dataAt < needed) {
    throw new DrftError(
      `dds: the surface is short — ${width}x${height} of ${fourcc} needs ${needed} bytes and ` +
        `${bytes.length - dataAt} follow the header.`,
    );
  }

  const rgba = new Uint8Array(width * height * 4);
  const block = new Uint8Array(16 * 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const at = dataAt + (by * blocksX + bx) * blockBytes;
      block.fill(0);
      if (format === 'bc1') {
        decodeColourBlock(bytes, at, block, true);
      } else if (format === 'bc2') {
        /* Eight bytes of explicit alpha, then a colour block that is always four-colour. */
        decodeColourBlock(bytes, at + 8, block, false);
        decodeExplicitAlpha(bytes, at, block);
      } else if (format === 'bc3') {
        decodeColourBlock(bytes, at + 8, block, false);
        decodeAlphaBlock(bytes, at, block, 4, 3);
      } else {
        /*
         * BC5 is two BC4 blocks, red then green, and it is how a normal map is stored. Blue is
         * left at zero rather than reconstructed: `z = sqrt(1 - x² - y²)` belongs in the shader
         * that consumes the map, where the reconstruction can use the same convention the
         * renderer's own tangent basis does.
         */
        decodeAlphaBlock(bytes, at, block, 4, 0);
        decodeAlphaBlock(bytes, at + 8, block, 4, 1);
        for (let texel = 0; texel < 16; texel++) block[texel * 4 + 3] = 255;
      }

      for (let ty = 0; ty < 4; ty++) {
        const y = by * 4 + ty;
        if (y >= height) break;
        for (let tx = 0; tx < 4; tx++) {
          const x = bx * 4 + tx;
          if (x >= width) break;
          const from = (ty * 4 + tx) * 4;
          const to = (y * width + x) * 4;
          rgba[to] = block[from]!;
          rgba[to + 1] = block[from + 1]!;
          rgba[to + 2] = block[from + 2]!;
          rgba[to + 3] = block[from + 3]!;
        }
      }
    }
  }

  return { width, height, rgba };
}
