/**
 * What a wall does to a sound, and how often it is worth asking whether there is one.
 *
 * **The engine owns the curve and the consumer owns the number.** How blocked a path is depends on
 * a world this package has never seen; what blocking *sounds* like does not. So a consumer answers
 * "how much wall" and everything below decides what that means.
 */

/** Wide open: above hearing, so an unoccluded source is not filtered at all. */
const OPEN_HZ = 20000;
/**
 * Shut: 500 Hz.
 *
 * Low enough that consonants and the top of anything percussive are gone, which is what makes a
 * sound read as being *through* something. Not lower: below about 300 Hz a voice stops sounding
 * muffled and starts sounding like a different sound in a different place.
 */
const SHUT_HZ = 500;
/**
 * How far a fully blocked source drops, as a gain.
 *
 * About twelve decibels. **Not zero, and that is the decision here.** A source that goes silent
 * behind a wall pops out of existence, and a player learns that walls delete sounds rather than
 * muffle them — which is worse than no occlusion at all, because it removes the information that
 * the thing is still there. Cost: a source behind a wall is never *gone*, so a consumer wanting
 * something genuinely inaudible has to stop it rather than occlude it. What would make this wrong
 * is a game where hearing through a wall is a mechanic to be denied, which is a design decision
 * rather than an acoustic one.
 */
const SHUT_GAIN = 0.25;

/** Geometric, for the reason `liftFrequencyHz` gives. Open above hearing, shut at 500 Hz. */
export function occlusionCutoffHz(amount: number): number {
  const t = clamp01(amount);
  return OPEN_HZ * (SHUT_HZ / OPEN_HZ) ** t;
}

/** Level for a given occlusion. 1 clear, `SHUT_GAIN` solid, linear between. */
export function occlusionGainFor(amount: number): number {
  return 1 - (1 - SHUT_GAIN) * clamp01(amount);
}

/**
 * Exponential approach, in time.
 *
 * `rate` is per second and means the same thing at 60 Hz, at 144 Hz and at whatever a background
 * tab does. A per-step factor is the bug `AGENTS.md` records: the same constant meant 47 ms in one
 * caller and 158 ms in another, and moved with the frame rate in the second.
 */
export function smoothToward(current: number, target: number, rate: number, dtSec: number): number {
  if (!(dtSec > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-rate * dtSec));
}

/**
 * When a source is allowed to ask the world whether something is in the way.
 *
 * A segment test per source per frame is the most expensive thing occlusion can do, and it is paid
 * by the consumer's own collision code — which is exactly why the throttling lives here rather
 * than being left for them to discover. Each source is probed once per period, and the phase is
 * spread across its index, so twenty sources are twenty single tests rather than one spike.
 *
 * Cost: a wall that appears between a source and the listener takes up to one period to be heard,
 * and the smoothing above adds its own approach on top of that. At the default that is well under
 * the time a player takes to walk through a doorway. What would make this wrong is a source moving
 * faster than the period — a projectile — which should be probed every frame and say so.
 */
export class ProbeScheduler {
  private lastAt = new Map<number, number>();

  constructor(private readonly periodSec = 0.2) {}

  due(index: number, count: number, nowSec: number): boolean {
    const spread = count > 0 ? (index / count) * this.periodSec : 0;
    const last = this.lastAt.get(index);
    if (last === undefined) {
      // The first turn is taken at this source's own phase, not immediately, or every source
      // created in one frame probes in that frame and the stagger never starts.
      if (nowSec < spread) return false;
      this.lastAt.set(index, nowSec);
      return true;
    }
    if (nowSec - last < this.periodSec) return false;
    this.lastAt.set(index, nowSec);
    return true;
  }

  forget(index: number): void {
    this.lastAt.delete(index);
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}
