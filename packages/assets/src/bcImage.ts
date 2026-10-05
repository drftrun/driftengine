/**
 * Block-compressed texels decoded into an ordinary image: what a PNG of them has to hold.
 *
 * **Not what a GPU samples, on purpose.** `decodeBc` returns what a device would — BC4 as red alone,
 * BC5 as red and green with blue at zero — because the loader's fallback must look like a compressed
 * upload. A baked image is read later as an image, by a slot that reads three channels, so the two
 * formats that store fewer are completed here: BC4's one value fills all three, as a luminance
 * surface does, and BC5's missing z is rebuilt from the two it has.
 *
 * Shared by the DDS reader and the baker's texture pass, which decode the same blocks for the same
 * reason. Runs in the baker, so it allocates the image it returns.
 */
import type { BcFormat } from '@driftengine/drft';

import { decodeBc } from './bcDecode.ts';

/** `blocks` as an RGBA image, eight bits a channel, every channel meaning what an image's does. */
export function decodeBcImage(
  format: BcFormat,
  width: number,
  height: number,
  blocks: Uint8Array,
): Uint8Array {
  const rgba = decodeBc(format, width, height, blocks);
  if (format === 'bc5') rebuildNormalZ(rgba);
  if (format === 'bc4') greyFromRed(rgba);
  return rgba;
}

/**
 * BC5 is two BC4 blocks, red then green, and it is how a normal map is stored: x and y, with z
 * implied by the normal's unit length. **A baked image has three channels and the lit shader reads
 * three**, so z is rebuilt here as `(√(1 − x² − y²) + 1) / 2`. Until 4.8.4 the DDS reader said z
 * belonged in the shader that consumes the map, and no shader rebuilt it: every BC5 normal map baked
 * to PNG arrived with blue at zero, a normal lying in the surface it was meant to stand out of.
 *
 * Outside the unit disc — compression error at a grazing normal — z is clamped to zero rather than
 * reflected, which would turn the normal back to face the viewer.
 *
 * What it gives up: a BC5 surface that is not a normal map gets a blue channel derived as though it
 * were. Red and green are untouched, so anything reading the two channels it stored loses nothing.
 */
function rebuildNormalZ(rgba: Uint8Array): void {
  for (let at = 0; at < rgba.length; at += 4) {
    const x = ((rgba[at] as number) / 255) * 2 - 1;
    const y = ((rgba[at + 1] as number) / 255) * 2 - 1;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    rgba[at + 2] = Math.round((z * 0.5 + 0.5) * 255);
  }
}

/** BC4 is one channel, and a one-channel image is grey. */
function greyFromRed(rgba: Uint8Array): void {
  for (let at = 0; at < rgba.length; at += 4) {
    rgba[at + 1] = rgba[at] as number;
    rgba[at + 2] = rgba[at] as number;
  }
}
