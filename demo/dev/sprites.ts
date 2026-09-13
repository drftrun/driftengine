/**
 * Four sprites from two sheets, in CSS pixels, over an empty frame.
 *
 * **Every sheet here is two texels by two, and every texel a different colour**, which is what makes
 * the page a measurement rather than a picture. A sprite drawn from one covers a rectangle the page
 * names, and the four quadrants of that rectangle must hold the four texels *in the right corners* —
 * so a mirrored geometry, a flipped texture, a transposed affine and a wrong pivot each move a
 * colour somewhere it can be seen. Four distinct colours make it chiral: a mirror preserves every
 * count and every bounding box, and moves exactly this.
 *
 *     /sprites.html?order=1    the second sheet is submitted over the first
 *     /sprites.html?order=0    the other way round, and the overlap changes colour
 *
 * **The control is the pair.** Submission order is the whole layering rule of a 2D layer — there is
 * no depth here to fall back on — so a page that drew one order only would prove nothing about it.
 *
 * **The two sheets arrive as different source types on purpose**: one is a `<canvas>` and one an
 * `ImageBitmap`. `surfaceTexture.ts` carries the bug that makes this necessary — WebGL2 ignores
 * `UNPACK_FLIP_Y_WEBGL` for a bitmap and honours it for a canvas, so a texture pipeline checked
 * with one source type is half checked.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `terrain.ts` and `ssr.ts`.
 */

import { createRenderer } from '../../packages/core/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import {
  createAffine2D,
  createSpritePass,
  createTilemap,
  drawSprite,
  drawTilemap,
  gridSheet,
  screenToNdc,
  setTile,
} from '../../packages/ui2d/src/index';
import type { SpritePlacement } from '../../packages/ui2d/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Nothing drawn is black, so a black pixel is a place no sprite reached. */
const CLEAR: Vec3 = [0, 0, 0];

/** The four texels of each sheet, clockwise from the top-left of the image. */
const SHEET_A = ['#ff0000', '#00ff00', '#0000ff', '#ffffff'];
const SHEET_B = ['#ffff00', '#00ffff', '#ff00ff', '#ff0000'];

/** Where each sprite goes, in CSS pixels from the top-left. */
const AT_A: SpritePlacement = { x: 100, y: 60, w: 200, h: 120 };
const AT_B: SpritePlacement = { x: 600, y: 60, w: 200, h: 120 };
const AT_C: SpritePlacement = { x: 100, y: 300, w: 200, h: 120 };
const AT_D: SpritePlacement = { x: 200, y: 360, w: 200, h: 120 };
/** Inside both C and D, so which sheet is there is a statement about submission order. */
const OVERLAP = { x: 250, y: 390 };
/** Everything between these is sprite B and nothing else, so its box can be measured. */
const B_ONLY = 550;
const B_ONLY_END = 850;

/** The tilemap: eight columns of four, twenty CSS pixels a cell, from here. */
const MAP_X = 860;
const MAP_Y = 400;
const TILE = 20;
const MAP_COLUMNS = 8;
const MAP_ROWS = 4;
/**
 * The view handed to `drawTilemap`, covering the left half of the map and no more.
 *
 * **The cull is visible in the frame rather than only in a returned count**: the right half of the
 * map has tiles in it and stays black, so a cull that quietly drew everything would be a colour
 * where this page expects none.
 */
const MAP_VIEW = { x: MAP_X, y: MAP_Y, w: (MAP_COLUMNS / 2) * TILE, h: MAP_ROWS * TILE };

/**
 * A sheet as a 2x2 canvas, one texel a corner.
 *
 * Drawn with `fillRect` rather than written as `ImageData`, so what reaches the GPU has been
 * through a real 2D context — which is the source type a consumer building an atlas at runtime
 * actually has.
 */
