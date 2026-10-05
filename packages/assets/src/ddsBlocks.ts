/**
 * A block-compressed DDS kept as it was authored: its blocks, untouched, and every mip level its
 * author stored, ready for a `CODEC_BC` payload.
 *
 * **Why keep them rather than decode them.** A BC7 texture is a byte a texel on the GPU where RGBA
 * is four, and its chain is the one its author built — often filtered with care a box filter does
 * not take, and for a normal map renormalised at every level. Decoding to RGBA and letting the
 * engine generate mips throws both away, and costs a phone's memory and a desktop's bandwidth for
 * the privilege. Where a device cannot sample a format, the loader decodes the same blocks there.
 *
 * **What it refuses, so the baker can fall back to decoding level 0:** a chain longer than the
 * image has levels for, a chain whose bytes stop before its last level, a volume texture (each of
 * whose levels holds several slices, so its layout is not a chain of images), and an uncompressed
 * surface, which has no blocks to keep. Bytes after the last level are left where they are; a
 * classic cube map's other five faces are such bytes, so its first face is what is kept.
 */
import { bcChainLength, bcLevelBytes, DrftError } from '@driftengine/drft';
import type { BcImage } from '@driftengine/drft';

import { DDPF_FOURCC, HEADER_BYTES, isDds, readDdsSurface } from './ddsHeader.ts';

/** `DDSCAPS2_VOLUME`: each level is a stack of slices rather than one image. */
const DDSCAPS2_VOLUME = 0x200000;

/** The surface's blocks and stored levels, as views over `bytes`. */
export function ddsBlocks(bytes: Uint8Array): BcImage {
  if (!isDds(bytes)) throw new DrftError('dds: these bytes do not begin "DDS "');
  if (bytes.length < HEADER_BYTES) {
    throw new DrftError('dds: the file is shorter than its own header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if ((view.getUint32(80, true) & DDPF_FOURCC) === 0) {
    throw new DrftError('dds: this surface is uncompressed, so it has no blocks to keep');
  }
  if ((view.getUint32(112, true) & DDSCAPS2_VOLUME) !== 0) {
    throw new DrftError(
      'dds: this is a volume texture, whose levels are stacks of slices rather than a chain',
    );
  }
  const surface = readDdsSurface(bytes, view);
  const { format, width, height, mipCount } = surface;
  const most = bcChainLength(width, height);
  if (mipCount > most) {
    throw new DrftError(
      `dds: ${surface.named} declares ${mipCount} levels for a ${width}x${height} image, which ` +
        `has at most ${most}`,
    );
  }
  const levels: Uint8Array[] = [];
  let at = surface.dataAt;
  for (let i = 0; i < mipCount; i++) {
    const size = bcLevelBytes(format, width, height, i);
    if (at + size > bytes.length) {
      throw new DrftError(
        `dds: level ${i} of ${mipCount} needs ${size} bytes and ${Math.max(0, bytes.length - at)} ` +
          'are left',
      );
    }
    levels.push(bytes.subarray(at, at + size));
    at += size;
  }
  return { format, srgb: surface.srgb, width, height, levels };
}
