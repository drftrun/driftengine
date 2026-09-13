/**
 * The boilerplate every example would otherwise repeat, and nothing else.
 *
 * An example earns its place by showing one capability clearly. Canvas lookup, renderer
 * construction, the resize hook and the loop are not that capability — they are the same
 * twenty lines four times over, and repeating them buries the two or three lines each
 * example actually exists to show.
 *
 * `starter/` deliberately does **not** use this. That one is written to be copied out of the
 * repository into a real project, so it carries its own boilerplate and imports nothing local.
 */
import { Camera, createEnvironment, createRenderer, startLoop } from '@driftengine/core';
import type { RendererApi, RenderQualityOptions } from '@driftengine/core';

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

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: RendererApi;
  readonly camera: Camera;
  /** Start the loop. `alpha` interpolates between the last two simulation states. */
  run(hooks: { simulate?: (dt: number) => void; render: (alpha: number) => void }): void;
}

/** A `?name=value` from the address bar, so a comparison is a reload rather than a rebuild. */
export function flag(name: string, fallback: string): string {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

export function flagNumber(name: string, fallback: number): number {
  const raw = new URLSearchParams(location.search).get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Render the control strip as links rather than as handlers.
 *
 * Every switch in these examples is a construction-time quality option, and changing one of
 * those means building a new renderer — so a link that reloads with a different query string
 * is not a shortcut around a click handler, it is the honest shape of the thing being shown.
 */
export function controls(
  groups: { label: string; options: { text: string; query: string }[] }[],
): void {
  const bar = document.querySelector('#controls');
  if (bar === null) return;
  const here = location.search;
  for (const group of groups) {
    const wrap = document.createElement('span');
    wrap.className = 'group';
    const name = document.createElement('b');
    name.textContent = group.label;
    wrap.append(name);
    for (const option of group.options) {
      const link = document.createElement('a');
      link.href = `?${option.query}`;
      link.textContent = option.text;
      if (`?${option.query}` === here) link.className = 'on';
      wrap.append(link);
    }
    bar.append(wrap);
  }
}

/** Build a renderer against this page's canvas and report which backend it got. */
export async function openStage(quality: RenderQualityOptions = {}): Promise<Stage> {
  const canvas = document.querySelector<HTMLCanvasElement>('#stage');
  if (canvas === null) throw new Error('the page must carry <canvas id="stage">');

  const { renderer, backend, reason } = await createRenderer(canvas, {
    maxDevicePixelRatio: 1.75,
    ...quality,
  });

  const readout = document.querySelector('#backend');
  if (readout !== null) readout.textContent = `${backend} — ${reason}`;

  renderer.resize();
  addEventListener('resize', () => renderer.resize());

  const camera = new Camera();

  return {
    canvas,
    renderer,
    camera,
    run(hooks) {
      startLoop({
        simulate(dt) {
          hooks.simulate?.(dt);
        },
        render(alpha) {
          camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
          hooks.render(alpha);
        },
      });
    },
  };
}
