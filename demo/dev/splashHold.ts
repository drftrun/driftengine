/**
 * The engine's badge held by the game until a load of its own settles.
 *
 *     /splashHold.html               the control: no hold, the badge leaves three seconds after the
 *                                    first frame
 *     /splashHold.html?hold=6000     the badge held until a promise that settles at six seconds
 *     /splashHold.html?hold=6000&fail=1   the same promise rejected: the badge leaves all the same
 *     /splashHold.html?hold=60000&cap=8000   a hold longer than its cap: gone at the cap
 *
 * Writes `window.__splash`: when the badge left, in milliseconds from the renderer's creation, and
 * how many frames the loop ran before the hold settled and between that and the badge leaving. A
 * load may need frames, so they must run while it is held; after it settles they are held for the
 * rest of the minimum, as after a first frame with no hold. Nothing under `src/` may import this.
 */
import { createRenderer, holdSplash, startLoop } from '../../packages/core/src/index';
import { askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const hold = Number(ASKED.get('hold') ?? '0');
  const cap = ASKED.get('cap');
  const started = performance.now();
  const created = await createRenderer(canvas, askedQuality(), { splash: true });
  const renderer = created.renderer;
  let settledAt = -1;
  if (hold > 0) {
    const load = new Promise<void>((resolve, reject) =>
      setTimeout(() => (ASKED.get('fail') === '1' ? reject(new Error('load')) : resolve()), hold),
    );
    load.then(
      () => (settledAt = performance.now() - started),
      () => (settledAt = performance.now() - started),
    );
    holdSplash(load, cap === null ? {} : { capMs: Number(cap) });
  }
  let beforeSettle = 0;
  let afterSettle = 0;
  let leftAt = -1;
  startLoop({
    simulate: () => {},
    render: () => {
      if (settledAt < 0) beforeSettle++;
      else if (leftAt < 0) afterSettle++;
      renderer.beginFrame([0.1, 0.12, 0.15]);
      renderer.endFrame();
    },
  });
  const watch = (): void => {
    if (leftAt < 0 && document.querySelector('[data-drift-splash]') === null) {
      leftAt = performance.now() - started;
      (window as unknown as { __splash: unknown }).__splash = {
        leftAt: Math.round(leftAt),
        settledAt: Math.round(settledAt),
        beforeSettle,
        afterSettle,
      };
      stats.textContent = `${created.backend} · badge left at ${Math.round(leftAt)} ms`;
      (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
      return;
    }
    setTimeout(watch, 50);
  };
  watch();
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
