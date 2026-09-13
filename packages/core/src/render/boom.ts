import { withDefaults } from '../core/withDefaults.ts';
import { clamp, damp } from '../math/scalar.ts';

/**
 * The arm between a camera and what it is looking at, and how fast it may change
 * length.
 *
 * Every third-person rig needs the same thing: shorten against geometry so the
 * camera is never inside a wall, and do it *gradually*, because the raw answer
 * from a collision query is a step function. This was written twice — once
 * correctly in the replay camera, after it was reported as juddering and jumpy,
 * and once not at all in the gameplay camera, which applied the query's
 * fraction directly and popped by up to 4 m whenever a railing swept across it.
 * One implementation, so a third rig cannot get it wrong again.
 *
 * Stateful and long-lived, hence a class: one per rig, mutated in place, nothing
 * allocated per frame.
 */

/**
 * How fast the boom changes length: quick to come in, slow to go back out.
 *
 * Asymmetric because the two directions have different failure modes. Coming in
 * late means a frame or two looking through a post, which reads as a lens flare;
 * going out early means the camera lunges away from the subject the instant an
 * obstruction clears, which reads as the camera being kicked. So retraction is
 * roughly twice as eager as extension, and neither is instant.
 */
const RETRACT_LAMBDA = 14;
const EXTEND_LAMBDA = 6;
/**
 * And a ceiling on how fast it may travel, in metres per second.
 *
 * Damping alone is not enough, because damping is proportional: a 12 m boom asked
 * to retract to its minimum still moves 2.2 m on the first frame, which is the
 * same pop an octave quieter. A speed limit makes the guarantee absolute and
 * states it in the unit that matters — the camera is an arm on a crane, and a
 * crane has a top speed.
 *
 * The cost is honest and worth naming: a boom that genuinely needs its full
 * length taken away, because the subject has gone behind a wall, spends about a
 * second getting there and can be inside that wall while it does. That is the
 * right trade. The obstruction is almost always a lamp post or a railing sweeping
 * across the line for a few frames — where a speed limit removes the artefact
 * completely — and a moment of seeing through a post is a lens artefact, where a
 * 5 m lurch is a broken camera.
 */
const RETRACT_SPEED = 12;
const EXTEND_SPEED = 5;

/**
 * The four numbers above, as something a caller can set.
 *
 * **The defaults are written for an arm of several metres and they do not scale down.** The speed
 * ceilings are stated in metres a second, which is the unit that matters for a crane and the wrong
 * one for an arm shorter than a hand: on a 170 mm boom neither ceiling ever binds, only the damping
 * acts, and the trade the ceilings were chosen for is not the trade being made. Reported from
 * outside on a 46 mm subject — a lip sweeping across a 170 mm arm left the eye **71 mm inside the
 * wall on the first tick and inside it at all for 78 ticks of 120, 1.30 seconds** — which on a
 * subject that small renders the inside of the masonry: a black screen with the game running
 * perfectly behind it.
 *
 * **`Infinity` is the immediate answer and needs no special case.** `damp` is
 * `lerp(a, b, 1 - exp(-lambda dt))`, so an infinite lambda returns the target exactly, and an
 * infinite speed leaves the clamp unbounded. A rig that must come out of a wall on the tick it
 * touches one passes `retractLambda: Infinity, retractSpeed: Infinity` and keeps the easing on the
 * way back out, which is the half that stops the picture pumping.
 */
export interface BoomTiming {
  /** How eagerly the arm shortens against an obstruction. Higher is quicker. */
  readonly retractLambda: number;
  /** And how eagerly it lengthens once the obstruction clears. Lower is gentler. */
  readonly extendLambda: number;
  /** A ceiling on how fast it may shorten, in metres a second. */
  readonly retractSpeed: number;
  /** And on how fast it may lengthen. */
  readonly extendSpeed: number;
}

/** What every rig got before the timings could be set, and what one that says nothing still gets. */
export const DEFAULT_BOOM_TIMING: BoomTiming = {
  retractLambda: RETRACT_LAMBDA,
  extendLambda: EXTEND_LAMBDA,
  retractSpeed: RETRACT_SPEED,
  extendSpeed: EXTEND_SPEED,
};

export class Boom {
  /** How much of the arm is currently extended, 0–1. */
  fraction = 1;

  private readonly timing: BoomTiming;

  constructor(timing: Partial<BoomTiming> = {}) {
    this.timing = withDefaults(DEFAULT_BOOM_TIMING, timing);
  }

  /** Place the arm outright, for a cut or a teleport. */
  reset(fraction: number): void {
    this.fraction = fraction;
  }

  /**
   * Move toward `clear` — the fraction of the arm that is unobstructed, already
   * clamped by the caller to whatever minimum its framing needs.
   *
   * `lengthM` is the arm's full length, because the speed limit is stated in
   * metres and a fraction covers more ground on a longer arm.
   */
  step(clear: number, lengthM: number, dt: number): number {
    const coming = clear < this.fraction;
    const timing = this.timing;
    const eased = damp(
      this.fraction,
      clear,
      coming ? timing.retractLambda : timing.extendLambda,
      dt,
    );
    const step = ((coming ? timing.retractSpeed : timing.extendSpeed) * dt) / (lengthM || 1);
    this.fraction = clamp(eased, this.fraction - step, this.fraction + step);
    return this.fraction;
  }
}
