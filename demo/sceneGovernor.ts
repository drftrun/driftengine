/**
 * Keep a demo drawing on a machine that cannot hold the rate, instead of taking it away.
 *
 * **The failure this exists for.** A host that measures a demo's frame times has had exactly
 * two things it could do with a bad answer: build the scene again at a cheaper profile, or
 * stop. Both are all or nothing and the second is permanent, so a machine a little short of
 * the rate lost the render for the rest of the visit. On driftengine.dev that read as the
 * frame going black, because a stopped scene hides its canvas and the demos page has no still
 * behind it. The render being taken away was correct at 8 ms a frame.
 *
 * There is a third answer and the engine already had both halves of it: `ResolutionGovernor`,
 * which decides, and `Renderer.applyResolutionScale`, which acts. Nothing joined them for a
 * demo. This is that join, and it is deliberately thin — the policy is the governor's and the
 * measurement is the host's, so what is left here is the wiring and the reason for it.
 *
 * **Why the host drives this rather than the scene.** The same division every other control in
 * `DemoHandle` follows. The host owns the clock, owns pausing, and knows when the tab is
 * hidden; a scene that timed itself would keep animating off screen, which is the bug
 * `frame(dtSec)` is shaped to prevent. So the scene exposes the lever and whoever is holding
 * the clock pulls it.
 *
 * **Why density and not the profile.** Density is the only quality lever that survives being
 * moved while a scene is running. A profile fixes shadow map sizes and wave surfaces when the
 * renderer is built, so changing one means rebuilding every GPU resource the scene hangs off,
 * which is what a remount is for.
 */

import type { GovernorLimits } from '../packages/core/src/index';
import { DEFAULT_GOVERNOR_LIMITS, ResolutionGovernor } from '../packages/core/src/index';
import type { DemoHandle, ResolutionControl } from './types';

/**
 * What a demo changes about the game's tuning.
 *
 * **The window is halved because a reader is not a player.** The game's sixty frames twice over
 * is a second and a half on a machine that is coping and much longer on one that is not, which
 * is nothing across a session and is most of the time anybody spends looking at a demo. At the
 * rates this fires on, the game's numbers spend seven seconds deciding, and a reader has
 * usually stopped reading.
 *
 * **`badWindows` stays at two, and that is the load's doing.** A model arriving is a burst of
 * long frames followed by none, which is exactly the shape one bad window has, and a governor
 * that acted on one would soften the showroom every time the car turned up. Two in a row is a
 * machine, because a load does not happen twice.
 *
 * **A long frame is one that misses fifty a second, and a quarter of a window is enough.** The
 * game's 40 ms is a floor against a slideshow, and it left the front page's scene at 40 fps on
 * the machines and phones it was reported from, because a frame of 25 ms is not long by it. A demo
 * is judged on whether it moves smoothly, and a softer picture that does is the better answer
 * for it than a sharp one that stutters. At 60 Hz a machine drawing 48 frames a second shows a
 * quarter of them twice, which is where this starts; one at 55 shows a tenth and is left alone.
 * What it costs is density on machines a game would leave sharp, and what keeps that from being
 * a blur on a machine the pixels were never the problem for is the judgement below, which gives a
 * drop back when the window after it was no faster.
 */
const DEMO_GOVERNOR_LIMITS: Partial<GovernorLimits> = {
  windowFrames: 30,
  budgetMs: 20,
  badShare: 0.25,
};

/**
 * Frames left out after a move before the frames after it are read as its result: the resize
 * lands on the next frame, and the one after can carry the reallocation of every target sized
 * from the canvas.
 */
const SETTLE_FRAMES = 4;

/**
 * How much of the frame a drop has to buy back to be kept: a tenth.
 *
 * A frame bound by its pixels gets far more than that from a step, which takes 0.75 of the density
 * and so 0.56 of the pixels. A frame capped by something else gets nothing: a browser saving
 * power at 30 a second, a display at 50 Hz, a main thread busy with the page. What would make a
 * tenth wrong is a scene whose pixels are a small part of its frame, which this governor cannot
 * help and should not try to.
 */
const WORTHWHILE = 0.9;

/**
 * How long a raise is on trial: three windows. A raise the machine cannot hold drops again after
 * two bad ones, so a third that passes without a drop is a scale it holds, and a hitch after that
 * is about something else.
 */
const RAISE_TRIAL_WINDOWS = 3;

export class SceneGovernor {
  private readonly control: ResolutionControl | undefined;
  private readonly governor: ResolutionGovernor | undefined;
  private readonly minScale: number;
  /** The last window's frame times, so a drop can be judged against the frames that caused it. */
  private readonly recent: Float64Array;
  private recentAt = 0;
  /** The mean frame time before the drop being judged, or zero when none is. */
  private judgingFromMs = 0;
  /** The density to give back if the drop being judged bought nothing. */
  private judgingScale = 0;
  private settling = 0;
  private afterSumMs = 0;
  private afterFrames = 0;
  /**
   * The density the scale in force was raised from, while that raise is still on trial, or zero.
   * Cleared once the raised scale has held for `RAISE_TRIAL_WINDOWS`.
   */
  private raisedFrom = 0;
  private sinceRaise = 0;
  /** Set once a drop has bought nothing: the frame is not bound by pixels, so nothing here helps. */
  private stopped = false;

