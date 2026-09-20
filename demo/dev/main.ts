/**
 * The engine's own demo harness.
 *
 * The scenes in `demo/` are the engine's showcase and they were only ever viewable by
 * running the website, which meant a change here could not be *looked at* without leaving
 * the repository it lives in. That is the wrong order: the site publishes what the engine
 * already knows is good, so the engine needs its own way to see it first.
 *
 * Deliberately plain. It is a picker, a canvas and the frame's own figures — anything more
 * would be a second website to maintain, and the one that faces readers already exists.
 */

import { DRAFT_SCENES, SCENES } from '../index';
import type { DemoHandle } from '../types';
import { bindOrbitControls } from '../controls';
import { askedHeldFrames, askedHoldStop, holdFrames, releaseHeldClock } from './heldFrame';
import { askedQuality } from './askedQuality';
import { demoQualityFor, readDemoDeviceHints } from '../deviceBudget';

/*
 * Vite's HMR API is declared in `viteHmr.d.ts`, beside this file.
 *
 * It lived here until a second harness page needed it. `import.meta.hot` is a property rather
 * than a method, so TypeScript merges two declarations of it only when their types are
 * identical — one shared declaration, not two that must be kept in step by memory.
 */

/*
 * The clock, before anything mounts.
 *
 * First, deliberately: a scene that has already read `performance.now` once would be seeded
 * from the real one and every frame after it would be measured against a clock that jumped.
 */
const held = askedHeldFrames();
if (held !== undefined) holdFrames(held, askedHoldStop());

/* Also once, and before anything mounts. A remount from hot reload reuses this rather than
   re-reading the URL, which keeps every mount in a session comparable with every other. */
const quality = askedQuality();
/* Read once: it cannot change while the page is open, and a scene remount is expensive. */
const DEVICE_QUALITY = demoQualityFor(readDemoDeviceHints());

/**
 * `?bench=N`: how long N frames took, on the CPU and on the device, once the scene is drawing.
 *
 * **Counted from the first frame that draws**, because a scene building its world behind a splash
 * reports no draws, and a measurement of the splash says nothing about the scene. The CPU figure is
 * `frame` itself, which is everything the scene does on the main thread; the device figure is
 * whatever the scene reports as `gpuMs`, which is zero unless `?gputiming=1` asked for timestamps.
 * `scripts/sandbox-bench.mjs` reads `__bench` once it is done.
 */
const BENCH_FRAMES = Math.max(
  0,
  Math.floor(Number(new URLSearchParams(location.search).get('bench')) || 0),
);
const bench = { cpu: [] as number[], gpu: [] as number[], draws: 0, extra: '', done: false };

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const picker = document.getElementById('picker') as HTMLElement;
const stats = document.getElementById('stats') as HTMLElement;
const scrub = document.getElementById('scrub') as HTMLInputElement;
const errorBox = document.getElementById('error') as HTMLElement;

let handle: DemoHandle | null = null;
let unbind: (() => void) | null = null;
let frame = 0;
let current = -1;

function stop(): void {
  cancelAnimationFrame(frame);
  unbind?.();
  unbind = null;
  handle?.dispose();
  handle = null;
  scrub.classList.remove('on');
  scrub.max = '1';
}

/**
 * Show the reveal scrubber once the scene has states to offer, and follow it while it is dragged.
 *
 * **The count arrives late and that is the whole reason this is checked per frame rather than at
 * mount.** A scene that loads a model has nothing to scrub until the model has finished arriving,
 * which is seconds in and may never happen at all — no model beside the page, a device that
 * declined to hold the states. So the control appears when it becomes useful, and a scene that
 * offers none never grows one.
 *
 * Left where the viewer put it once they have touched it: re-syncing the slider to the live load
 * would be the page arguing with the person holding it.
 */
function updateScrub(): void {
  const reveal = handle?.reveal;
  const steps = reveal?.steps ?? 0;
  if (steps < 2) {
    scrub.classList.remove('on');
    return;
  }
  const top = String(steps - 1);
  if (scrub.max !== top) {
    scrub.max = top;
    /* Parked at the end, which is the state the scene is already showing. */
    scrub.value = top;
    scrub.classList.add('on');
  }
}

/**
 * Asynchronous because mounting is: the engine asks for an adapter before it knows what
 * will draw. Callers fire and forget, which is what they did when it was synchronous.
 */
