/**
 * The city's pictures as the container carries them: each rasterised PNG encoded as WebP, beside
 * it in the data folder, by the browser that drew it.
 *
 * **Chrome's own encoder**, through the engine's CDP modules, as the rasteriser draws: a second
 * encoder would be a dependency for a demo, and the browser is already how every picture here is
 * made. **A data map is lossless** — metalness and roughness are numbers, not colour — **and a
 * colour picture is whichever is smaller**, lossy at `QUALITY` or lossless: drawn from vectors,
 * flat colour and repeated pattern often code smaller without loss (30 of 231, measured), and the
 * whole city is 2.24 MB either way. Alpha — a facade's windows — is kept exactly by both. **What it
 * gives up** is the colour of a fully transparent texel, which a canvas does not keep; a window's
 * glass is transparent precisely because its colour is never read (`surfaceEffects.ts`).
 *
 * **Encoded once**: a picture whose `.webp` stands beside its `.png` is read, not encoded again.
 * The PNG's name already carries its content's hash, so a changed picture is a new file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { CODEC_WEBP } from '@driftengine/drft';
import type { DrftTextureSource } from '@driftengine/drft';

import { launch } from '../../../../packages/core/scripts/browser.mjs';
import { connect } from '../../../../packages/core/scripts/cdp.mjs';
import type { TextureRef } from '../mesh/materials.ts';
import { rasterKey } from '../textures/rasterize.ts';

/** Lossy WebP's quality, 0 to 1: past where a facade's windows and signs soften at the sizes drawn. */
const QUALITY = 0.9;
/** What Chrome takes as lossless. */
const LOSSLESS = 1;

const ENCODE = `async (png, quality) => {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  const out = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(text);
}`;

export interface Encoded {
  /** Each picture's WebP, by the same key the rasters are kept under. */
  readonly files: Map<string, string>;
  readonly encoded: number;
  readonly cached: number;
}

/**
 * Every raster in `paths` as WebP beside it, encoding only what is not there yet; those keyed in
 * `data` losslessly.
 */
export async function encodePictures(
  paths: ReadonlyMap<string, string>,
  data: ReadonlySet<string>,
): Promise<Encoded> {
  const files = new Map<string, string>();
  const todo: [string, string, boolean][] = [];
  for (const [key, png] of paths) {
    const webp = png.replace(/\.png$/, '.webp');
    files.set(key, webp);
    if (!existsSync(webp)) todo.push([png, webp, data.has(key)]);
  }
  if (todo.length > 0) {
    const browser = await launch();
    try {
      const cdp = await connect(browser.port, { timeoutMs: 60_000 });
      const page = await cdp.page('about:blank', 64, 64);
      const encode = async (base64: string, quality: number): Promise<Buffer> =>
        Buffer.from(
          (await page.eval(`(${ENCODE})(${JSON.stringify(base64)}, ${quality})`)) as string,
          'base64',
        );
      for (const [png, webp, exact] of todo) {
        const base64 = readFileSync(png).toString('base64');
        const lossless = await encode(base64, LOSSLESS);
        const lossy = exact ? lossless : await encode(base64, QUALITY);
        writeFileSync(webp, lossy.length < lossless.length ? lossy : lossless);
      }
      await page.close();
      cdp.close();
    } finally {
      await browser.close();
    }
  }
  return { files, encoded: todo.length, cached: paths.size - todo.length };
}

/** Each picture as `TEXS` carries it, named by its raster key, its size the size it was drawn at. */
export function picturesOf(
  pictures: readonly TextureRef[],
  files: ReadonlyMap<string, string>,
): DrftTextureSource[] {
  return pictures.map((t) => {
    const file = files.get(rasterKey(t));
    if (file === undefined) throw new Error(`${t.file} was not encoded`);
    return {
      name: rasterKey(t),
      codec: CODEC_WEBP,
      width: t.width,
      height: t.height,
      bytes: new Uint8Array(readFileSync(file)),
    };
  });
}
