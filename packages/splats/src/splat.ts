/** The `.splat` reader: thirty-two bytes a splat, and nothing else in the file. */

import { packSplats } from './splatData.ts';
import type { SplatData } from './splatData.ts';

/**
 * Position, scale, colour and rotation, in that order, little-endian.
 *
 * There is no header and no version. The format is a bare array of records, which is what makes
 * the length check below the only structural validation available.
 */
export const SPLAT_RECORD_BYTES = 32;

/**
 * Read a `.splat` capture.
 *
 * **The one thing worth knowing is the quaternion's encoding.** Rotation arrives as four bytes and
 * comes back as `(b - 128) / 128`, so a byte of 128 is zero and the representable range is roughly
 * −1 to +0.9922. `packSplats` normalises what it is handed, which is what makes that asymmetry
 * harmless: the quantised quaternion is a hair off unit length and the normalisation absorbs it.
 *
 * **The file stores wxyz and `SplatSource` takes xyzw**, so the reorder happens here, in the one
 * place the file's own order is on screen. Getting it wrong does not produce a refusal — it
 * produces a capture whose every splat is rotated to somewhere else, which reads as a smear.
 *
 * **Colour is already eight-bit and already linear**, so it divides by 255 and nothing else: there
 * is no logistic and no exponential here, unlike the `.ply` reader. That asymmetry is the format's
 * rather than a choice, and `packSplats` takes linear values from both.
 */
export function readSplat(buffer: ArrayBuffer): SplatData {
  const remainder = buffer.byteLength % SPLAT_RECORD_BYTES;
  if (remainder !== 0) {
    throw new Error(
      `a .splat file is a whole number of ${SPLAT_RECORD_BYTES}-byte records; this one is ` +
        `${buffer.byteLength} bytes, which leaves ${remainder} over. Either it is truncated or it ` +
        'is not a .splat.',
    );
  }

  const count = buffer.byteLength / SPLAT_RECORD_BYTES;
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const opacities = new Float32Array(count);

  for (let index = 0; index < count; index++) {
    const at = index * SPLAT_RECORD_BYTES;
    const p = index * 3;
    positions[p] = view.getFloat32(at, true);
    positions[p + 1] = view.getFloat32(at + 4, true);
    positions[p + 2] = view.getFloat32(at + 8, true);
    /* Linear already: this format stores the standard deviation, not its logarithm. */
    scales[p] = view.getFloat32(at + 12, true);
    scales[p + 1] = view.getFloat32(at + 16, true);
    scales[p + 2] = view.getFloat32(at + 20, true);

    colors[p] = (bytes[at + 24] ?? 0) / 255;
    colors[p + 1] = (bytes[at + 25] ?? 0) / 255;
    colors[p + 2] = (bytes[at + 26] ?? 0) / 255;
    opacities[index] = (bytes[at + 27] ?? 0) / 255;

    /* wxyz in the file, xyzw in `SplatSource`. See the header. */
    const r = index * 4;
    rotations[r] = ((bytes[at + 29] ?? 128) - 128) / 128;
    rotations[r + 1] = ((bytes[at + 30] ?? 128) - 128) / 128;
    rotations[r + 2] = ((bytes[at + 31] ?? 128) - 128) / 128;
    rotations[r + 3] = ((bytes[at + 28] ?? 128) - 128) / 128;
  }

  return packSplats({ count, positions, scales, rotations, colors, opacities });
}
