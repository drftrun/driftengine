/**
 * A game on the host: the host started, the game's native entry mounted on its canvas, and frames
 * drawn until the window closes or the game quits.
 *
 * **The contract is one export, `mount(canvas)`.** In a browser a game's page finds its canvas in
 * its own markup; here there is no markup, so the host hands the canvas over. Everything after that
 * is the game's as it is in a browser: it builds its renderer on the canvas and drives its own loop
 * with `requestAnimationFrame`, which the host's page runs once a frame before it paints. A game
 * that already mounts onto a canvas it is given — as the engine's own scenes do — needs a file of a
 * few lines and nothing else.
 *
 * **`startupReport` prints when the first frame reached the screen**, in milliseconds since the
 * process began, which is how the packaging target's cold start is measured.
 */

import { type HostOptions, startHost } from './runtime.ts';

/** What a game's native entry exports. */
export interface GameEntry {
  mount(canvas: HTMLCanvasElement): unknown;
}

export interface GameOptions extends HostOptions {
  /** The game's native entry, imported once the host has started. */
  readonly load: () => Promise<Partial<GameEntry>>;
  readonly startupReport?: boolean;
}

export async function runGame(options: GameOptions): Promise<void> {
  const host = startHost(options);
  const entry = await options.load();
  if (typeof entry.mount !== 'function') {
    const has = Object.keys(entry).join(', ') || 'nothing';
    throw new Error(
      `[driftengine] the game's native entry exports no \`mount(canvas)\`; it exports ${has}`,
    );
  }
  await entry.mount(host.canvas as unknown as HTMLCanvasElement);
  await host.run({
    after: ({ drawn }) => {
      if (options.startupReport === true && drawn === 0) {
        console.log(`[driftengine] first frame after ${Math.round(performance.now())} ms`);
      }
    },
  });
  await host.close();
  /*
   * **Ended here rather than left to end by itself.** A natural exit runs Dawn's finalizers over
   * objects the engine has already destroyed, and one of them trips a reference-count assertion
   * that takes the process down with it (measured 2026-09-18). Nothing is left for them to release.
   */
  process.exit(0);
}
