import { expect, test } from 'vitest';
import { fullscreenWanted } from './fullscreen.ts';

/** A handheld that has not been asked yet: the one case that says yes. */
const HANDHELD = {
  coarsePointer: true,
  supported: true,
  alreadyFullscreen: false,
  askedBefore: false,
} as const;

test('a handheld that has not been asked yet is the only yes', () => {
  expect(fullscreenWanted(HANDHELD)).toBe(true);

  /*
   * Each restraint alone is enough to refuse, and each one is a different promise:
   *
   * - `coarsePointer` false is a desktop, which has a window it chose the size of
   *   and a key to toggle fullscreen with. Seizing the display because somebody
   *   clicked a menu button is the behaviour embedded video players are hated for.
   * - `supported` false is iPhone Safari, which has no element fullscreen. Calling
   *   the method there is a TypeError in the middle of the audio unlock.
   * - `alreadyFullscreen` is an installed app, whose manifest already asked.
   * - `askedBefore` is the player who *left* fullscreen. Every tap is another
   *     gesture, so without this the next one drags them back and the argument is
   *     one they cannot win.
   */
  expect(fullscreenWanted({ ...HANDHELD, coarsePointer: false })).toBe(false);
  expect(fullscreenWanted({ ...HANDHELD, supported: false })).toBe(false);
  expect(fullscreenWanted({ ...HANDHELD, alreadyFullscreen: true })).toBe(false);
  expect(fullscreenWanted({ ...HANDHELD, askedBefore: true })).toBe(false);
});
