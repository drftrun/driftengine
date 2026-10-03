/**
 * The parts of the host the display example cannot show: a store's features, which a shell
 * supplies and a browser has no honest version of, and the engine badge a game boots behind.
 *
 * A snippet, typechecked with the examples and quoted by the manual's display chapter.
 */
import { createRenderer } from '@driftengine/core';
import type { PlatformServices } from '@driftengine/core';

// #region services
/**
 * Achievements and presence, from whatever store the shell is built for. The engine never calls
 * these on its own and ships nothing for them, so a game that never asks for an achievement
 * carries no store SDK. Neither may throw: a store that is offline is an ordinary state.
 */
export function storeServices(store: {
  unlock(id: string): Promise<void>;
  presence(text: string): void;
}): PlatformServices {
  return {
    unlockAchievement(id) {
      store
        .unlock(id)
        .catch((error: unknown) => console.warn('achievement not unlocked', id, error));
    },
    setRichPresence(text) {
      store.presence(text);
    },
  };
}
// #endregion

// #region badge
/**
 * The badge is on unless a page declines it: a canvas that is one part of a page, or a tool that
 * opens into its own interface, is not a game booting.
 */
export async function toolRenderer(canvas: HTMLCanvasElement) {
  return createRenderer(canvas, {}, { splash: false });
}

/** Or held longer, for a game whose first frame comes before it has anything to show. */
export async function gameRenderer(canvas: HTMLCanvasElement) {
  return createRenderer(canvas, {}, { splash: { minMs: 4000 } });
}
// #endregion
