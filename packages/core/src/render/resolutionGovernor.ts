/**
 * Hold a frame budget by moving the drawing-buffer scale, and nothing else.
 *
 * This is the safety net the GPU-budget design asks for, and the reason it is worth
 * having is that it works on hardware nobody here owns — including hardware that does not
 * exist yet. One of the three players whose reports started that design found the cure by
 * hand: they shrank the browser window until the game was smooth. This does the same
 * thing without asking anyone to.
 *
 * **Pure by design: no GL, no DOM, no clock.** Frame times come in, a new scale comes
 * out, and the caller decides what to do with it. That is what makes it testable at all,
 * because every device it exists for is one no test machine has.
 *
 * **Asymmetric on purpose.** Dropping is fast, because a player at 6 fps needs relief
 * now. Raising is slow and waits behind several consecutive good windows, because a
 * resolution that oscillates is more visible than one that is slightly too low.
 */

import { withDefaults } from '../core/withDefaults.ts';
export interface GovernorLimits {
  /**
   * The frame time a frame is allowed, in milliseconds. Longer than this is a *long* frame.
   *
   * 40 rather than 16.67, and that gap is the tolerance. This is not a governor for
   * squeezing a machine from 55 fps to 60: it exists for the parts that render at 4 to 9
   * fps, and a trigger anywhere near the vsync interval would spend its life reacting to
   * jitter on machines that are entirely fine. It is `LONG_FRAME_MS` from the consuming
   * game's own frame health, deliberately, because that number has already been tuned
   * against real false positives.
   */
  readonly budgetMs: number;
  /**
   * Share of a window's frames that must be long before the window counts as bad.
   *
   * **This is the guard that makes a busy high-end machine safe.** One hitch in sixty
   * frames is a 1.7% share and decides nothing; a garbage collection, a shader compile, a
   * texture upload or another application grabbing the GPU all look like that. Half the
   * window being long is not a hitch, it is the machine.
   */
  readonly badShare: number;
  /** Never go below this. A soft picture beats a slideshow. */
  readonly minScale: number;
  /** Frames per decision. One slow frame is noise; a window of them is evidence. */
  readonly windowFrames: number;
  /**
   * Consecutive bad windows before the scale actually moves.
   *
   * The second half of the tolerance, and the same reasoning `SLOW_WINDOWS` carries in the
   * game: one bad window is a level load, a world build, a tab that just came back. Two in
   * a row is a machine, because none of those things happen twice in a row.
   */
  readonly badWindows: number;
  /** How far to drop in one decision. */
  readonly dropStep: number;
  /** How far to raise in one decision. Deliberately smaller than `dropStep`. */
  readonly raiseStep: number;
  /** Consecutive clean windows required before raising at all. */
  readonly raisePatience: number;
}

/**
 * Deliberately hard to trigger. Work through what a healthy machine has to do to move it.
 *
 * At 120 fps, sixty frames is half a second. To drop one step a machine must spend **thirty
 * of those sixty frames over 40 ms**, then do it again in the very next window: roughly a
 * full second in which half the frames missed 25 fps. Nothing transient does that. A
 * garbage collection is one frame, a shader compile is a handful, another application
 * grabbing the GPU for a moment is a fraction of a window, and every one of them leaves the
 * share far under a half.
 *
 * The devices this exists for are not marginal and do not need a sensitive trigger.
 * `NFD6QQ`'s Adreno 619 held **156.66 ms** — every frame long, a share of 1.0 — so it
 * clears two windows without ambiguity while a busy desktop never clears one.
 *
 * The 0.5 floor is `RESOLUTION_MIN` from the game's own settings screen, so the governor can
 * never take a player somewhere they could not have gone themselves.
 */
export const DEFAULT_GOVERNOR_LIMITS: GovernorLimits = {
  budgetMs: 40,
  badShare: 0.5,
  minScale: 0.5,
  windowFrames: 60,
  badWindows: 2,
  dropStep: 0.25,
  raiseStep: 0.125,
  raisePatience: 4,
};

export class ResolutionGovernor {
  private readonly limits: GovernorLimits;
  private ceiling: number;
  private current: number;
  private frames = 0;
  private longFrames = 0;
  private badWindows = 0;
  private goodWindows = 0;

  constructor(ceiling: number, limits: Partial<GovernorLimits> = {}) {
    this.limits = withDefaults(DEFAULT_GOVERNOR_LIMITS, limits);
    this.ceiling = ceiling;
    this.current = ceiling;
  }

  get scale(): number {
    return this.current;
  }

  /**
   * The player's own ceiling moved.
   *
   * A *lower* ceiling applies at once, because their choice is authority and waiting a
   * window to honour it would be ignoring them. A *higher* one is only a permission: it
   * does not raise the current scale, because jumping up would undo a drop the device had
   * already earned. The patience path decides whether it can afford to climb back.
   */
  setCeiling(ceiling: number): void {
    this.ceiling = ceiling;
    if (this.current > ceiling) this.current = ceiling;
  }

  /** Start the window again, leaving the scale where it is. */
  reset(): void {
    this.frames = 0;
    this.longFrames = 0;
    this.badWindows = 0;
    this.goodWindows = 0;
  }

  /**
   * One frame. Returns the new scale when it changed and `null` when it did not, so the
   * caller does no GL or DOM work on an ordinary frame.
   *
   * `playable` exists because of `DZTF9F`, where an RTX 3060 filed a report calling
   * itself unplayable from a menu: a menu frame and a hidden-tab frame are not verdicts
   * about the machine. A governor that believed them would soften a game running
   * perfectly, which is the same false positive with a more visible symptom.
   */
  sample(frameMs: number, playable: boolean): number | null {
    if (!playable) return null;

    this.frames++;
    /*
     * A *share* of long frames, not the worst one.
     *
     * The worst frame in a window was the first version of this and it was wrong in the
     * one way that matters: with any budget near the vsync interval, a single hitch on an
     * otherwise perfect machine drops a resolution step. "The worst frame decides" is the
     * right rule for *diagnosing* a device, because a mean hides a machine that is fine
     * until something happens, and it is the wrong rule for a *control loop*, which has to
     * ignore everything it cannot act on. A share ignores hitches by construction.
     */
    if (frameMs > this.limits.budgetMs) this.longFrames++;
    if (this.frames < this.limits.windowFrames) return null;

    const share = this.longFrames / this.frames;
    this.frames = 0;
    this.longFrames = 0;

    if (share >= this.limits.badShare) {
      /*
       * A bad window is evidence, not a decision. It takes `badWindows` of them in a row,
       * so a world build or a tab coming back cannot move anything on its own.
       */
      this.goodWindows = 0;
      this.badWindows++;
      if (this.badWindows < this.limits.badWindows) return null;
      this.badWindows = 0;

      const next = Math.max(this.limits.minScale, this.current - this.limits.dropStep);
      if (next === this.current) return null;
      this.current = next;
      return this.current;
    }

    /*
     * A window that was not bad clears the run of bad ones. Two bad windows separated by a
     * good one are two hiccups, and treating them as a streak would mean any long enough
     * session eventually drops the resolution of a machine that never needed it.
     */
    this.badWindows = 0;
    this.goodWindows++;
    if (this.goodWindows < this.limits.raisePatience) return null;
    this.goodWindows = 0;
    const next = Math.min(this.ceiling, this.current + this.limits.raiseStep);
    if (next === this.current) return null;
    this.current = next;
    return this.current;
  }
}