  /**
   * @param handle The mounted scene. One that exposes no `resolution` is left alone, which is
   *   how a host stays able to mount a scene that has nothing to say about density.
   * @param limits Overrides for `DEFAULT_GOVERNOR_LIMITS`, which are already tuned against real
   *   false positives and should usually be left alone.
   */
  constructor(handle: DemoHandle, limits: Partial<GovernorLimits> = {}) {
    const resolved = { ...DEFAULT_GOVERNOR_LIMITS, ...DEMO_GOVERNOR_LIMITS, ...limits };
    this.minScale = resolved.minScale;
    this.recent = new Float64Array(resolved.windowFrames);
    this.control = handle.resolution;
    /*
     * Seeded from the ceiling in force rather than from the one the profile asked for. The two
     * differ exactly where this matters most: `capabilityClamp` lowers the request on the weak
     * devices a governor exists for, and a governor started above the truth would spend its
     * first decisions walking back down to it.
     */
    this.governor =
      this.control === undefined
        ? undefined
        : new ResolutionGovernor(this.control.ceiling, resolved);
  }

  /**
   * Whether there is any softening left to try.
   *
   * **A host must ask this before it gives up on a scene, and the ordering is the whole point.**
   * A probe that stops a scene on its own measurement will always win the race, because it
   * judges over fewer frames than a governor needs to reach a decision: forty-eight against
   * sixty, measured, so the first wiring of this class never dropped a single step and the
   * governor was decoration. The two are not competing answers to one question. Softening is
   * what to do while there is room, and stopping is what to do when there is not.
   */
  get exhausted(): boolean {
    return this.governor === undefined || this.stopped || this.governor.scale <= this.minScale;
  }

  /** Whether this scene offered a lever at all. */
  get active(): boolean {
    return this.governor !== undefined;
  }

  /**
   * One frame, in the units `DemoHandle.frame` already receives.
   *
   * Returns the new density when it moved and `null` on every ordinary frame, so a caller that
   * wants to report the change can, and one that does not can ignore the result entirely.
   *
   * **`hidden` is not slowness.** A frame while the tab is in the background or the canvas is
   * off screen carries the whole gap since the last one, and a governor that believed it would
   * soften a scene that was never asked to draw. This is the same distinction the game's own
   * frame health draws between a playable frame and a menu, and it cost a report from an
   * RTX 3060 calling itself unplayable to learn it.
   */
  observe(dtSec: number, hidden = false): number | null {
    const governor = this.governor;
    const control = this.control;
    if (governor === undefined || control === undefined || this.stopped || hidden) return null;
    const frameMs = dtSec * 1000;
    this.recent[this.recentAt] = frameMs;
    this.recentAt = (this.recentAt + 1) % this.recent.length;
    if (this.raisedFrom > 0 && ++this.sinceRaise > this.recent.length * RAISE_TRIAL_WINDOWS) {
      this.raisedFrom = 0;
    }

    if (this.judgingFromMs > 0 && this.judge(frameMs)) {
      /*
       * Given back, and the governor stops for the rest of the visit: the frame was no faster with
       * fewer pixels, so a second drop would buy as little as the first, and a reader would be
       * left looking at a softer picture of the same stutter.
       */
      this.stopped = true;
      control.apply(this.judgingScale);
      return this.judgingScale;
    }

    const before = governor.scale;
    const next = governor.sample(frameMs, true);
    if (next === null) return null;
    if (next < before) {
      /*
       * A drop while a raise is on trial says the raise was wrong, and the scale it came from is
       * the highest this machine has been seen to hold. Without this the governor climbs and falls
       * every few seconds on a machine whose limit sits between two of its steps, which is the
       * density of the picture changing for the whole visit.
       */
      if (this.raisedFrom > 0) governor.setCeiling(this.raisedFrom);
      this.raisedFrom = 0;
      this.judgingFromMs = this.meanRecentMs();
      this.judgingScale = before;
      this.settling = SETTLE_FRAMES;
      this.afterSumMs = 0;
      this.afterFrames = 0;
    } else {
      this.raisedFrom = before;
      this.sinceRaise = 0;
    }
    control.apply(next);
    return next;
  }

  /** One frame after a drop. True once a window of them shows the drop bought nothing. */
  private judge(frameMs: number): boolean {
    if (this.settling > 0) {
      this.settling--;
      return false;
    }
    this.afterSumMs += frameMs;
    this.afterFrames++;
    if (this.afterFrames < this.recent.length) return false;
    const afterMs = this.afterSumMs / this.afterFrames;
    const fromMs = this.judgingFromMs;
    this.judgingFromMs = 0;
    return afterMs > fromMs * WORTHWHILE;
  }

  private meanRecentMs(): number {
    let sum = 0;
    for (let i = 0; i < this.recent.length; i++) sum += this.recent[i] ?? 0;
    return sum / this.recent.length;
  }
}
