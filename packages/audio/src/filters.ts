/**
 * The curves: how a cutoff follows speed, and what the lift and slam controls do.
 *
 * Pure functions of a number, with the constants they are made of beside them. Separated
 * from the graph because none of them touches an AudioContext, a node or any class state,
 * and reading what a control does should not mean paging through the mix that applies it.
 *
 * The constants are exported rather than split: `AudioGraph` reads several of them directly,
 * and tearing a documented block in half so each half sits nearer its caller would put the
 * numbers in one file and the arithmetic in another.
 */

/**
 * Master low-pass cutoff in Hz for a given speed.
 *
 * Exponential in frequency because hearing is: a linear sweep spends most of
 * its travel in a range that sounds like almost nothing is happening. This is
 * the "filter opens as you hit full sprint" moment, so it has to track the
 * *feeling* of accelerating rather than the number.
 */
export function cutoffForSpeed(speed: number, maxSpeed: number): number {
  const safeMax = maxSpeed > 1e-6 ? maxSpeed : 1;
  const t = Math.min(Math.max(speed / safeMax, 0), 1);
  return 320 * (18000 / 320) ** t;
}

/**
 * Where the master low-pass stands until somebody moves it: open, at the top of its range.
 *
 * **It stood at `cutoffForSpeed(0, 1)` — 320 Hz — until 2026-09-19**, so every mix was heard
 * through a wall until its caller drove the speed curve above: one game's "the filter opens as you
 * sprint" standing in as every consumer's default. A game that wants its world muffled at rest
 * says so with `setCutoff(cutoffForSpeed(0, max))`, and one that never thought about it hears its
 * mix.
 */
export const MASTER_OPEN_HZ = 20000;

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

/**
 * The lift, at rest and at full.
 *
 * 20 Hz is below hearing, so at rest the high-pass is not there. 340 Hz takes the kick
 * and the bass line out while leaving the body of the track — far enough that the ground
 * goes with it, short of the telephone-speaker sound a build-up filter reaches for.
 *
 * The duck is what makes room for the wet: at 0.62 the dry track sits back far enough
 * for a six-second tail to be the loudest thing in the air, which is the whole point of
 * having one.
 */
export const LIFT_FLOOR_HZ = 20;

/**
 * The gate slam: how it is shaped, and how hard it hits.
 *
 * `SLAM_SHELF_HZ` is where the boost stops being bass and starts being body — a
 * shelf much above this pulls the kick's click and the bass line's fundamentals up
 * together, which is a volume jump rather than a low-end one.
 *
 * `SLAM_ATTACK_SEC` is deliberately shorter than a frame at 60 Hz. The hit has to
 * land on the tick the character crosses the plane; anything that swells into it reads
 * as the music doing something rather than the gate doing something.
 *
 * `SLAM_DUCK` pulls the dry path down as the wet comes up, so what changes is the
 * *character* of the moment and not simply the volume of it. Without it the slam is
 * a loudness spike, and a loudness spike on every gate is exhausting by the third.
 */
export const SLAM_SHELF_HZ = 120;
export const SLAM_SHELF_DB = 15;
export const SLAM_DRIVE = 0.7;
/**
 * Where the wet path's low-pass sits at rest and at the bottom of a slam.
 *
 * Open is above hearing, so the filter is a no-op between gates and the wet path is
 * whatever the shelf made of it. Closed is 240 Hz — bass and the very bottom of the
 * mid, which is the band a kick and a bass line live in and nothing else does.
 */
export const SLAM_OPEN_HZ = 20000;
export const SLAM_CLOSED_HZ = 240;
/**
 * How far the dry path ducks under the wet.
 *
 * Raised with the low-pass: the point of the pair is that for an instant the score is
 * *only* its bottom end, and that cannot happen while the unfiltered track is still
 * playing underneath at full level.
 */
export const SLAM_DUCK = 0.72;
export const SLAM_ATTACK_SEC = 0.012;
export const SLAM_DECAY_SEC = 0.11;
/**
 * How hard the soft clipper bites, as the `tanh` input scale.
 *
 * At 2.4 a signal at full scale comes back at about 0.4 of the way to a square wave
 * — audibly driven, still recognisably the track. The curve is normalised so unity
 * in is unity out, which keeps the wet path's own level honest.
 */
export const SLAM_CLIP_KNEE = 2.4;
const LIFT_CEILING_HZ = 340;
const LIFT_DUCK = 0.62;

/**
 * Where the high-pass sits at a given lift, in hertz.
 *
 * **Geometric, not linear.** Pitch is logarithmic: a linear sweep from 20 Hz to 340
 * spends half its travel between 20 and 180, which is almost entirely below the notes a
 * track is made of — so the first half of a jump would do nothing and the second half
 * would lurch. Geometrically, half a lift is the geometric mean (82 Hz) and every equal
 * step of the knob is an equal musical interval, which is what makes the effect read as a
 * sweep rather than as a switch.
 */
export function liftFrequencyHz(amount: number): number {
  return LIFT_FLOOR_HZ * (LIFT_CEILING_HZ / LIFT_FLOOR_HZ) ** clamp01(amount);
}

/** How far the dry track ducks at a given lift: 1 on the ground, `LIFT_DUCK` in the air. */
export function liftGainFor(amount: number): number {
  return 1 - (1 - LIFT_DUCK) * clamp01(amount);
}
