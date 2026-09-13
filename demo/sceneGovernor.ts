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
 * What a demo changes about the game's tuning, and the one thing it does not.
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
 */
const DEMO_GOVERNOR_LIMITS: Partial<GovernorLimits> = { windowFrames: 30 };

export class SceneGovernor {
  private readonly control: ResolutionControl | undefined;
  private readonly governor: ResolutionGovernor | undefined;
  private readonly minScale: number;

  /**
   * @param handle The mounted scene. One that exposes no `resolution` is left alone, which is
   *   how a host stays able to mount a scene that has nothing to say about density.
   * @param limits Overrides for `DEFAULT_GOVERNOR_LIMITS`, which are already tuned against real
   *   false positives and should usually be left alone.
   */
  constructor(handle: DemoHandle, limits: Partial<GovernorLimits> = {}) {
    const resolved = { ...DEFAULT_GOVERNOR_LIMITS, ...DEMO_GOVERNOR_LIMITS, ...limits };
    this.minScale = resolved.minScale;
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
    return this.governor === undefined || this.governor.scale <= this.minScale;
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
    if (this.governor === undefined || this.control === undefined) return null;
    const next = this.governor.sample(dtSec * 1000, !hidden);
    if (next === null) return null;
    this.control.apply(next);
    return next;
  }
}
