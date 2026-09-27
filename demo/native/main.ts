/**
 * A scene, on a native window: `npm run native:scene -- <id>`.
 *
 * **Published or draft, by id**, because the harness page offers both and a scene being built is
 * the one most in need of a second host. `DRAFT_SCENES` stays off the website, not off this
 * window. An id that names neither prints both lists, so the one to type can be read off.
 *
 * **With the browser harness's controls, drawn by the engine** (`hud/`): the scene menu, the player,
 * the reveal scrubber and the readout, since the window has nothing but its canvas to put them in.
 * A scene picked from the menu is mounted into the same window. Off for a held capture, which
 * photographs the scene alone for the pixel gate, and off with `--hud=0`.
 *
 * **Mounted as the dev harness mounts it**: the scene is handed a canvas and the full budget, asked
 * for a frame each tick, and its camera bound to the mouse as the harness binds it. The host is
 * started as a packaged game's is (`startHost`), so the scene sees what a game would; the canvas is
 * the host's, `navigator.gpu` is Dawn's, and nothing in the scene or the engine is told.
 *
 * Options:
 * - `--hidden` for a window that is never shown;
 * - `--frames=N` to stop after N frames;
 * - `--query=radius=8&at=29.7` for the address a browser capture would have opened the scene at;
 * - `--size=1280x608` for the canvas, which is the dev harness's stage at a 1280 by 720 capture;
 * - `--click=x,y` to replay a click on the canvas, the gesture a scene waits for before it starts
 *   its audio (`x,y;x,y` for several, in order: a menu opened, then an entry picked), and
 *   `--drag=x0,y0,x1,y1` a drag across it, which turns a scene's camera;
 * - `--audio-rate=` and `--audio-latency=` for the sample rate and buffer the host asks for;
 * - `--store=` for where the shell's store lives;
 * - `--present=mailbox` (or `immediate`, `fifoRelaxed`) for how frames reach the screen, which is
 *   `fifo` by default, paced by the compositor: see `HostWindowOptions.presentMode`.
 *
 * **Held, for the pixel gate**: `--hold=N --out=frame.png` runs the held clock the dev harness runs
 * (`demo/dev/heldFrame.ts`): N steps of a sixtieth of a second with `performance.now` moving with
 * them, then `--settle=` frames (570 by default) with the clock stopped, which is about how many a
 * browser capture draws in the two and a half seconds it waits. Then it writes the canvas's
 * texture, as the engine left it, to a PNG.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../../packages/core/scripts/png.mjs';
import type { AudioDefaults } from '../../packages/native-host/src/audio.ts';
import { readFrame } from '../../packages/native-host/src/readback.ts';
import { startHost } from '../../packages/native-host/src/runtime.ts';
import type { PresentMode } from '../../packages/native-host/src/window.ts';
import { demoQualityFor, readDemoDeviceHints } from '../deviceBudget.ts';
import { askedQuality } from '../dev/askedQuality.ts';
import type { DemoHandle } from '../types.ts';
import { NativeHud } from './hud/nativeHud.ts';
import { bindSceneControls } from './sceneControls.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

/*
 * **Web Audio**, for the engine's mix: `--audio-rate=44100` asks for a sample rate and
 * `--audio-latency=playback` (or seconds) for a buffer, and the device's answer is reported.
 */
const latency = flag('audio-latency');
const audio: AudioDefaults = {
  ...(flag('audio-rate') === undefined ? {} : { sampleRate: Number(flag('audio-rate')) }),
  ...(latency === undefined
    ? {}
    : {
        latencyHint: Number.isNaN(Number(latency))
          ? (latency as AudioContextLatencyCategory)
          : Number(latency),
      }),
};
const [width, height] = (flag('size') ?? '1280x608').split('x').map(Number) as [number, number];
const hold = flag('hold') === undefined ? null : Number(flag('hold'));
const settle = Number(flag('settle') ?? 570);
const frames = hold === null ? Number(flag('frames') ?? Infinity) : hold + settle;
const store = flag('store');

