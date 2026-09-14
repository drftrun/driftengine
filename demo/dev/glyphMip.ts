/**
 * Type baked into an atlas and drawn at a seventh of its authored size, with the chain and without.
 *
 * **This page exists because a player could read the defect and no instrument could.** A consumer
 * bakes one glyph page per weight at 96 px and draws body copy at 11, and `Step-In Uppercut` came
 * out as `Slep-In Uppercul`: the crossbar of every `t` gone. Four texels sampled out of a footprint
 * covering dozens, so a stroke two texels tall survives or not depending on where the sample lands
 * — which is why the same glyph reads differently in different positions and the line looks
 * unevenly spaced as well as misread.
 *
 *     /glyphMip.html                  the default backend
 *     /glyphMip.html?backend=webgl2   the other one
 *
 * **The measurement is the pair, and the second half is the one that makes it a measurement.** A
 * row of identical glyphs is drawn at deliberately different subpixel offsets. Undersampled, each
 * copy loses a different part of the letter, so the ink varies between copies; with a chain, every
 * copy carries the same ink because a lower level has already averaged the strokes. So the numbers
 * to read are not "is there ink" but **how much the copies disagree**, which is the reported
 * symptom stated as a number.
 *
 * `__measured` carries them for `scripts/glyph-mip-check.mjs`, which is what runs this without a
 * person looking at it.
 *
 * Nothing here is engine API and nothing under `src/` may import it.
 */

import { createRenderer } from '../../packages/core/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import {
  createAffine2D,
  createSpritePass,
  drawSprite,
  screenToNdc,
} from '../../packages/ui2d/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const CLEAR: Vec3 = [0, 0, 0];

/** What the consumer bakes: one page, this tall. Their number, not one chosen here. */
const ATLAS_SIZE = 96;
/** What the consumer draws body copy at. Their number too, and the 7x is the whole defect. */
const DRAWN_SIZE = 13;
/** How many copies of the glyph to draw, each at a different subpixel offset. */
const COPIES = 12;

/**
 * A `t` at the atlas size, in a cell of its own.
 *
 * `t` because it is the letter the report names and the one with the thinnest horizontal stroke:
 * its crossbar is about two texels at 96 and about a quarter of a pixel at 13, which is exactly
 * the stroke a four-texel read throws away.
 */
function glyphAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context for the atlas');
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${ATLAS_SIZE * 0.8}px ui-monospace, monospace`;
  ctx.fillText('t', ATLAS_SIZE / 2, ATLAS_SIZE / 2);
  return canvas;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  renderer.resize();

  /*
   * Slot 0 is the sheet as it ships today and slot 1 is the same image with a chain. The same
   * canvas into both, so nothing but the sampler differs between the two rows.
   */
  const atlas = glyphAtlas();
  const pass = createSpritePass({ capacity: 64, slots: 2, label: 'dev.glyphMip' });
  pass.setTexture(0, atlas, { filter: 'linear', colorSpace: 'srgb' });
  pass.setTexture(1, atlas, { filter: 'linear', colorSpace: 'srgb', mipmap: true });
  const handle = renderer.registerPass(pass);

  /** Where each row sits, and the offsets that make the copies disagree. */
  const rowY = { plain: 40, mipped: 40 + DRAWN_SIZE * 3 };
  const step = DRAWN_SIZE + 6;
  const place = (index: number, y: number): { x: number; y: number; w: number; h: number } => ({
    /* A third of a pixel per copy, so the sample lands somewhere different in each. */
    x: 40 + index * step + (index % 3) / 3,
    y,
    w: DRAWN_SIZE,
    h: DRAWN_SIZE,
  });

  const toNdc = createAffine2D();
  /* `reset`, then the transform, then the draws, then the frame that runs the pass: the order
     `sprites.ts` uses, and the pass clears its batch on reset rather than at frame start. */
  pass.reset();
  pass.setTransform(screenToNdc(canvas.clientWidth, canvas.clientHeight, toNdc));
  for (let index = 0; index < COPIES; index++) {
    drawSprite(pass.batch, 0, place(index, rowY.plain), null, null);
    drawSprite(pass.batch, 1, place(index, rowY.mipped), null, null);
  }
  renderer.beginFrame(CLEAR);
  renderer.drawPass(handle);
  renderer.endFrame();

  stats.textContent =
    `${created.backend} · ${created.reason} · atlas ${ATLAS_SIZE}px drawn at ${DRAWN_SIZE}px ` +
    `(${(ATLAS_SIZE / DRAWN_SIZE).toFixed(1)}x) · top row plain, bottom row mipmapped`;
  (globalThis as unknown as { __measured?: unknown }).__measured = {
    backend: created.backend,
    atlas: ATLAS_SIZE,
    drawn: DRAWN_SIZE,
    copies: COPIES,
    rows: rowY,
    step,
    firstX: 40,
  };
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
