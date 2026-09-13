import type { AnimationClip, JointTrack } from '@driftengine/drft';

import type { Pose } from './pose.ts';

/**
 * Keyframed clips, and sampling one into a pose.
 *
 * **Sampling is a pure function of a time the caller supplies, and that is a contract rather than
 * a style.** Nothing on this path reads `performance.now`, `Date.now` or `Math.random`, which is
 * what lets a recorded intent stream replay bit-identically on another machine. `AGENTS.md` calls
 * this the determinism boundary and `docs/ARCHITECTURE.md` §5 names animation specifically,
 * because it is the subsystem where every other engine reaches for a clock.
 *
 * What it costs is that a caller has to carry its own time. What would make it wrong is nothing —
 * a clip that wants wall-clock time can be handed one; the reverse is not recoverable.
 */

/*
 * The shapes come from the format package, which is where the `ANIM` chunk's contents belong —
 * and which is what lets `@driftengine/assets` produce a clip without either package depending on
 * the other. Re-exported here so a consumer of the animation barrel imports from one place.
 */
export type { AnimationClip, JointTrack, TrackPath } from '@driftengine/drft';

/**
 * Sample every track into `out`. Pure, allocation-free, and it reads no clock.
 *
 * **A joint no track mentions is left exactly as it was found**, which is what makes layering
 * work: a clip animating one arm can be sampled over a pose already holding the rest of the body.
 * The alternative — resting untouched joints — would make every partial clip a full-body clip and
 * silently overwrite whatever it was layered onto.
 */
export function sampleClip(clip: AnimationClip, timeSec: number, out: Pose): void {
  const time = wrapTime(timeSec, clip.durationSec);

  for (const track of clip.tracks) {
    const width = track.path === 'rotation' ? 4 : 3;
    const target =
      track.path === 'translation'
        ? out.translation
        : track.path === 'rotation'
          ? out.rotation
          : out.scale;
    sampleTrack(track, time, target, track.joint * width);
  }
}

/**
 * Sample one track at a time already brought into range, into `target` at `at`.
 *
 * **Split out of `sampleClip` so root motion reads the same interpolation rather than a second
 * copy of it.** Two implementations of one decision drift, and they drift invisibly when they
 * start identical — which is why this is a shared function and not eight lines repeated in
 * `rootMotion.ts`. Root motion needs one joint's two tracks at four different times a frame, and
 * sampling a whole rig four times to read one joint would be the alternative.
 *
 * `time` is **not** wrapped here: a caller asking for the value at exactly `durationSec` wants
 * the last key held, and wrapping would answer the first instead. `sampleClip` wraps before it
 * calls this; `rootMotion.ts` splits an interval at the loop boundary and asks for both ends.
 */
export function sampleTrack(
  track: JointTrack,
  time: number,
  target: Float32Array,
  at: number,
): void {
  const keys = track.times.length;
  if (keys === 0) return;
  const width = track.path === 'rotation' ? 4 : 3;

  /*
   * A single key is a constant, handled before the search so nothing divides by a zero interval.
   * Held at both ends rather than extrapolated, for the same reason a blend tree clamps: a pose
   * extrapolated past its last key puts limbs outside their range, which reads as a broken rig
   * rather than as a time out of bounds.
   */
  if (keys === 1 || time <= (track.times[0] as number)) {
    copyKey(track, 0, width, target, at);
    return;
  }
  if (time >= (track.times[keys - 1] as number)) {
    copyKey(track, keys - 1, width, target, at);
    return;
  }

  const upper = upperBound(track.times, time);
  const lower = upper - 1;
  const t0 = track.times[lower] as number;
  const t1 = track.times[upper] as number;
  /* t1 > t0 here: equal adjacent times would have been caught by one of the two holds above
     only at the ends, so guard the interior case rather than assuming a well-formed clip. */
  const span = t1 - t0;
  const alpha = span > 0 ? (time - t0) / span : 0;

  if (track.path === 'rotation') {
    slerpKeys(track, lower, upper, alpha, target, at);
    return;
  }

  const a = lower * width;
  const b = upper * width;
  for (let c = 0; c < width; c++) {
    const from = track.values[a + c] as number;
    const to = track.values[b + c] as number;
    target[at + c] = from + (to - from) * alpha;
  }
}

/**
 * Bring a time into `[0, duration)`.
 *
 * `%` is not enough: it answers a negative for a negative input, which would read the wrong pair
 * of keys rather than looping. A transition running backwards hands in a negative time, so this
 * is not hypothetical.
 *
 * Exported for `rootMotion.ts`, which needs the same wrap and the whole-cycle count that goes
 * with it — a second definition of "which instant of the clip is this" would be the drift this
 * repository has been bitten by twice.
 */
export function wrapTime(timeSec: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return timeSec - Math.floor(timeSec / durationSec) * durationSec;
}

/** The index of the first key strictly after `time`. Binary, because a clip can be long. */
function upperBound(times: Float32Array, time: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((times[mid] as number) > time) high = mid;
    else low = mid + 1;
  }
  return low;
}

function copyKey(
  track: JointTrack,
  key: number,
  width: number,
  target: Float32Array,
  at: number,
): void {
  const from = key * width;
  for (let c = 0; c < width; c++) target[at + c] = track.values[from + c] as number;
}

/**
 * Spherical interpolation between two rotation keys, along the **shorter** arc.
 *
 * The hemisphere correction is the whole of it: a quaternion and its negation are the same
 * orientation, so two keys can be numerically far apart while being geometrically close. Without
 * the flip a limb rotates the long way through the body, which is the most recognisable animation
 * defect there is.
 *
 * Written out rather than calling `quat.slerp` so nothing has to be copied into a scratch
 * quaternion and back: this runs per track per joint per frame, and the values live in a flat
 * array the caller owns.
 */
function slerpKeys(
  track: JointTrack,
  lower: number,
  upper: number,
  alpha: number,
  target: Float32Array,
  at: number,
): void {
  const a = lower * 4;
  const b = upper * 4;
  let ax = track.values[a] as number;
  let ay = track.values[a + 1] as number;
  let az = track.values[a + 2] as number;
  let aw = track.values[a + 3] as number;
  const bx = track.values[b] as number;
  const by = track.values[b + 1] as number;
  const bz = track.values[b + 2] as number;
  const bw = track.values[b + 3] as number;

  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    ax = -ax;
    ay = -ay;
    az = -az;
    aw = -aw;
    dot = -dot;
  }

  let s0: number;
  let s1: number;
  /*
   * Nearly parallel keys fall back to a straight blend, because `Math.acos` of a value at or past
   * 1 is 0 or NaN and dividing by `sin(0)` is the NaN that reaches the palette and takes every
   * vertex the joint touches. The threshold is where the two agree to well within float precision.
   */
  if (dot > 0.9995) {
    s0 = 1 - alpha;
    s1 = alpha;
  } else {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    s0 = Math.sin((1 - alpha) * theta) / sinTheta;
    s1 = Math.sin(alpha * theta) / sinTheta;
  }

  let x = s0 * ax + s1 * bx;
  let y = s0 * ay + s1 * by;
  let z = s0 * az + s1 * bz;
  let w = s0 * aw + s1 * bw;

  /* The straight-blend arm above shortens the quaternion, so normalise rather than assume. */
  const length = Math.hypot(x, y, z, w);
  if (length > 0) {
    x /= length;
    y /= length;
    z /= length;
    w /= length;
  }

  target[at] = x;
  target[at + 1] = y;
  target[at + 2] = z;
  target[at + 3] = w;
}
