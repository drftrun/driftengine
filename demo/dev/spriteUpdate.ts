/**
 * A sprite slot updated in part: `SpritePass.updateTexture` against `setTexture`, on the device.
 *
 * **What it proves.** An atlas is painted grey and uploaded whole; then two marks are painted into
 * the same canvas, red inside a rectangle and blue outside it, and only the rectangle is handed to
 * `updateTexture`. The frame after must show the red mark and must not show the blue one: the blue
 * one is the control that separates "copied the rectangle" from "copied the image again", which a
 * frame showing only the red mark could not. `?mode=set` uploads the whole image instead, so both
 * marks show, and `?mode=none` uploads nothing, so neither does.
 *
 * `?time=1` also times a whole upload of a 5120-texel atlas against an update of one 256 by 64
 * rectangle of it, each with the frame that draws it, for a 2D canvas drawn on the GPU and for one
 * kept in memory (`willReadFrequently: true`), which on WebGPU is the difference that matters.
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
const ATLAS = 256;
const SCALE = 2;
const ORIGIN = 40;
const RED = { x: 32, y: 32, width: 64, height: 64 };
const BLUE = { x: 160, y: 160, width: 64, height: 64 };
const BIG = 5120;

function paint(
  ctx: CanvasRenderingContext2D,
  colour: string,
  rect: { x: number; y: number; width: number; height: number },
): void {
  ctx.fillStyle = colour;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

async function frameDrawn(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') ?? 'update';

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  renderer.resize();

  const atlas = document.createElement('canvas');
  atlas.width = ATLAS;
  atlas.height = ATLAS;
  const ctx = atlas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context for the atlas');
  paint(ctx, '#606060', { x: 0, y: 0, width: ATLAS, height: ATLAS });

  const pass = createSpritePass({ capacity: 4, slots: 1, label: 'dev.spriteUpdate' });
  pass.setTexture(0, atlas);
  const handle = renderer.registerPass(pass);
  const toNdc = createAffine2D();

  const draw = (): void => {
    pass.reset();
    pass.setTransform(screenToNdc(canvas.clientWidth, canvas.clientHeight, toNdc));
    drawSprite(
      pass.batch,
      0,
      { x: ORIGIN, y: ORIGIN, w: ATLAS * SCALE, h: ATLAS * SCALE },
      null,
      null,
    );
    renderer.beginFrame(CLEAR);
    renderer.drawPass(handle);
    renderer.endFrame();
  };

  draw();
  await frameDrawn();

  paint(ctx, '#ff0000', RED);
  paint(ctx, '#0000ff', BLUE);
  if (mode === 'update') pass.updateTexture(0, atlas, RED);
  if (mode === 'set') pass.setTexture(0, atlas);
  draw();
  await frameDrawn();

  const timing: Record<string, number> = {};
  if (params.get('time') === '1') {
    /*
     * Both kinds of 2D canvas, because on WebGPU the kind decides the cost: a canvas drawn on the GPU
     * is transferred whole before any part of it is copied, and one kept in memory
     * (`willReadFrequently: true`) gives up only the rectangle.
     */
    for (const kind of ['gpu', 'memory'] as const) {
      const big = document.createElement('canvas');
      big.width = BIG;
      big.height = BIG;
      const bigCtx = big.getContext('2d', { willReadFrequently: kind === 'memory' });
      if (bigCtx === null) throw new Error('no 2d context for the large atlas');
      paint(bigCtx, '#303030', { x: 0, y: 0, width: BIG, height: BIG });
      const timed = createSpritePass({ capacity: 4, slots: 1, label: `dev.spriteUpdate.${kind}` });
      timed.setTexture(0, big);
      const bigHandle = renderer.registerPass(timed);
      let shade = 0;
      const once = async (upload: () => void): Promise<number> => {
        /* A different grey each time, so every upload has something new to carry. */
        shade = (shade + 37) % 256;
        const hex = shade.toString(16).padStart(2, '0');
        paint(bigCtx, `#${hex}${hex}${hex}`, { x: 512, y: 512, width: 256, height: 64 });
        const start = performance.now();
        upload();
        timed.reset();
        timed.setTransform(screenToNdc(canvas.clientWidth, canvas.clientHeight, toNdc));
        drawSprite(timed.batch, 0, { x: 600, y: 40, w: 128, h: 128 }, null, null);
        renderer.beginFrame(CLEAR);
        renderer.drawPass(bigHandle);
        renderer.endFrame();
        await frameDrawn();
        return performance.now() - start;
      };
      const median = (values: number[]): number =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      const whole: number[] = [];
      const part: number[] = [];
      for (let i = 0; i < 7; i++) whole.push(await once(() => timed.setTexture(0, big)));
      for (let i = 0; i < 7; i++)
        part.push(
          await once(() => timed.updateTexture(0, big, { x: 512, y: 512, width: 256, height: 64 })),
        );
      timing[`${kind}WholeMs`] = median(whole);
      timing[`${kind}PartMs`] = median(part);
    }
  }

  stats.textContent =
    `${created.backend} · mode ${mode} · red inside the rectangle, blue outside it` +
    (timing.gpuWholeMs !== undefined
      ? ` · ${BIG}px atlas, a frame with each: drawn on the GPU, whole ${timing.gpuWholeMs.toFixed(1)}` +
        ` ms and part ${timing.gpuPartMs?.toFixed(1)} ms; kept in memory, whole` +
        ` ${timing.memoryWholeMs?.toFixed(1)} ms and part ${timing.memoryPartMs?.toFixed(1)} ms`
      : '');
  (globalThis as unknown as { __measured?: unknown }).__measured = {
    backend: created.backend,
    mode,
    red: {
      x: ORIGIN + (RED.x + RED.width / 2) * SCALE,
      y: ORIGIN + (RED.y + RED.height / 2) * SCALE,
    },
    blue: {
      x: ORIGIN + (BLUE.x + BLUE.width / 2) * SCALE,
      y: ORIGIN + (BLUE.y + BLUE.height / 2) * SCALE,
    },
    grey: { x: ORIGIN + 8 * SCALE, y: ORIGIN + 8 * SCALE },
    ...timing,
  };
  (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
