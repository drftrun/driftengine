/**
 * A published scene, on a native window: `npm run native:scene -- <id>`.
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
 *   its audio, and `--drag=x0,y0,x1,y1` a drag across it, which turns a scene's camera;
 * - `--audio-rate=` and `--audio-latency=` for the sample rate and buffer the host asks for;
 * - `--store=` for where the shell's store lives.
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
});

const { SCENES } = await import('../index.ts');
const id = args.find((arg) => !arg.startsWith('--')) ?? SCENES[0]?.id;
const scene = SCENES.find((candidate) => candidate.id === id);
if (scene === undefined) {
  console.error(
    `no published scene is called ${String(id)}: ${SCENES.map((s) => s.id).join(', ')}`,
  );
  process.exit(1);
}
host.window.setTitle(`${scene.title} — DriftEngine`);

/*
 * **The held clock**, as the harness holds it: `performance.now` is virtual and moves only while the
 * hold is counting. Installed before the scene mounts, because a scene can read the clock then.
 */
const STEP_MS = 1000 / 60;
let virtualMs = 0;
if (hold !== null) performance.now = () => virtualMs;

const canvas = host.canvas as unknown as HTMLCanvasElement;
const handle = await scene.mount(canvas, 'full', {});
console.log(`${scene.title}: mounted on ${handle.backend}`);
/* The camera the dev harness gives a scene: a drag, the wheel, a pinch, a double click to let go. */
bindSceneControls(host.canvas, handle.view);

/*
 * `--click=x,y` replays a click on the canvas, the gesture a scene waits for before it starts
 * anything a browser gates on one — the voxel sandbox's audio and pointer lock — and `--drag=x0,y0,
 * x1,y1` a drag across it, which turns a scene's camera. Both go through SDL's own events
 * (`HostWindow.replay`), so they take the path a person's input takes and count as one's gesture.
 */
const pointerAt = (x: number, y: number, button?: number) => ({ x, y, button, touch: false });
const click = flag('click')?.split(',').map(Number);
if (click !== undefined) {
  const [x = 0, y = 0] = click;
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
    handle.frame(dt);
  },
});

const out = flag('out');
if (out !== undefined) {
  const frame = await readFrame(canvas.getContext('webgpu') as GPUCanvasContext);
  writeFileSync(out, encodePng(frame.width, frame.height, frame.rgba));
  console.log(`wrote ${out}, ${frame.width}x${frame.height}, after ${drawn} frames`);
}

handle.dispose();
await host.close();
/*
 * **Ended here rather than left to end by itself.** A natural exit runs Dawn's finalizers over the
 * objects the engine has just destroyed, and one of them trips a reference-count assertion that
 * takes the process down with it (measured 2026-09-18: 30 frames, a clean `dispose` and `close`,
 * then the assertion). Exiting explicitly skips them; nothing is left for them to release.
 */
process.exit(0);
