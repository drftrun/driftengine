/**
 * A bar of three buttons, laid out by the tree and read back off the frame.
 *
 * **The measurement is that the pixels and the layout agree.** The page publishes both: the boxes
 * `layoutUiTree` computed, and the bounding boxes of the colours those boxes were drawn in. A
 * pipeline that laid a button out correctly and drew it somewhere else passes every unit test in
 * the package and fails here, and so does one that drew it at the right place in the wrong size.
 *
 *     /ui.html?point=off      the pointer is nowhere near the bar
 *     /ui.html?point=over     it is on the middle button
 *     /ui.html?point=down     it is on the middle button with the button held
 *
 * **The control is that trio**: the middle button paints itself from its own `hovered` and `pressed`
 * flags, so routing is visible as a colour rather than asserted from the router's own return value.
 * A router that never set a flag would leave the same green in all three.
 *
 * Every background here is drawn on the pass's white slot, so the whole page uses no sheet at all —
 * which is the other thing it is checking.
 *
 * Nothing here is engine API and nothing under `src/` may import it. It is a harness instrument,
 * beside `sprites.ts` and `terrain.ts`.
 */

import { createRenderer } from '../../packages/core/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import {
  addUiChild,
  createAffine2D,
  createSpritePass,
  createUiInput,
  createUiNode,
  drawUiTree,
  layoutUiTree,
  routeUiPointer,
  screenToNdc,
} from '../../packages/ui2d/src/index';
import type { UiNode } from '../../packages/ui2d/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** Nothing drawn is black, so a black pixel is a place the tree did not reach. */
const CLEAR: Vec3 = [0, 0, 0];

const BAR = [1, 0, 1, 1];
const LEFT = [0, 0, 1, 1];
const RIGHT = [1, 1, 1, 1];
const IDLE = [0, 1, 0, 1];
const HOVERED = [1, 1, 0, 1];
const PRESSED = [1, 0, 0, 1];

/** Which corner of the colour cube a pixel is nearest, as a name. */
function classify(r: number, g: number, b: number): string {
  const code = (r > 127 ? 4 : 0) | (g > 127 ? 2 : 0) | (b > 127 ? 1 : 0);
  return ['black', 'blue', 'green', 'cyan', 'red', 'magenta', 'yellow', 'white'][code] as string;
}

function rectOf(node: UiNode): number[] {
  return [node.rect.x, node.rect.y, node.rect.w, node.rect.h];
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const frames = Number(asked.get('frames') ?? '3');
  const point = asked.get('point') ?? 'off';

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  renderer.resize();

  const pass = createSpritePass({ capacity: 64, slots: 1, label: 'dev.ui' });
  const handle = renderer.registerPass(pass);

  /*
   * A bar at the bottom middle: the root fills the frame and pushes its one child to the far end
   * of a column, centred across it. The bar itself is sized by its contents, which is what makes
   * the layout worth checking — nothing here states the bar's width and the page asserts it.
   */
  const root = createUiNode({
    direction: 'column',
    width: 'grow',
    height: 'grow',
    justify: 'end',
    align: 'center',
  });
  const bar = addUiChild(
    root,
    createUiNode({ direction: 'row', padding: 10, gap: 10, background: BAR, name: 'bar' }),
  );
  const left = addUiChild(
    bar,
    createUiNode({ width: 60, height: 40, background: LEFT, name: 'left' }),
  );
  const middle = addUiChild(
    bar,
    createUiNode({
      width: 60,
      height: 40,
      background: IDLE,
      interactive: true,
      focusable: true,
      name: 'middle',
    }),
  );
  const right = addUiChild(
    bar,
    createUiNode({ width: 60, height: 40, background: RIGHT, name: 'right' }),
  );

  const input = createUiInput();
  const affine = createAffine2D();
  const mirror = document.createElement('canvas');
  mirror.width = canvas.width;
  mirror.height = canvas.height;
  const mirrorCtx = mirror.getContext('2d', { willReadFrequently: true });

  let layout: number[][] = [];
  let barBox = [0, 0, 0, 0];
  let blueBox = [0, 0, 0, 0];
  let middleColour = '';
  let over = '';
  let quads = 0;
  let digest = '';

  const scale = (): number => (canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1);

  function measure(): void {
    if (mirrorCtx === null) return;
    mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
    mirrorCtx.drawImage(canvas, 0, 0);
    const data = mirrorCtx.getImageData(0, 0, mirror.width, mirror.height).data;
    const s = scale();

    /* The bounding box of every pixel matching `want`, back in CSS pixels. */
    const boxOf = (want: string): number[] => {
      let x0 = mirror.width;
      let y0 = mirror.height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < mirror.height; y++) {
        for (let x = 0; x < mirror.width; x++) {
          const i = (y * mirror.width + x) * 4;
          const name =
            want === 'any'
              ? (data[i] ?? 0) > 20 || (data[i + 1] ?? 0) > 20 || (data[i + 2] ?? 0) > 20
                ? 'any'
                : 'black'
              : classify(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
          if (name !== want) continue;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
      return x1 < 0 ? [0, 0, 0, 0] : [x0 / s, y0 / s, (x1 + 1 - x0) / s, (y1 + 1 - y0) / s];
    };

    barBox = boxOf('any');
    blueBox = boxOf('blue');
    const cx = Math.floor((middle.rect.x + middle.rect.w / 2) * s);
    const cy = Math.floor((middle.rect.y + middle.rect.h / 2) * s);
    const at = (cy * mirror.width + cx) * 4;
    middleColour = classify(data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0);

    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) {
      hash = Math.imul(hash ^ (data[i] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 1] ?? 0), 0x01000193);
      hash = Math.imul(hash ^ (data[i + 2] ?? 0), 0x01000193);
    }
    digest = (hash >>> 0).toString(16).padStart(8, '0');
  }

  function frame(): void {
    layoutUiTree(root, 0, 0, canvas.clientWidth, canvas.clientHeight);

    /* The pointer, placed by the query rather than by a mouse, so the page is reproducible. */
    const onIt = point !== 'off';
    const px = onIt ? middle.rect.x + middle.rect.w / 2 : 10;
    const py = onIt ? middle.rect.y + middle.rect.h / 2 : 10;
    routeUiPointer(input, root, px, py, point === 'down');
    over = input.hovered === null ? 'none' : input.hovered.name;

    /* The button paints itself from its own flags, so routing is visible rather than asserted. */
    const state = middle.pressed ? PRESSED : middle.hovered ? HOVERED : IDLE;
    middle.background?.set(state);

    layout = [rectOf(bar), rectOf(left), rectOf(middle), rectOf(right)];

    pass.reset();
    pass.setTransform(screenToNdc(canvas.clientWidth, canvas.clientHeight, affine));
    quads = drawUiTree(pass.batch, root, pass.white, null);

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
    `${created.backend} · ${created.reason} · point ${point} · over ${over} · ` +
    `middle ${middleColour} · ${quads} quads · ${digest}`;
  const out = globalThis as unknown as Record<string, unknown>;
  out['__layout'] = layout;
  out['__barBox'] = barBox;
  out['__blueBox'] = blueBox;
  out['__middle'] = middleColour;
  out['__over'] = over;
  out['__quads'] = quads;
  out['__digest'] = digest;
  out['__drawn'] = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
