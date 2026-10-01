/**
 * The reference's SVG pictures as PNGs at the sizes its scripts declare, drawn by a real browser.
 *
 * **Chrome through the engine's own CDP modules**, because an SVG is whatever a browser draws of
 * it — filters, masks, text on paths — and a second renderer would be a second opinion. Each
 * picture is drawn as an image onto a canvas at its declared size, with its faces embedded in it,
 * since an SVG drawn as an image may fetch nothing. The three the scripts declare larger than their
 * source are drawn at the declared size, from the vector.
 *
 * **A bake only draws what changed.** The cache in the data folder is keyed by the picture's path,
 * its declared size, and a hash of its text and of the faces, so an unchanged picture is a file
 * that already exists. What that gives up is noticing a change in the browser itself.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { launch } from '../../../../packages/core/scripts/browser.mjs';
import { connect } from '../../../../packages/core/scripts/cdp.mjs';
import type { TextureRef } from '../mesh/materials.ts';
import type { Face } from './fonts.ts';
import { faceRules } from './fonts.ts';

/** Where a picture's PNG is kept: its name, size and content hash. */
export function rasterPath(
  out: string,
  texture: TextureRef,
  svg: string,
  faces: readonly Face[],
): string {
  const h = createHash('sha256');
  h.update(svg);
  for (const f of faces) h.update(f.bytes);
  const key = h.digest('hex').slice(0, 12);
  return join(
    out,
    `${basename(texture.file, '.svg')}@${texture.width}x${texture.height}.${key}.png`,
  );
}

/**
 * The picture's text sized to draw at `width` × `height`, its faces inside it: the root's size
 * replaced, and a view box added where it had none, so the picture scales rather than crops.
 */
export function prepared(svg: string, width: number, height: number, rules: string): string {
  return svg.replace(/<svg\b[^>]*>/, (open) => {
    const w = open.match(/\swidth="([\d.]+)"/)?.[1];
    const h = open.match(/\sheight="([\d.]+)"/)?.[1];
    let tag = open.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
    if (!/viewBox=/.test(tag) && w !== undefined && h !== undefined) {
      tag = tag.replace(/<svg\b/, `<svg viewBox="0 0 ${w} ${h}"`);
    }
    tag = tag.replace(/<svg\b/, `<svg width="${width}" height="${height}"`);
    return `${tag}<style>${rules}</style>`;
  });
}

const DRAW = `async (svg, width, height) => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image(width, height);
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, width, height);
    g.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  } finally {
    URL.revokeObjectURL(url);
  }
}`;

export interface Rasterised {
  /** Each picture's PNG path, by `file@widthxheight`. */
  readonly paths: Map<string, string>;
  readonly drawn: number;
  readonly cached: number;
}

export const rasterKey = (t: TextureRef): string => `${t.file}@${t.width}x${t.height}`;

/** Every picture drawn to `out`, or found there already. `source` is where `etc/` is. */
export async function rasterize(
  textures: readonly TextureRef[],
  source: string,
  out: string,
  faces: readonly Face[],
): Promise<Rasterised> {
  mkdirSync(out, { recursive: true });
  const rules = faceRules(faces);
  const paths = new Map<string, string>();
  const todo: { texture: TextureRef; svg: string; path: string }[] = [];
  let cached = 0;
  for (const texture of textures) {
    const key = rasterKey(texture);
    if (paths.has(key)) continue;
    const file = join(source, '..', texture.file);
    const svg = readFileSync(file, 'utf8');
    const path = rasterPath(out, texture, svg, faces);
    paths.set(key, path);
    if (existsSync(path)) cached += 1;
    else todo.push({ texture, svg, path });
  }
  if (todo.length > 0) {
    const browser = await launch();
    try {
      const cdp = await connect(browser.port, { timeoutMs: 60_000 });
      const page = await cdp.page('about:blank', 256, 256);
      for (const { texture, svg, path } of todo) {
        const text = prepared(svg, texture.width, texture.height, rules);
        const base64 = (await page.eval(
          `(${DRAW})(${JSON.stringify(text)}, ${texture.width}, ${texture.height})`,
        )) as string;
        writeFileSync(path, Buffer.from(base64, 'base64'));
      }
      await page.close();
      cdp.close();
    } finally {
      await browser.close();
    }
  }
  return { paths, drawn: todo.length, cached };
}