function sheetCanvas(colors: readonly string[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  ctx.fillStyle = colors[0] as string;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = colors[1] as string;
  ctx.fillRect(1, 0, 1, 1);
  ctx.fillStyle = colors[2] as string;
  ctx.fillRect(0, 1, 1, 1);
  ctx.fillStyle = colors[3] as string;
  ctx.fillRect(1, 1, 1, 1);
  return canvas;
}

/** Which corner of the colour cube a pixel is nearest, as a name. */
function classify(r: number, g: number, b: number): string {
  const code = (r > 127 ? 4 : 0) | (g > 127 ? 2 : 0) | (b > 127 ? 1 : 0);
  return ['black', 'blue', 'green', 'cyan', 'red', 'magenta', 'yellow', 'white'][code] as string;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const frames = Number(asked.get('frames') ?? '3');
  const overUnder = asked.get('order') !== '0';

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  renderer.resize();

  const pass = createSpritePass({ capacity: 64, slots: 2, label: 'dev.sprites' });
  pass.setTexture(0, sheetCanvas(SHEET_A));
  pass.setTexture(1, await createImageBitmap(sheetCanvas(SHEET_B)));
  const handle = renderer.registerPass(pass);

  /*
   * The tilemap reads sheet A as a grid of four one-texel frames, so a tile's colour says which
   * frame the map asked for. `(column + row) % 4` walks all four along the top row, which makes the
   * assertion chiral: red, green, blue, white in that order and no other.
   */
  const sheet = gridSheet(0, 2, 2, 1, 1);
  const map = createTilemap(MAP_COLUMNS, MAP_ROWS, TILE, TILE);
  map.x = MAP_X;
  map.y = MAP_Y;
  for (let row = 0; row < MAP_ROWS; row++) {
    for (let column = 0; column < MAP_COLUMNS; column++) {
      setTile(map, column, row, (column + row) % 4);
    }
  }

  const affine = createAffine2D();
  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let quadA: string[] = [];
  let quadB: string[] = [];
  let box = [0, 0, 0, 0];
  let overlap = '';
  let tiles: string[] = [];
  let beyondView = '';
  let tilesDrawn = 0;
  let covered = 0;
  let digest = '';

  /** CSS pixels to the pixels the frame is actually made of. */
  const scale = (): number => (canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1);

  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    const s = scale();
    const at = (cssX: number, cssY: number): string => {
      const x = Math.floor(cssX * s);
      const y = Math.floor(cssY * s);
      const i = (y * mirror.width + x) * 4;
      return classify(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    };
    /* The four quadrant centres, in the order the sheet's texels are laid out. */
    const quads = (p: SpritePlacement): string[] => [
      at(p.x + p.w * 0.25, p.y + p.h * 0.25),
      at(p.x + p.w * 0.75, p.y + p.h * 0.25),
      at(p.x + p.w * 0.25, p.y + p.h * 0.75),
      at(p.x + p.w * 0.75, p.y + p.h * 0.75),
    ];
    quadA = quads(AT_A);
    quadB = quads(AT_B);
    overlap = at(OVERLAP.x, OVERLAP.y);
    /* The first four cells of the top row, at their centres: one per frame of the sheet. */
    tiles = [0, 1, 2, 3].map((column) => at(MAP_X + column * TILE + TILE / 2, MAP_Y + TILE / 2));
    /* A cell the map holds a tile for and the view does not reach. */
    beyondView = at(MAP_X + 6 * TILE + TILE / 2, MAP_Y + TILE + TILE / 2);

    let left = mirror.width;
    let top = mirror.height;
    let right = -1;
    let bottom = -1;
    let lit = 0;
    let hash = 0x811c9dc5;
    const from = Math.floor(B_ONLY * s);
    const until = Math.floor(B_ONLY_END * s);
    for (let y = 0; y < mirror.height; y++) {
      for (let x = 0; x < mirror.width; x++) {
        const i = (y * mirror.width + x) * 4;
        const on = (data[i] ?? 0) > 20 || (data[i + 1] ?? 0) > 20 || (data[i + 2] ?? 0) > 20;
        if (!on) continue;
        lit += 1;
        if (x < from || x >= until) continue;
        if (x < left) left = x;
        if (y < top) top = y;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
    }
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 1] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 2] ?? 0), 0x01000193);
    }
    /* Back into CSS pixels, and the far edges are exclusive so a box reads as its own width. */
    box = [left / s, top / s, (right + 1) / s, (bottom + 1) / s];
    covered = lit;
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    pass.reset();
    pass.setTransform(screenToNdc(canvas.clientWidth, canvas.clientHeight, affine));
    drawSprite(pass.batch, 0, AT_A, null, null);
    drawSprite(pass.batch, 1, AT_B, null, null);
    if (overUnder) {
      drawSprite(pass.batch, 0, AT_C, null, null);
      drawSprite(pass.batch, 1, AT_D, null, null);
    } else {
      drawSprite(pass.batch, 1, AT_D, null, null);
      drawSprite(pass.batch, 0, AT_C, null, null);
    }
    tilesDrawn = drawTilemap(pass.batch, map, sheet, MAP_VIEW, null);
    renderer.beginFrame(CLEAR);
    renderer.drawPass(handle);
    renderer.endFrame();
    measure();
  }

  let drawn = 0;
  await new Promise<void>((done) => {
    const tick = (): void => {
      frame();
      drawn += 1;
      if (drawn >= frames) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  stats.textContent =
    `${created.backend} · ${created.reason} · order ${overUnder ? 1 : 0} · ` +
    `${quadA.join(',')} · ${quadB.join(',')} · overlap ${overlap} · ` +
    `${tilesDrawn} tiles ${tiles.join(',')} · ${covered} px · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__quadA'] = quadA;
  out['__quadB'] = quadB;
  out['__box'] = box;
  out['__overlap'] = overlap;
  out['__tiles'] = tiles;
  out['__beyondView'] = beyondView;
  out['__tilesDrawn'] = tilesDrawn;
  out['__covered'] = covered;
  out['__runs'] = pass.batch.runCount;
  out['__dropped'] = pass.batch.dropped;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
