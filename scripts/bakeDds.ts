/**
 * A DDS on its way into a bake: kept as its blocks and its stored chain by default, decoded to a
 * PNG when the bake asks (`--decode-dds`) or when the blocks cannot be kept.
 *
 * **Kept, since 4.8.4.** A `CODEC_BC` texture is uploaded as it is wherever a device samples the
 * format, so a BC7 map costs a byte a texel on the GPU rather than four and keeps the mip chain its
 * author built; a device that cannot sample it — most phones — decodes the same blocks at load,
 * which is what every texture cost before. A consumer still on a 1.23 reader cannot read one at all
 * (its loader leaves those surfaces untextured, with a warning), which is what `--decode-dds` is for.
 *
 * **Decoded instead**, and said so on the console: a BC4 surface, which is one channel a GPU samples
 * as red and no material slot reads alone, so it is baked as the grey image it is; and anything
 * `ddsBlocks` refuses — an uncompressed surface, a chain cut short, a volume — where level 0 is
 * still worth having.
 *
 * **Decoding re-encodes as PNG, which it did not for three minor versions.** The decoded surface
 * used to be embedded as `CODEC_RAW`, on the argument that a bake runs offline and never in a frame
 * — true of the *time* and not of the file, which a browser downloads. Measured on a shipped car's
 * level of detail B: 21 textures, 3.6 MB of DDS, 11.6 MB of RGBA, in a 22.8 MB container.
 *
 * A DDS that cannot be read at all is a warning and a white pixel, so every material's ordinal keeps
 * meaning what it meant.
 */
import { ddsBlocks, ddsToRgba } from '@driftengine/assets';
import { CODEC_BC, CODEC_PNG, CODEC_RAW, writeBcPayload } from '@driftengine/drft';
import type { DrftTextureSource } from '@driftengine/drft';
import { encodePng } from '../packages/core/scripts/png.mjs';

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

/** `bytes`, a DDS, as the texture a bake embeds. */
export function ddsTexture(
  name: string,
  bytes: Uint8Array,
  decode: boolean,
  warnings: string[],
): DrftTextureSource {
  let why = 'asked to decode';
  if (!decode) {
    try {
      const image = ddsBlocks(bytes);
      if (image.format !== 'bc4') {
        const payload = writeBcPayload(image);
        console.log(
          `  texture ${name} — DDS kept as ${image.format.toUpperCase()}` +
            `${image.srgb ? ' sRGB' : ''} ${image.width}x${image.height}, ` +
            `${image.levels.length} level${image.levels.length === 1 ? '' : 's'}, ${kb(payload.length)}`,
        );
        return {
          name,
          codec: CODEC_BC,
          width: image.width,
          height: image.height,
          bytes: payload,
        };
      }
      why = 'BC4 is one channel, baked as grey';
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
  }
  try {
    const decoded = ddsToRgba(bytes);
    const png = encodePng(decoded.width, decoded.height, Buffer.from(decoded.rgba));
    console.log(
      `  texture ${name} — DDS decoded and re-encoded ${decoded.width}x${decoded.height}, ` +
        `${kb(png.length)} from ${kb(bytes.length)} (${kb(decoded.rgba.length)} uncompressed; ${why})`,
    );
    return { name, codec: CODEC_PNG, width: decoded.width, height: decoded.height, bytes: png };
  } catch (error) {
    warnings.push(`texture "${name}": ${error instanceof Error ? error.message : String(error)}`);
    return {
      name,
      codec: CODEC_RAW,
      width: 1,
      height: 1,
      bytes: new Uint8Array([255, 255, 255, 255]),
    };
  }
}
