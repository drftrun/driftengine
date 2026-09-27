/**
 * The baker's texture pass: `--max-texture` shrinks every embedded image over the cap, and
 * `--texture-codec jpeg` re-encodes the opaque PNGs as JPEG.
 *
 * **A cap keeps a texture's codec; only the codec flag changes it.** A shrunk JPEG stays a JPEG and a
 * shrunk PNG stays a PNG unless JPEG was asked for, and even then a map with alpha, or a normal map
 * under `jpeg` rather than `jpeg-all`, stays PNG. Nothing becomes WebP, because the native host has no
 * WebP decoder. What the codec flag gives up is exactness: a second lossy pass on a map that was
 * lossless. What would make that wrong is a surface whose detail is in a subtle gradient JPEG bands,
 * which is what `--texture-codec` left unset is for.
 *
 * A texture this cannot decode is carried as it came, with a warning saying why, rather than
 * dropped. A bake that loses a map is worse than one over budget that says so.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { cappedSize, downscaleRgba } from '@driftengine/assets';
import { CODEC_JPEG, CODEC_PNG } from '@driftengine/drft';
import type { DrftTextureSource } from '@driftengine/drft';
import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';
import encodeJpeg, { init as initJpegEncode } from '@jsquash/jpeg/encode.js';
import { decodePng, encodePng, rgbaOf } from '../packages/core/scripts/png.mjs';

/**
 * The quality a capped JPEG is written at. A second lossy pass costs some detail, and 90 keeps
 * that below what halving the resolution already removed. What would make it wrong is a measured
 * payload over budget at 90; lower it then, and say by how much.
 */
const JPEG_QUALITY = 90;

let jpegReady: Promise<void> | null = null;

/**
 * MozJPEG's two modules, compiled once from the files the package ships.
 *
 * The package's declarations type `init`'s argument as module options, while its code takes a
 * compiled module first — which is how `packages/native-host/src/images.ts` calls it too.
 */
function readyJpeg(): Promise<void> {
  if (jpegReady === null) {
    const require = createRequire(import.meta.url);
    const compile = (file: string): Promise<WebAssembly.Module> =>
      WebAssembly.compile(readFileSync(require.resolve(`@jsquash/jpeg/codec/${file}`)));
    jpegReady = Promise.all([
      compile('dec/mozjpeg_dec.wasm').then((module) => initJpegDecode(module as never)),
      compile('enc/mozjpeg_enc.wasm').then((module) => initJpegEncode(module as never)),
    ]).then(() => undefined);
  }
  return jpegReady;
}

/**
 * What a texture pass is asked to do. `maxSide` caps the size; `jpeg` re-encodes an opaque PNG as a
 * JPEG — every one under `'all'`, and all but the normal maps under `'opaque'`.
 */
export interface TextureOptions {
  readonly maxSide?: number;
  readonly jpeg?: 'opaque' | 'all';
  /** Which texture ordinals a material uses as a normal map. */
  readonly normalMaps: ReadonlySet<number>;
  /**
   * Turn every normal map's green over, for a file whose maps point it down (DirectX) where glTF
   * points it up. A map written the other way lights every groove from the wrong side, which on
   * stone reads as dirt along the top of each joint rather than shade under it.
   */
  readonly flipNormalGreen?: boolean;
}

/**
 * `textures`, each shrunk to the cap and re-encoded where asked. A texture the pass cannot decode is
 * carried as it came, with a warning saying why.
 *
 * **A normal map stays PNG unless asked for all**, because it stores a direction in its colour and
 * a lossy direction bends the surface, which reads as a finish rather than as noise. Under
 * `jpeg-all` it is written with every colour sample kept (4:4:4) whatever the quality: MozJPEG keeps
 * them by itself at 90 and above and would average colour over two by two pixels below it, which
 * for a normal map is averaging the tilt. **A map with any alpha below 255 stays PNG**, because
 * JPEG has no alpha to carry it.
 */
