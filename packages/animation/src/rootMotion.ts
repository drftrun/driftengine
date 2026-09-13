import type { AnimationClip, JointTrack, TrackPath } from '@driftengine/drft';

import { sampleTrack, wrapTime } from './clip.ts';
import type { Pose } from './pose.ts';

/**
 * Root motion: how far the root travelled between two sample times, handed to the caller.
 *
 * **The point is that the character moves and the pose does not.** A walk cycle authored with a
 * moving root plays as a character sliding forward inside its own transform, and the rig then
 * fights whatever the game does with that transform. Root motion splits the two: `extractRootMotion`
 * answers the interval's displacement so a controller can apply it, and `stripRootMotion` pins the
 * pose's root so the displacement is not applied twice.
 *
 * **A pure function of the clip and two times, with no clock of its own** — the same contract
 * `sampleClip` makes and for the same reason. A recorded intent stream replays bit-identically
 * only if every step of the pose pipeline is a function of a time the caller supplies.
 *
 * ## The convention, and what it costs
 *
 * The delta is expressed **in the root's own frame at the earlier time**, so a caller applies it as
 *
 * ```
 * position = position + worldRotation * motion.translation
 * worldRotation = worldRotation * motion.rotation
 * ```
 *
 * which composes: stepping a clip in sixtieths and applying each delta arrives where one query
 * over the whole span says it should, and a character that has turned walks along its own forward
 * axis rather than along the clip's. The rejected alternative is a delta in the clip's own space,
 * which is one subtraction shorter and drags every turned character sideways.
 *
 * **What it gives up** is a vertical bob authored on the root: it leaves the pose along with
 * everything else and becomes motion the caller applies. A caller whose height is owned by a
 * physics controller ignores `translation[1]` — and then the bob is in neither the pose nor the
 * position, which is a real loss and the reason this is written down rather than discovered. **What
 * would make it wrong** is a consumer wanting per-axis control, and the honest answer then is a mask
 * on the extraction rather than a second convention.
 */

/** A root's displacement over an interval. Three floats and a quaternion, both caller-owned. */
export interface RootMotion {
  /** Three floats, in the root's frame at the earlier of the two times. */
  readonly translation: Float32Array;
  /** Four floats, xyzw, in the order `gl-matrix` uses. */
  readonly rotation: Float32Array;
}

/** A zero displacement, ready to be written into. Identity rather than zeroed, as `createPose` is. */
export function createRootMotion(): RootMotion {
  const motion: RootMotion = { translation: new Float32Array(3), rotation: new Float32Array(4) };
  motion.rotation[3] = 1;
  return motion;
}

/**
 * Write the root's displacement between `fromSec` and `toSec` into `out`. Allocates nothing.
 *
 * **Loops are accumulated rather than subtracted**, which is the whole difficulty. Sampling the
 * root at both times and subtracting answers a full stride *backwards* every time the clip wraps,
 * because the root snaps from the end of the cycle to the start of it. So the interval is split at
 * every loop boundary it crosses and the pieces are composed.
 *
 * `toSec` before `fromSec` is a clip running backwards and answers the negated motion, because a
 * transition played in reverse is a real caller — the same reason `wrapTime` handles a negative
 * time rather than assuming one cannot arrive.
 *
 * Cost is linear in the number of whole cycles between the two times. A fixed-step caller crosses
 * at most one boundary a frame, so that count is zero or one; a query spanning a hundred cycles
 * composes a hundred times, which is arithmetic rather than a hazard.
 */
export function extractRootMotion(
  clip: AnimationClip,
  rootJoint: number,
  fromSec: number,
  toSec: number,
  out: RootMotion,
): void {
  identity(out);

  const duration = clip.durationSec;
  const translation = findTrack(clip, rootJoint, 'translation');
  const rotation = findTrack(clip, rootJoint, 'rotation');
  if (translation === null && rotation === null) return;
  /* A clip with no duration wraps every time to the same instant, so nothing moved. */
  if (!(duration > 0)) return;

  const from = wrapTime(fromSec, duration);
  const to = wrapTime(toSec, duration);
  const crossings = Math.floor(toSec / duration) - Math.floor(fromSec / duration);

  if (crossings === 0) {
    composeSegment(translation, rotation, from, to, out);
    return;
  }

  /*
   * Forwards: the tail of the current cycle, then whole cycles, then the head of the last one.
   * Backwards is the same walk with the two ends of the clip exchanged, which is what makes the
   * negative case the negation of the positive rather than a second implementation.
   */
  const forwards = crossings > 0;
  const open = forwards ? 0 : duration;
  const close = forwards ? duration : 0;

  composeSegment(translation, rotation, from, close, out);
  const whole = Math.abs(crossings) - 1;
  for (let cycle = 0; cycle < whole; cycle++) {
    composeSegment(translation, rotation, open, close, out);
  }
  composeSegment(translation, rotation, open, to, out);
}

