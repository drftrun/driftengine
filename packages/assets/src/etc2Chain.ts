/**
 * A decoded texture as ETC2 or EAC blocks with its whole chain, down to 1x1: what the loader's
 * encode worker makes of a BC texture on a device that samples ETC2 and not BC.
 *
 * **The format follows what the BC format stores**: BC4's one channel as `eac-r11` and BC5's two as
 * `eac-rg11`, so a roughness or normal map keeps eleven bits a channel where colour would round it
 * to a brightness step; every colour format as `etc2-rgb8`, or `etc2-rgba8` where any texel is less
 * than opaque. **Opaque is 254 and above**, because a BC7 encoder storing an opaque image in its
 * mode with a seven-bit alpha and a shared low bit can land every texel on 254, and that is no
 * reason to spend twice the memory: what it gives up is an alpha of 254 read as 255, a 0.4% change
 * no blend or cutout can show. **And what the choice gives up** is `etc2-rgb8a1`, half the size of
 * `etc2-rgba8` for a cutout whose alpha is only ever 0 or 255, which needs ETC2's punch-through
 * modes and this encoder writes none of them.
 *
 * **Each level is a box average of the one above, colour in linear light where the texture is
 * colour**, as a GPU builds a chain for an sRGB image: averaged as stored, a fine bright detail on
 * a dark ground fades darker with distance than it should. Alpha and data are averaged as stored.
 * Allocates every level, once; this runs in a worker, once a texture.
 */
import type { BcFormat } from '@driftengine/drft';

import { encodeEtc2 } from './etc2Encode.ts';
import type { Etc2Format } from './etc2Encode.ts';

/** The ETC2 or EAC format a BC texture decoded to `rgba` becomes. */
export function etc2FormatFor(source: BcFormat, rgba: Uint8Array): Etc2Format {
  if (source === 'bc4') return 'eac-r11';
  if (source === 'bc5') return 'eac-rg11';
  for (let at = 3; at < rgba.length; at += 4) {
    if ((rgba[at] as number) < 254) return 'etc2-rgba8';
  }
  return 'etc2-rgb8';
}

/** `rgba` at `width` by `height`, and each level below it to 1x1, as `format` blocks. */
export function encodeEtc2Chain(
  format: Etc2Format,
  rgba: Uint8Array,
  width: number,
  height: number,
  srgb: boolean,
): Uint8Array[] {
  const levels: Uint8Array[] = [];
  let level = rgba;
  let w = width;
  let h = height;
  for (;;) {
    levels.push(encodeEtc2(format, level, w, h));
    if (w === 1 && h === 1) return levels;
    level = halve(level, w, h, srgb);
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}

/** Each eight-bit sRGB value in linear light. */
const LINEAR = new Float64Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  LINEAR[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The eight-bit sRGB value whose light is nearest `light`, found in `LINEAR` and not by a power. */
function fromLinear(light: number): number {
  let lo = 0;
  let hi = 255;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((LINEAR[mid] as number) <= light) lo = mid;
    else hi = mid;
  }
  return light - (LINEAR[lo] as number) <= (LINEAR[hi] as number) - light ? lo : hi;
}

/**
 * The next level down: each texel the average of the two by two above it, or of the one or two an
 * odd edge leaves. Colour in linear light where `srgb`; alpha, and every channel of data, as stored.
 */
export function halve(rgba: Uint8Array, width: number, height: number, srgb: boolean): Uint8Array {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(y * 2, height - 1);
    const y1 = Math.min(y * 2 + 1, height - 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(x * 2, width - 1);
      const x1 = Math.min(x * 2 + 1, width - 1);
      const a = (y0 * width + x0) * 4;
      const b = (y0 * width + x1) * 4;
      const c = (y1 * width + x0) * 4;
      const d = (y1 * width + x1) * 4;
      const to = (y * w + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const pa = rgba[a + channel] as number;
        const pb = rgba[b + channel] as number;
        const pc = rgba[c + channel] as number;
        const pd = rgba[d + channel] as number;
        out[to + channel] =
          srgb && channel < 3
            ? fromLinear(
                ((LINEAR[pa] as number) +
                  (LINEAR[pb] as number) +
                  (LINEAR[pc] as number) +
                  (LINEAR[pd] as number)) /
                  4,
              )
            : (pa + pb + pc + pd + 2) >> 2;
      }
    }
  }
  return out;
}
