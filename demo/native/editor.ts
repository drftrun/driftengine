/**
 * The editor, on a native window: `npm run editor -w @driftengine/native-host`.
 *
 * **What Wave 2C's rule was for.** The editor may name no browser global outside its entry and
 * `host/browser/`, so a second host replaces those and nothing above them. This file is the second
 * entry: it turns SDL's keys, pointer and size (through this host's page) into the front end's calls
 * (`editor/src/frontEnd.ts`), draws the front end's picture with the engine, and hands the editor
 * this host's `TextHost` and an `A11yHost` that publishes to nothing. Nothing in `editor/` changes
 * for it.
 *
 * **The picture is the engine's, and it is painted inside the frame**: panels for rectangles,
 * outlines as four one-pixel panels, a disc as six bands — the whole picture is 58 panels, inside the 64 a WebGPU frame allows — and the
 * engine's pixel font for text, at a cell of 1.2 pixels so a glyph
 * advances as far as the browser's 12-pixel monospace does and the front end's layout fits. What it
 * gives up: the pixel font has capitals only and no glyph for `—` or `·`, which draw as its box.
 *
 * **No accessibility service is reached**: this host publishes the editor's tree to nothing, which
 * `docs/CAPABILITIES.md` states rather than leaving to be found.
 *
 * Options: `--hidden`, `--frames=N`, `--out=frame.png`, and `--pick=x,y` and `--palette=text`, which
 * replay a click and a typed palette query through the page's own events, for a capture to compare.
 */

import { writeFileSync } from 'node:fs';

import { encodePng } from '../../packages/core/scripts/png.mjs';
import { createNullA11yHost } from '../../packages/ui2d/src/a11y.ts';

import { installGpu } from '../../packages/native-host/src/globals.ts';
import { HostPage } from '../../packages/native-host/src/page.ts';
import { readFrame } from '../../packages/native-host/src/readback.ts';
import { installThreads } from '../../packages/native-host/src/threads.ts';
import { HostWindow } from '../../packages/native-host/src/window.ts';

installThreads();
const { DEFAULT_TEXT_STYLE, createRenderer } = await import('../../packages/core/src/index.ts');
const { createEditorFrontEnd } = await import('../../editor/src/frontEnd.ts');
type EditorPainter = import('../../editor/src/frontEnd.ts').EditorPainter;
type TextHandle = import('../../packages/core/src/index.ts').TextHandle;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const frames = Number(flag('frames') ?? Infinity);

const host = new HostWindow({
  title: 'DriftEngine editor',
  width: 1280,
  height: 720,
  hidden: args.includes('--hidden'),
});
installGpu(host.gpu);
const page = new HostPage();
page.install();
host.connectPage(page);

const canvas = host.canvas as unknown as HTMLCanvasElement;
const { renderer } = await createRenderer(canvas, {}, { preferWebGpu: true, splash: false });
await renderer.ready();

const editor = createEditorFrontEnd({
  canvas,
  textHost: host.createTextHost(),
  a11yHost: createNullA11yHost(),
});

/** `#rrggbb` or `#rrggbbaa`, as display values from 0 to 1. */
function colourOf(hex: string): { rgb: [number, number, number]; alpha: number } {
  const byte = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return { rgb: [byte(1), byte(3), byte(5)], alpha: hex.length === 9 ? byte(7) : 1 };
}

const DISC_BANDS = 6;

/** One text handle a string drawn this frame, reused frame to frame in the order they are drawn. */
const texts: TextHandle[] = [];
let textsUsed = 0;
let clip: { x: number; y: number; w: number; h: number } | null = null;

function panel(x: number, y: number, w: number, h: number, colour: string): void {
  let left = x;
  let top = y;
  let right = x + w;
  let bottom = y + h;
  if (clip !== null) {
    left = Math.max(left, clip.x);
    top = Math.max(top, clip.y);
    right = Math.min(right, clip.x + clip.w);
    bottom = Math.min(bottom, clip.y + clip.h);
  }
  if (right <= left || bottom <= top) return;
  const { rgb, alpha } = colourOf(colour);
  renderer.fillPanel({ left, top, width: right - left, height: bottom - top }, rgb, alpha);
}