/**
 * Pin a sampled pose's root to the value the clip authored at time zero.
 *
 * The other half of the capability: whatever `extractRootMotion` handed the caller has to leave the
 * pose, or the character moves twice. Pinned to the clip's own first value rather than to the rest
 * pose, so a root authored a metre off the origin keeps its offset — resting it would drop every
 * character to the floor of its rig on the first frame.
 *
 * A joint that is not the root is left exactly as it was found, which is the same layering rule
 * `sampleClip` and `retargetPose` both keep.
 */
export function stripRootMotion(clip: AnimationClip, rootJoint: number, pose: Pose): void {
  const translation = findTrack(clip, rootJoint, 'translation');
  if (translation !== null) sampleTrack(translation, 0, pose.translation, rootJoint * 3);
  const rotation = findTrack(clip, rootJoint, 'rotation');
  if (rotation !== null) sampleTrack(rotation, 0, pose.rotation, rootJoint * 4);
}

/**
 * The track for one joint and one path, or null.
 *
 * A linear scan rather than an index, because a clip carries a few dozen tracks and this runs twice
 * per extraction — building a map would allocate one per clip and have to be invalidated when a
 * caller swaps a clip in place, which is worse than sixty comparisons.
 */
function findTrack(clip: AnimationClip, joint: number, path: TrackPath): JointTrack | null {
  for (const track of clip.tracks) {
    if (track.joint === joint && track.path === path) return track;
  }
  return null;
}

/** Compose one segment's local delta onto `out`. `t0` and `t1` are in range and not wrapped. */
function composeSegment(
  translation: JointTrack | null,
  rotation: JointTrack | null,
  t0: number,
  t1: number,
  out: RootMotion,
): void {
  FROM_T.fill(0);
  TO_T.fill(0);
  if (translation !== null) {
    sampleTrack(translation, t0, FROM_T, 0);
    sampleTrack(translation, t1, TO_T, 0);
  }
  identityInto(FROM_R);
  identityInto(TO_R);
  if (rotation !== null) {
    sampleTrack(rotation, t0, FROM_R, 0);
    sampleTrack(rotation, t1, TO_R, 0);
  }

  /* The segment's delta in the root's frame at `t0`: rotate the world difference back by the
     earlier orientation, and take the rotation that carries the earlier onto the later. */
  for (let c = 0; c < 3; c++) SEG_T[c] = (TO_T[c] as number) - (FROM_T[c] as number);
  conjugateInto(FROM_R, INVERSE);
  rotateVector(INVERSE, SEG_T);
  multiplyInto(INVERSE, TO_R, SEG_R);

  /* `out` then this segment: the segment's translation is expressed in the frame `out` ends in,
     so it is rotated by `out`'s rotation before it is added. */
  rotateVector(out.rotation, SEG_T);
  for (let c = 0; c < 3; c++) {
    out.translation[c] = (out.translation[c] as number) + (SEG_T[c] as number);
  }
  multiplyInto(out.rotation, SEG_R, COMPOSED);
  for (let c = 0; c < 4; c++) out.rotation[c] = COMPOSED[c] as number;
}

function identity(out: RootMotion): void {
  out.translation.fill(0);
  identityInto(out.rotation);
}

function identityInto(quaternion: Float32Array): void {
  quaternion[0] = 0;
  quaternion[1] = 0;
  quaternion[2] = 0;
  quaternion[3] = 1;
}

/** The inverse of a unit quaternion. Not normalised: every source here is a sampled unit. */
function conjugateInto(quaternion: Float32Array, out: Float32Array): void {
  out[0] = -(quaternion[0] as number);
  out[1] = -(quaternion[1] as number);
  out[2] = -(quaternion[2] as number);
  out[3] = quaternion[3] as number;
}

/** Quaternion product `a * b` into `out`. `out` must not alias either input. */
function multiplyInto(a: Float32Array, b: Float32Array, out: Float32Array): void {
  const ax = a[0] as number;
  const ay = a[1] as number;
  const az = a[2] as number;
  const aw = a[3] as number;
  const bx = b[0] as number;
  const by = b[1] as number;
  const bz = b[2] as number;
  const bw = b[3] as number;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * Rotate a three-vector by a unit quaternion, in place.
 *
 * `v + 2w(q x v) + 2(q x (q x v))`, written out rather than built from a matrix: a matrix would be
 * nine floats of scratch to save two cross products, and this runs four times a frame per
 * character.
 */
function rotateVector(quaternion: Float32Array, vector: Float32Array): void {
  const qx = quaternion[0] as number;
  const qy = quaternion[1] as number;
  const qz = quaternion[2] as number;
  const qw = quaternion[3] as number;
  const vx = vector[0] as number;
  const vy = vector[1] as number;
  const vz = vector[2] as number;

  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  vector[0] = vx + qw * tx + (qy * tz - qz * ty);
  vector[1] = vy + qw * ty + (qz * tx - qx * tz);
  vector[2] = vz + qw * tz + (qx * ty - qy * tx);
}

/* Module scope, claimed once: an extraction runs per character per frame. */
const FROM_T = new Float32Array(3);
const TO_T = new Float32Array(3);
const SEG_T = new Float32Array(3);
const FROM_R = new Float32Array(4);
const TO_R = new Float32Array(4);
const SEG_R = new Float32Array(4);
const INVERSE = new Float32Array(4);
const COMPOSED = new Float32Array(4);