/*
 * **The host before the scenes' modules**, because it installs threads first and the engine's
 * pools decide whether they have a default worker when they are imported. The title waits for the
 * scene, which is not known until they have been.
 */
const host = startHost({
  title: 'DriftEngine',
  width,
  height,
  hidden: args.includes('--hidden'),
  query: flag('query') ?? '',
  /* The page's own files, from the directory the dev server serves them from. */
  publicDir: fileURLToPath(new URL('../dev/public', import.meta.url)),
  audio,
  ...(store === undefined ? {} : { storePath: store }),
  ...(flag('present') === undefined ? {} : { presentMode: flag('present') as PresentMode }),
});

const { SCENES, DRAFT_SCENES } = await import('../index.ts');
const ALL = [...SCENES, ...DRAFT_SCENES];
const id = args.find((arg) => !arg.startsWith('--')) ?? SCENES[0]?.id;
const first = ALL.findIndex((candidate) => candidate.id === id);
if (first < 0) {
  const ids = (list: readonly { id: string }[]): string => list.map((s) => s.id).join(', ');
  console.error(
    `no scene is called ${String(id)}.\n  published: ${ids(SCENES)}\n  draft:     ${ids(DRAFT_SCENES)}`,
  );
  process.exit(1);
}
/* As the browser's picker names them. */
const titleOf = (index: number): string => {
  const title = ALL[index]?.title ?? '';
  return index >= SCENES.length ? `${title} (draft)` : title;
};

/*
 * **The held clock**, as the harness holds it: `performance.now` is virtual and moves only while the
 * hold is counting. Installed before the scene mounts, because a scene can read the clock then.
 */
const STEP_MS = 1000 / 60;
let virtualMs = 0;
if (hold !== null) performance.now = () => virtualMs;

const canvas = host.canvas as unknown as HTMLCanvasElement;
/*
 * **What the browser harness mounts a scene with**: the device's own trims under whatever the
 * address asks for, `--query` being this window's address. Mounted with nothing, every quality flag
 * the harness documents — `gputiming=1`, `samples=`, `bloom=` — was silently ignored here, and the
 * readout said `0.00 ms gpu` whatever was asked.
 */
const quality = { ...demoQualityFor(readDemoDeviceHints()), ...askedQuality() };
/*
 * **Before any scene binds its camera**, so it sees every pointer first: see `hud/hudInput.ts`.
 */
const hud =
  hold === null && flag('hud') !== '0'
    ? new NativeHud(
        host.canvas,
        ALL.map((_, index) => titleOf(index)),
        (index) => void switchTo(index),
      )
    : null;

/* Asserted rather than annotated, so the checker does not narrow it to the `null` it starts as:
   `show` is what assigns it, and a narrowing cannot see into a call. */
let handle = null as DemoHandle | null;
let current = first;
let unbind = (): void => undefined;
/* Counts mounts, so a scene picked while another is still mounting wins over it. */
let mounts = 0;
/* The mount under way, which a frame hands the loop to wait on: nothing draws until it lands. */
let mounting: Promise<void> | null = null;

/** Put scene `index` in the window, in place of whatever was there. */
async function show(index: number): Promise<void> {
  const scene = ALL[index];
  if (scene === undefined) return;
  const mine = ++mounts;
  hud?.detach();
  unbind();
  unbind = () => undefined;
  handle?.dispose();
  handle = null;
  host.window.setTitle(`${scene.title} — DriftEngine`);
  let mounted: DemoHandle;
  try {
    mounted = await scene.mount(canvas, 'full', quality);
  } catch (error) {
    console.error(`${scene.title} failed to mount: ${String(error)}`);
    return;
  }
  if (mine !== mounts) {
    mounted.dispose();
    return;
  }
  console.log(`${scene.title}: mounted on ${mounted.backend}`);
  handle = mounted;
  current = index;
  /* The camera the dev harness gives a scene: a drag, the wheel, a pinch, a double click to let go. */
  unbind = bindSceneControls(host.canvas, mounted.view);
  hud?.attach(mounted, index, scene.title);
}