async function run(index: number): Promise<void> {
  stop();
  errorBox.textContent = '';
  current = index;
  for (const button of picker.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset['index']) === index));
  }

  const scene = ALL[index];
  if (scene === undefined) return;
  try {
    /*
     * The scene's own budget, and whatever the address bar asked for on top of it. Read here
     * rather than in a scene, so one spelling covers all of them and a comparison between two
     * quality options is a query rather than an edit.
     *
     * **No context is created here any more.** This harness used to make a `webgl2` context
     * and hand it over, which chose the backend on every scene's behalf: a canvas that has
     * given a `webgpu` context cannot also give a `webgl2` one, so `?backend=webgpu` could
     * not reach a scene at all. The engine picks, and picking is a promise.
     */
    /*
     * The device's own trims underneath, so this harness and driftengine.dev show a phone the
     * same frame. They are dials rather than switches — density, area, samples, reflection
     * scale, shadow sizes — so every pass a desktop reader sees is still drawn here. Anything
     * typed into the address bar wins over them, which is what makes the harness a harness.
     */
    handle = await scene.mount(canvas, 'full', { ...DEVICE_QUALITY, ...quality });
  } catch (error) {
    errorBox.textContent = `${scene.title} failed to mount:\n${String(error)}`;
    return;
  }

  /*
   * The held clock starts here rather than at page load, so both backends simulate the same
   * number of frames. See `releaseHeldClock`: WebGPU awaits an adapter before it can draw,
   * and a clock that ran during that wait photographed the two backends minutes apart.
   */
  releaseHeldClock();

  /* The shared binder, so this harness and the website cannot disagree about a drag. */
  const view = handle.view;
  if (view !== undefined) unbind = bindOrbitControls(canvas, view, { captureWheel: true });
  canvas.ondblclick = () => view?.release();

  let last = performance.now();
  let smoothed = 60;
  const tick = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    try {
      updateScrub();
      const began = performance.now();
      const measured = handle?.frame(dt);
      const spent = performance.now() - began;
      if (BENCH_FRAMES > 0 && !bench.done && (measured?.draws ?? 0) > 0) {
        bench.cpu.push(spent);
        bench.gpu.push(measured?.gpuMs ?? 0);
        bench.draws = measured?.draws ?? 0;
        bench.extra = measured?.extra ?? '';
        if (bench.cpu.length >= BENCH_FRAMES) {
          bench.done = true;
          (globalThis as unknown as { __bench: typeof bench }).__bench = bench;
        }
      }
      smoothed += (1 / Math.max(dt, 1e-4) - smoothed) * 0.1;
      /*
       * The backend first, because every other figure on this line is worthless without it.
       *
       * Asked of the handle rather than read back off `?backend=`: the query says what was
       * requested, and a browser without WebGPU, a failed device request or a typo all fall
       * back silently to a frame that looks completely reasonable. It sits in the readout band
       * the capture harness already excludes, so it cannot move a parity figure.
       */
      stats.textContent =
        `${handle?.backend ?? '?'} · ` +
        `${scene.title} — ${smoothed.toFixed(0)} fps · ${measured?.draws ?? 0} draws · ` +
        `${(measured?.gpuMs ?? 0).toFixed(2)} ms gpu` +
        (measured?.extra === undefined ? '' : ` · ${measured.extra}`) +
        (view?.taken === true ? ' · camera yours (double click to release)' : '');
    } catch (error) {
      errorBox.textContent = `${scene.title} threw while drawing:\n${String(error)}`;
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

/* The harness shows the published scenes and the drafts; the website shows only the
   published ones. That difference is the whole reason this harness exists. */
const ALL = [...SCENES, ...DRAFT_SCENES];

picker.replaceChildren();
ALL.forEach((scene, index) => {
  const button = document.createElement('button');
  button.textContent = index >= SCENES.length ? `${scene.title} (draft)` : scene.title;
  button.dataset['index'] = String(index);
  button.addEventListener('click', () => run(index));
  picker.append(button);
});

/* `input` rather than `change`, so the model follows the thumb instead of the release. Bound once
   here rather than per mount: the element outlives every scene, and a listener added per run is a
   listener leaked per run. */
scrub.addEventListener('input', () => {
  handle?.reveal?.set(Number(scrub.value));
});

addEventListener('beforeunload', stop);

/**
 * Hot reload, so editing a scene shows up without restarting anything.
 *
 * This module *self-accepts*. A scene file is a dependency of the barrel which is a
 * dependency of this, so Vite propagates any edit under `demo/` up to the nearest
 * accepting module — here — and re-executes it. Without that the graph reaches the root
 * with nobody accepting, and Vite falls back to a full page reload, which throws away the
 * context, the compiled programs and the shadow bakes on every keystroke.
 *
 * `dispose` tears the running scene down first. A remount that skipped it would leak a
 * WebGL context per edit, and browsers cap those at around sixteen before they start
 * dropping the oldest — which is the one being looked at.
 *
 * The selected scene is carried across in `hot.data`, because reloading into scene zero
 * every time you touch the file you are working on is its own small torture.
 */
if (import.meta.hot) {
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data['scene'] = current;
    stop();
  });
  import.meta.hot.accept();
}

const restored = import.meta.hot?.data?.['scene'];
run(
  typeof restored === 'number'
    ? restored
    : Number(new URLSearchParams(location.search).get('scene') ?? 0) || 0,
);
export {};
