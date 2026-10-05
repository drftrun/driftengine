/**
 * DDS surfaces to RGBA: BC1 to BC5 and BC7 in either header spelling, and the uncompressed layouts,
 * by the masks their own header carries.
 *
 * **It exists because a third of a shipped vehicle's textures are in it.** The car this was built
 * against carries 81 textures and 34 of them are DDS — 25 DXT5 and 9 DXT1 — which are its paint,
 * its interior and most of its normal maps. `imageInfo.ts` identifies PNG, JPEG and WEBP, so
 * without this the model imports correctly shaped and visibly half-painted.
 *
 * **Since 4.8.4 the baker keeps a block-compressed DDS as blocks**, through `ddsBlocks.ts`, and this
 * is the path for what it cannot keep — an uncompressed surface, a chain it refuses — and for a bake
 * asked to decode. It decodes level 0 only: the container generates its own chain for an image it
 * did not receive one for.
 *
 * **Both header spellings, as of 3.30.2.** A `DX10` header names the format in a 20-byte extension
 * rather than in the four characters at byte 84, and the blocks behind it are the same blocks. This
 * reader took the classic spelling and refused the other, which cost one consumer 20 textures of a
 * single car — its paint, its wheels, its lamps, its plate and seven interior maps — and cost them
 * as a *lighting* bug rather than as a missing texture: their baker substitutes a 1x1 white pixel,
 * and white in an ORM map is roughness 1 **and** metallic 1, which in the flat shader leaves no
 * diffuse and no sun term at all. The bodywork became a blurred mirror of the field it was parked
 * in, and the report said so in those words. The header is `ddsHeader.ts`'s now, shared with the
 * reader that keeps the blocks.
 */

import { DrftError, BC_BLOCK_BYTES } from '@driftengine/drft';

import { decodeBcImage } from './bcImage.ts';
import { DDPF_FOURCC, HEADER_BYTES, isDds, readDdsSurface } from './ddsHeader.ts';

export { isDds } from './ddsHeader.ts';

/** What a decoded surface is: level 0, RGBA, eight bits a channel. */
export interface DdsImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

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
 * Decode a DDS surface's level 0 into RGBA.
 *
 * A surface whose dimensions are not multiples of four is decoded block by block and cropped, which
 * is what the format itself does: the blocks cover a padded rectangle and the texels outside the
 * declared size are padding rather than image.
 */
export function ddsToRgba(bytes: Uint8Array): DdsImage {
  if (!isDds(bytes)) throw new DrftError('dds: these bytes do not begin "DDS "');
  if (bytes.length < HEADER_BYTES)
    throw new DrftError('dds: the file is shorter than its own header');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const pixelFlags = view.getUint32(80, true);

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

  const { format, dataAt, named } = readDdsSurface(bytes, view);
  const needed =
    Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * BC_BLOCK_BYTES[format];
  if (bytes.length - dataAt < needed) {
    throw new DrftError(
      `dds: the surface is short — ${width}x${height} of ${named} needs ${needed} bytes and ` +
        `${bytes.length - dataAt} follow the header.`,
    );
  }

  return { width, height, rgba: decodeBcImage(format, width, height, bytes.subarray(dataAt)) };
}