const painter: EditorPainter = {
  rect: panel,
  outline(x, y, w, h, colour) {
    panel(x, y, w, 1, colour);
    panel(x, y + h - 1, w, 1, colour);
    panel(x, y, 1, h, colour);
    panel(x + w - 1, y, 1, h, colour);
  },
  disc(x, y, radius, colour) {
    /* Six bands, so the whole picture stays inside the backend's sixty-four panels a frame. */
    const band = (radius * 2) / DISC_BANDS;
    for (let at = 0; at < DISC_BANDS; at += 1) {
      const middle = -radius + band * (at + 0.5);
      const half = Math.sqrt(Math.max(0, radius * radius - middle * middle));
      panel(x - half, y - radius + band * at, half * 2, band, colour);
    }
  },
  text(content, x, y, colour) {
    let handle = texts[textsUsed];
    if (handle === undefined) {
      handle = renderer.createText();
      texts.push(handle);
    }
    textsUsed += 1;
    renderer.setText(handle, content);
    renderer.drawText(
      handle,
      renderer.cssWidth,
      renderer.cssHeight,
      x,
      y,
      {
        ...DEFAULT_TEXT_STYLE,
        cellSize: 1.2,
        color: colourOf(colour).rgb,
        glow: 0,
        alpha: 1,
        reveal: 1,
      },
      0,
    );
  },
  clip(x, y, w, h) {
    clip = { x, y, w, h };
  },
  unclip() {
    clip = null;
  },
};

/* The page's events, as the browser entry listens for them. */
page.window.addEventListener('keydown', (event) => {
  const e = event as KeyboardEvent;
  if (editor.key({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey })) {
    e.preventDefault();
  }
});
host.canvas.addEventListener('pointerdown', (event) => {
  const e = event as PointerEvent;
  editor.pointerDown(e.clientX, e.clientY, e.shiftKey);
});
const resize = (): void => {
  renderer.resize();
  editor.resize(renderer.cssWidth, renderer.cssHeight);
};
page.window.addEventListener('resize', resize);
resize();

/* A capture's replay: the same click and typing the browser's capture makes. */
const replay = (type: string, target: EventTarget, init: Record<string, unknown>) =>
  target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), init));
const pick = flag('pick')?.split(',').map(Number);
if (pick !== undefined) {
  replay('pointerdown', host.canvas, { clientX: pick[0], clientY: pick[1], shiftKey: false });
}
const typed = flag('palette');
if (typed !== undefined) {
  replay('keydown', page.window, { key: 'k', ctrlKey: true, metaKey: false, shiftKey: false });
  for (const key of typed) {
    replay('keydown', page.window, { key, ctrlKey: false, metaKey: false, shiftKey: false });
  }
}

let drawn = 0;
while (!host.isClosed && drawn < frames) {
  const now = performance.now();
  page.runFrame(now);
  editor.frame(now);
  renderer.beginFrame([0, 0, 0]);
  /*
   * **Inside the frame, before `endFrame`, and that is the whole of why this window was black.**
   *
   * The interface used to be painted after `endFrame`, on the reading that an overlay lands on the
   * presented swap view. On this host it lands nowhere: measured 2026-09-20 on Dawn, the canvas
   * context held **0 pixels above black** with the panels issued after `endFrame` and **1,747,114**
   * with them issued before it — the same frame, the same calls, one line moved. `demo/voxelSandbox.ts`
   * has carried the rule in a comment since it was written: *before `endFrame`, always; an overlay
   * issued after it survives on WebGL2 and vanishes on WebGPU.*
   *
   * **It was invisible to every capture this harness takes**, because `--out` reads the canvas
   * texture rather than the window, and a texture that is never presented still reads back. The
   * maintainer's screen was the only instrument that could see it.
   */
  textsUsed = 0;
  editor.paint(painter);
  painter.text(editor.readout(), renderer.cssWidth - 318, renderer.cssHeight - 16, '#d7dde5');
  renderer.endFrame();
  host.present();
  drawn += 1;
  await new Promise((resolve) => setImmediate(resolve));
}

const out = flag('out');
if (out !== undefined) {
  const frame = await readFrame(canvas.getContext('webgpu') as GPUCanvasContext);
  writeFileSync(out, encodePng(frame.width, frame.height, frame.rgba));
  console.log(`wrote ${out}: ${editor.readout()}`);
}
renderer.dispose();
await host.close();
process.exit(0);