export async function processTextures(
  textures: readonly DrftTextureSource[],
  options: TextureOptions,
  warnings: string[],
): Promise<DrftTextureSource[]> {
  const out: DrftTextureSource[] = [];
  for (let i = 0; i < textures.length; i++) {
    const texture = textures[i] as DrftTextureSource;
    const size =
      options.maxSide === undefined
        ? { width: texture.width, height: texture.height }
        : cappedSize(texture.width, texture.height, options.maxSide);
    const shrinks = size.width !== texture.width || size.height !== texture.height;
    const toJpeg =
      options.jpeg !== undefined &&
      texture.codec === CODEC_PNG &&
      (options.jpeg === 'all' || !options.normalMaps.has(i));
    const flip = options.flipNormalGreen === true && options.normalMaps.has(i);
    if (!shrinks && !toJpeg && !flip) {
      out.push(texture);
      continue;
    }
    try {
      out.push(
        await reencode(texture, size.width, size.height, toJpeg, options.normalMaps.has(i), flip),
      );
    } catch (error) {
      warnings.push(
        `texture "${texture.name}" is ${texture.width}x${texture.height} and was carried as it ` +
          `came: ${error instanceof Error ? error.message : String(error)}`,
      );
      out.push(texture);
    }
  }
  return out;
}

async function decodeRgba(
  texture: DrftTextureSource,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  if (texture.codec === CODEC_PNG) {
    const decoded = rgbaOf(decodePng(Buffer.from(texture.bytes)));
    return { rgba: decoded.rgba, width: decoded.width, height: decoded.height };
  }
  if (texture.codec === CODEC_JPEG) {
    await readyJpeg();
    /*
     * Copied into a buffer of its own. A `Buffer`'s `slice` is a view, so `.buffer` on one hands
     * the decoder every byte of whatever the image was cut from, and MozJPEG exits the process.
     */
    const decoded = await decodeJpeg(new Uint8Array(texture.bytes).buffer);
    return {
      rgba: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length),
      width: decoded.width,
      height: decoded.height,
    };
  }
  throw new Error(`codec ${texture.codec} is not one this pass re-encodes`);
}

async function reencode(
  texture: DrftTextureSource,
  width: number,
  height: number,
  toJpeg: boolean,
  /** A normal map, which never has its colour subsampled. See `processTextures`. */
  fullChroma: boolean,
  /** Turn green over. See `TextureOptions.flipNormalGreen`. */
  flipGreen: boolean,
): Promise<DrftTextureSource> {
  const decoded = await decodeRgba(texture);
  const pixels =
    width === decoded.width && height === decoded.height
      ? decoded.rgba
      : downscaleRgba(decoded.rgba, decoded.width, decoded.height, width, height);
  if (flipGreen)
    for (let at = 1; at < pixels.length; at += 4) pixels[at] = 255 - (pixels[at] as number);
  let opaque = true;
  for (let i = 3; i < pixels.length && opaque; i += 4) if (pixels[i] !== 255) opaque = false;
  const jpeg = texture.codec === CODEC_JPEG || (toJpeg && opaque);
  let bytes: Uint8Array;
  if (jpeg) {
    await readyJpeg();
    /* A plain object rather than `ImageData`, which Node does not have; the encoder reads three fields. */
    const image = {
      data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length),
      width,
      height,
    } as ImageData;
    bytes = new Uint8Array(
      await encodeJpeg(image, {
        quality: JPEG_QUALITY,
        ...(fullChroma ? { auto_subsample: false, chroma_subsample: 1 } : {}),
      }),
    );
  } else {
    bytes = new Uint8Array(encodePng(width, height, pixels));
  }
  console.log(
    `  texture ${texture.name} — ${texture.width}x${texture.height} ${texture.codec === CODEC_PNG ? 'PNG' : 'JPEG'} ` +
      `to ${width}x${height} ${jpeg ? 'JPEG' : 'PNG'}, ` +
      `${(texture.bytes.length / 1024).toFixed(0)} KB to ${(bytes.length / 1024).toFixed(0)} KB`,
  );
  return { ...texture, codec: jpeg ? CODEC_JPEG : CODEC_PNG, width, height, bytes };
}