/** `show`, remembered while it runs so the frame loop can wait for it. */
function switchTo(index: number): Promise<void> {
  const running: Promise<void> = show(index).finally(() => {
    if (mounting === running) mounting = null;
  });
  mounting = running;
  return running;
}

await switchTo(first);

/*
 * `--click=x,y` replays a click on the canvas, the gesture a scene waits for before it starts
 * anything a browser gates on one — the voxel sandbox's audio and pointer lock — and `--drag=x0,y0,
 * x1,y1` a drag across it, which turns a scene's camera. Both go through SDL's own events
 * (`HostWindow.replay`), so they take the path a person's input takes and count as one's gesture.
 */
const pointerAt = (x: number, y: number, button?: number) => ({ x, y, button, touch: false });
for (const point of flag('click')?.split(';') ?? []) {
  const [x = 0, y = 0] = point.split(',').map(Number);
  host.window.replay('mouseMove', pointerAt(x, y));
  host.window.replay('mouseButtonDown', pointerAt(x, y, 1));
  host.window.replay('mouseButtonUp', pointerAt(x, y, 1));
}
const drag = flag('drag')?.split(',').map(Number);
if (drag !== undefined) {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = drag;
  host.window.replay('mouseMove', pointerAt(x0, y0));
  host.window.replay('mouseButtonDown', pointerAt(x0, y0, 1));
  for (let step = 1; step <= 10; step += 1) {
    const x = x0 + ((x1 - x0) * step) / 10;
    const y = y0 + ((y1 - y0) * step) / 10;
    host.window.replay('mouseMove', pointerAt(x, y));
  }
  host.window.replay('mouseButtonUp', pointerAt(x1, y1, 1));
}

/*
 * `--key=<scancode>` holds a key down for the whole run, the way a person holds one to walk.
 *
 * **Replayed through SDL's own events**, like the click and the drag above, so it takes the path a
 * person's keystroke takes: through `connectDomEvents`, the page, and into whatever `InputSource`
 * the scene made. It is the only way to check a scene's keyboard without a person at the machine —
 * and without it, "the keyboard does not work" has no instrument between a maintainer's report and
 * a guess. 26 is `W`, 4 is `A`, 22 is `S`, 7 is `D`.
 */
const sdlKey = (scancode: number) => ({
  scancode,
  key: null,
  repeat: 0,
  shift: 0,
  ctrl: 0,
  alt: 0,
  super: 0,
});
const held = flag('key');
if (held !== undefined) {
  host.window.replay('keyDown', sdlKey(Number(held)));
}

let last = performance.now();
const drawn = await host.run({
  frames,
  before: (count) => {
    if (hold !== null && count < hold) virtualMs += STEP_MS;
  },
  frame: ({ now }) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const showing = handle;
    if (showing === null) return mounting ?? undefined;
    try {
      /* Drawn first and on its own line: inside `hud?.frame(…)` an absent HUD skipped the scene too. */
      const stats = showing.frame(dt);
      hud?.frame(dt, stats);
    } catch (error) {
      /* As the browser harness does: say so, and stop drawing a scene that has thrown. */
      const message = `${titleOf(current)} threw while drawing: ${String(error)}`;
      console.error(message);
      hud?.failed(message);
      handle = null;
    }
  },
});

const out = flag('out');
if (out !== undefined) {
  const frame = await readFrame(canvas.getContext('webgpu') as GPUCanvasContext);
  writeFileSync(out, encodePng(frame.width, frame.height, frame.rgba));
  console.log(`wrote ${out}, ${frame.width}x${frame.height}, after ${drawn} frames`);
}

hud?.dispose();
handle?.dispose();
await host.close();
/*
 * **Ended here rather than left to end by itself.** A natural exit runs Dawn's finalizers over the
 * objects the engine has just destroyed, and one of them trips a reference-count assertion that
 * takes the process down with it (measured 2026-09-18: 30 frames, a clean `dispose` and `close`,
 * then the assertion). Exiting explicitly skips them; nothing is left for them to release.
 */
process.exit(0);
