import { describe, expect, it } from 'vitest';

import { SPLASH_HARD_CAP_MS, splashDecision } from './splashTiming.ts';

const MIN = 1400;

describe('splashDecision', () => {
  /** The badge has been on screen for as long as the process has run, which is the easy case. */
  const together = (elapsed: number, ready: boolean): 'hold' | 'swap' =>
    splashDecision(elapsed, elapsed, MIN, ready);

  it('holds while the game has not painted', () => {
    expect(together(200, false)).toBe('hold');
  });

  /*
   * A badge that vanishes the moment a fast machine paints is a flicker, not a splash. The
   * minimum is what makes it readable on the machine that boots quickest.
   */
  it('holds a fast boot until the minimum has passed', () => {
    expect(together(300, true)).toBe('hold');
    expect(together(MIN, true)).toBe('swap');
  });

  it('swaps as soon as both conditions hold', () => {
    expect(together(1600, true)).toBe('swap');
  });

  /*
   * The case that matters most and is easiest to leave out: a boot that never finishes. Without a
   * cap the logo is the whole product, and the failure it is covering is invisible.
   */
  it('gives up on a game that never paints, rather than hiding it forever', () => {
    expect(together(SPLASH_HARD_CAP_MS, false)).toBe('swap');
    expect(together(SPLASH_HARD_CAP_MS - 1, false)).toBe('hold');
  });

  it('never holds for a minimum longer than the cap', () => {
    expect(splashDecision(SPLASH_HARD_CAP_MS + 500, 0, 99_000, false)).toBe('swap');
  });

  /**
   * **The minimum is the badge's time on screen, not the process's.**
   *
   * The badge is a second window, resolved through a protocol handler and painting an image, and
   * how long that takes is a property of the machine rather than of the build. Measured on one
   * machine at a 900 ms minimum: 411 ms to the screen unpacked and 1659 ms as an AppImage. Counted
   * from process start, the whole budget is gone before the badge arrives — so a game that paints
   * first closes a window that was never shown, and the player sees no splash at all.
   */
  it('does not spend the minimum before the badge is on screen', () => {
    /* 1.66 s in, the game is ready and the badge has just appeared. The budget starts now. */
    expect(splashDecision(1659, 0, 900, true)).toBe('hold');
    expect(splashDecision(1659 + 899, 899, 900, true)).toBe('hold');
    expect(splashDecision(1659 + 900, 900, 900, true)).toBe('swap');
  });

  it('holds a ready game while the badge has still not appeared', () => {
    expect(splashDecision(5_000, null, 900, true)).toBe('hold');
  });

  /** And the cap is what stops that being forever, which is the whole reason it is measured from start. */
  it('shows the game anyway when the badge never appears at all', () => {
    expect(splashDecision(SPLASH_HARD_CAP_MS, null, 900, true)).toBe('swap');
  });
});
