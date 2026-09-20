/**
 * `createImageBitmap`, for a host with no browser to decode an image.
 *
 * **A scene's images reach the engine through it**: a model's textures are PNG and JPEG bytes the
 * loader hands to `createImageBitmap`, and the bitmap it gets back goes to the device through
 * `copyExternalImageToTexture`. Node has neither, so the host decodes, and its queue (see
 * `device.ts`) writes a host bitmap's bytes where the browser would have copied an image.
 *
 * **The decoders are chosen to give Chrome's bytes.** PNG is lossless, so this repository's own
 * decoder (`packages/core/scripts/png.mjs`) gives them by definition. JPEG goes through
 * `@jsquash/jpeg`, MozJPEG compiled to WebAssembly — libjpeg-turbo, the decoder Chrome uses — which
 * decodes the showroom car's five JPEG textures to Chrome's bytes exactly: 0 of 6.07 million pixels,
 * measured 2026-09-19 against `createImageBitmap` in Chrome on the same bytes. A JavaScript JPEG
 * decoder was the alternative and would have differed, because the inverse transform is not
 * specified to the bit.
 *
 * What it gives up: WebP is not decoded (no scene the host runs needs it yet, and it is refused by
 * name), and a resized decode is declined — see `hostCreateImageBitmap`.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import decodeJpeg, { init as initJpeg } from '@jsquash/jpeg/decode.js';

import { decodePng } from '@driftengine/core/scripts/png.mjs';

/** What a host hands back for an image: its size and four bytes a pixel, top row first. */
export interface HostBitmap {
  readonly width: number;
  readonly height: number;
  /** Straight alpha, as decoded. */
  readonly data: Uint8ClampedArray;
  /**
   * Whether a browser would be holding this premultiplied, which it does unless asked not to
   * (`premultiplyAlpha: 'none'`). The data stays straight; the queue does what Chrome's copy does
   * with a premultiplied image (see `device.ts`), so a transparent texel's colour is lost where
   * Chrome loses it.
   */
  readonly premultiplied: boolean;
  close(): void;
}

const HOST_BITMAP = Symbol('driftengine host bitmap');

export function isHostBitmap(value: unknown): value is HostBitmap {
  return typeof value === 'object' && value !== null && HOST_BITMAP in value;
}

function bitmap(
  width: number,
  height: number,
  data: Uint8ClampedArray,
  premultiplied: boolean,
): HostBitmap {
  return {
    width,
    height,
    data,
    premultiplied,
    close: () => undefined,
    [HOST_BITMAP]: true,
  } as HostBitmap;
}

/** Four bytes a pixel out of three or four. */
function rgba(pixels: Uint8Array, channels: number, count: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(count * 4);
  if (channels === 4) {
    out.set(pixels.subarray(0, count * 4));
    return out;
  }
  for (let at = 0; at < count; at += 1) {
    out[at * 4] = pixels[at * channels] as number;
    out[at * 4 + 1] = pixels[at * channels + 1] as number;
    out[at * 4 + 2] = pixels[at * channels + 2] as number;
    out[at * 4 + 3] = 255;
  }
  return out;
}

let jpegReady: Promise<void> | null = null;

/** MozJPEG's module, compiled once from the file its package ships. */
function readyJpeg(): Promise<void> {
  if (jpegReady === null) {
    const wasm = createRequire(import.meta.url).resolve('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm');
    jpegReady = WebAssembly.compile(readFileSync(wasm)).then((module) => initJpeg(module));
  }
  return jpegReady;
}

/**
 * Decode a blob or take `ImageData` as it is.
 *
 * **Decoded straight, with no colour conversion**, which is what the engine asks for where it asks
 * (`premultiplyAlpha: 'none'`, `colorSpaceConversion: 'none'`). Where it does not ask, a browser
 * holds the image premultiplied, and the bitmap says so for the copy to act on. **A resized decode is declined by name**: the model loader asks
 * for a small preview before the sharp image and drops it if it fails, and a preview resampled by
 * another filter than Chrome's would put a picture on the screen that no browser drew.
 */
export async function hostCreateImageBitmap(
  source: Blob | ImageData,
  options: ImageBitmapOptions = {},
): Promise<HostBitmap> {
  if (options.resizeWidth !== undefined || options.resizeHeight !== undefined) {
    throw new Error('[driftengine] the native host does not resample while it decodes');
  }
  const premultiplied = options.premultiplyAlpha !== 'none';
  if (!(source instanceof Blob)) {
    return bitmap(source.width, source.height, new Uint8ClampedArray(source.data), premultiplied);
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (source.type === 'image/png') {
    const png = decodePng(Buffer.from(bytes));
    const pixels = rgba(png.pixels, png.channels, png.width * png.height);
    return bitmap(png.width, png.height, pixels, premultiplied);
  }
  if (source.type === 'image/jpeg') {
    await readyJpeg();
    const image = await decodeJpeg(bytes.buffer);
    return bitmap(image.width, image.height, new Uint8ClampedArray(image.data), premultiplied);
  }
  throw new Error(
    `[driftengine] the native host cannot decode ${source.type || 'an untyped blob'}`,
  );
}

/**
 * The image globals a scene reads: `createImageBitmap`, and `ImageData`, which Node lacks and which
 * both the model loader and MozJPEG's module construct.
 */
export function installImages(): void {
  const scope = globalThis as Record<string, unknown>;
  scope['createImageBitmap'] = hostCreateImageBitmap;
  if (scope['ImageData'] === undefined) {
    scope['ImageData'] = class {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }
}
