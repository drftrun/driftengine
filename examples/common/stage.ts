/**
 * The boilerplate every example would otherwise repeat, and nothing else.
 *
 * An example earns its place by showing one capability clearly. Canvas lookup, renderer
 * construction, the resize hook, the loop and the control strip are not that capability: they are
 * the same lines over and over, and repeating them buries the few lines each example exists for.
 *
 * `starter/` deliberately does **not** use this. That one is written to be copied out of the
 * repository into a real project, so it carries its own boilerplate and imports nothing local.
 */
import { Camera, createEnvironment, createRenderer, startLoop } from '@driftengine/core';
import type { CreateRendererOptions, QualityForBackend, RendererApi } from '@driftengine/core';

/** Light, air and ground bounce, shared so examples differ only where they mean to. */
export const DAYLIGHT = createEnvironment({
  directionalDir: [0.4, 0.7, 0.35],
  directionalColor: [1, 0.96, 0.88],
  ambient: [0.2, 0.22, 0.28],
  ambientGround: [0.08, 0.08, 0.1],
  emissiveGain: 1,
  nightFactor: 0,
  fogColor: [0.16, 0.18, 0.24],
  fogDensity: 0.004,
  fogHeightFalloff: 0.03,
  fogBaseY: 0,
});

export interface SceneHooks {
  /** One fixed step of the simulation. */
  simulate?(dt: number): void;
  /** One frame. `alpha` interpolates between the last two simulation states. */
  render(alpha: number): void;
}

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: RendererApi;
  readonly camera: Camera;
  /**
   * Start the loop. `maxFrameTime` is the loop's own: how much simulated time one slow frame may
   * catch up, which an example whose step is expensive keeps short so a slow machine shows a frame
   * instead of a backlog.
   */
  run(hooks: SceneHooks, loop?: { readonly maxFrameTime?: number }): void;
}

/**
 * A scene whose renderer can be rebuilt in place.
 *
 * Most of what an example switches is a dial, and a dial changes in the running frame. A few
 * switches are quality options that decide what the renderer allocates or compiles, such as the
 * sample count, and those need a new renderer. `rebuild` makes one on a fresh canvas, runs the
 * example's `build` again to put its meshes on it, and the loop carries on: whatever the example
 * keeps outside `build`, its clock, its camera, its wind, is where it was.
 */
export interface Scene {
  readonly camera: Camera;
  /** The current build's renderer. A rebuild replaces it, so read it through the scene. */
  readonly renderer: RendererApi;
  /** The current build's canvas, which a rebuild also replaces. */
  readonly canvas: HTMLCanvasElement;
  rebuild(quality: QualityForBackend): Promise<void>;
}

/** A `?name=value` from the address bar, which is where a switch remembers what it was set to. */
export function flag(name: string, fallback: string): string {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

export function flagNumber(name: string, fallback: number): number {
  const raw = new URLSearchParams(location.search).get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** One switch on the control strip. */
export interface Switch {
  /** The address-bar parameter that remembers it, so a reload or a shared link keeps it. */
  readonly key: string;
  readonly label: string;
  readonly options: readonly { readonly text: string; readonly value: string }[];
  /** The value it starts at. */
  readonly value: string;
  /** Applied when an option is chosen, to the running scene. A rebuild returns its promise. */
  readonly change: (value: string) => void | Promise<void>;
}

/**
 * Render the control strip. Choosing an option changes the running scene and nothing reloads; the
 * choice is written into the address bar, so the page opened on its own starts where it was left.
 */
export function controls(switches: readonly Switch[]): void {
  const bar = document.querySelector('#controls');
  if (bar === null) return;
  let busy = false;
  for (const control of switches) {
    const wrap = document.createElement('span');
    wrap.className = 'group';
    const name = document.createElement('b');
    name.textContent = control.label;
    wrap.append(name);
    const links: HTMLAnchorElement[] = [];
    for (const option of control.options) {
      const link = document.createElement('a');
      const query = new URLSearchParams(location.search);
      query.set(control.key, option.value);
      link.href = `?${query.toString()}`;
      link.textContent = option.text;
      if (option.value === control.value) link.className = 'on';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        if (busy || link.className === 'on') return;
        for (const other of links) other.className = other === link ? 'on' : '';
        const now = new URLSearchParams(location.search);
        now.set(control.key, option.value);
        history.replaceState(null, '', `?${now.toString()}`);
        busy = true;
        void Promise.resolve(control.change(option.value)).finally(() => {
          busy = false;
        });
      });
      links.push(link);
      wrap.append(link);
    }
    bar.append(wrap);
  }
}

function stageCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>('#stage');
  if (canvas === null) throw new Error('the page must carry <canvas id="stage">');
  return canvas;
}

/** Build a renderer against a canvas and say which backend it got. */
async function boot(
  canvas: HTMLCanvasElement,
  quality: QualityForBackend,
  options: CreateRendererOptions,
): Promise<RendererApi> {
  const { renderer, backend, reason } = await createRenderer(
    canvas,
    (chosen) => ({
      maxDevicePixelRatio: 1.75,
      ...(typeof quality === 'function' ? quality(chosen) : quality),
    }),
    options,
  );
  const readout = document.querySelector('#backend');
  if (readout !== null) readout.textContent = `${backend}: ${reason}`;
  renderer.resize();
  return renderer;
}

/**
 * Build a renderer against this page's canvas. `quality` may be a function of the backend, as
 * `createRenderer`'s may, for an option only one backend offers, and `options` are
 * `createRenderer`'s own, such as the pipeline.
 */
export async function openStage(
  quality: QualityForBackend = {},
  options: CreateRendererOptions = {},
): Promise<Stage> {
  const canvas = stageCanvas();
  const renderer = await boot(canvas, quality, options);
  addEventListener('resize', () => renderer.resize());
  const camera = new Camera();
  return {
    canvas,
    renderer,
    camera,
    run(hooks, loop = {}) {
      startLoop(
        {
          simulate(dt) {
            hooks.simulate?.(dt);
          },
          render(alpha) {
            camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
            hooks.render(alpha);
          },
        },
        loop.maxFrameTime === undefined ? {} : { maxFrameTime: loop.maxFrameTime },
      );
    },
  };
}

/**
 * Open a scene that can be rebuilt in place. `build` runs once per renderer: it makes the meshes
 * and everything else the renderer owns, and returns the hooks that draw them.
 */
export async function openScene(
  quality: QualityForBackend,
  build: (renderer: RendererApi, canvas: HTMLCanvasElement) => SceneHooks,
  options: CreateRendererOptions = {},
): Promise<Scene> {
  let canvas = stageCanvas();
  let renderer = await boot(canvas, quality, options);
  let hooks = build(renderer, canvas);
  let building = false;
  const camera = new Camera();
  addEventListener('resize', () => renderer.resize());

  startLoop({
    simulate(dt) {
      if (!building) hooks.simulate?.(dt);
    },
    render(alpha) {
      if (building) return;
      camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
      hooks.render(alpha);
    },
  });

  return {
    camera,
    get renderer() {
      return renderer;
    },
    get canvas() {
      return canvas;
    },
    async rebuild(next) {
      building = true;
      /* A fresh canvas, because a canvas keeps the first kind of context it was given. */
      renderer.dispose({ releaseContext: true });
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
      renderer = await boot(canvas, next, { ...options, splash: false });
      hooks = build(renderer, canvas);
      building = false;
    },
  };
}
