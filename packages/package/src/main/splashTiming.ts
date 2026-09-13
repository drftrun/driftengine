/**
 * When the badge gives the screen to the game.
 *
 * Two conditions and a cap, and each is there for a failure that has a name:
 *
 *   - **The game has painted.** Swapping before that shows a white or black window while the
 *     first frame is still being built, which is the thing a splash exists to prevent.
 *   - **The minimum has passed *since the badge reached the screen*.** A badge that vanishes the
 *     instant a fast machine paints is a flicker rather than a splash, and the machines that boot
 *     fastest are the ones a developer tests on. Measured from the badge rather than from process
 *     start because the badge's own arrival is an unbounded wait — a second window, a protocol
 *     handler and an SVG — and measuring the budget from before it started is how a splash gets
 *     closed before it is ever shown. Timed on one machine at `minMs: 900`: the badge reached the
 *     screen at 411 ms unpacked and at 1659 ms as an AppImage, where the whole budget had already
 *     elapsed. It survived there only because the game happened to paint later still.
 *   - **The cap overrides both.** A boot that never finishes must not leave a logo as the whole
 *     product; past the cap the window is shown whatever state it is in, because a broken game
 *     that can be seen is better than a brand that cannot be dismissed.
 *
 * Pure, so all three are testable without a window: the caller owns the clock.
 */
export type SplashDecision = 'hold' | 'swap';

/**
 * The ceiling on the whole splash, whatever the manifest asked for.
 *
 * Twenty seconds is long enough for a large world to stream in on a slow disk — which is exactly
 * the boot a splash should cover — and short enough that a failure is seen in the same sitting.
 */
export const SPLASH_HARD_CAP_MS = 20_000;

/**
 * @param sinceStartMs Since the main window was created, which is what the cap is measured against.
 * @param sinceBadgeMs Since the badge reached the screen, or `null` while it has not. A caller that
 *   has given up on the badge ever appearing passes `sinceStartMs`, which is the behaviour this had
 *   before the badge was waited for at all.
 */
export function splashDecision(
  sinceStartMs: number,
  sinceBadgeMs: number | null,
  minMs: number,
  contentReady: boolean,
  capMs: number = SPLASH_HARD_CAP_MS,
): SplashDecision {
  if (sinceStartMs >= capMs) return 'swap';
  if (!contentReady) return 'hold';
  /* The game is ready and the badge is not on screen yet: showing the game now is what makes a
     splash vanish entirely on somebody else's machine. The cap above is what bounds this. */
  if (sinceBadgeMs === null) return 'hold';
  return sinceBadgeMs >= minMs ? 'swap' : 'hold';
}
