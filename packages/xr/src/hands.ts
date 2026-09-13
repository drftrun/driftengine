/**
 * Twenty-five joints a hand, read into flat arrays.
 *
 * **The joint names are the specification's and their order is this file's**, fixed once as
 * `HAND_JOINTS` so an index means the same thing in every frame, on every device and in a recording
 * somebody kept. Reading them into a `Float32Array` rather than handing back objects is the same
 * decision every other per-frame reader in this engine makes: a hand is twenty-five poses, twice,
 * at ninety hertz, and an object per joint is four and a half thousand allocations a second on the
 * device this arrangement exists for.
 *
 * **A joint that is not tracked is not zeroed**, and that is the interesting decision here. Hand
 * tracking loses joints constantly, one at a time, as fingers occlude each other from the camera's
 * view. Writing an identity matrix into an untracked joint would collapse that finger to the wrist
 * for one frame and snap it back on the next, which reads as a violent twitch. So the last known
 * pose stays, `tracked` says it is stale, and a consumer decides whether to hold, fade or hide.
 * That is a policy a game owns, and this package refuses to make it for them.
 */

import type { XrFrame, XrHand, XrInputSource, XrJointPose } from './types.ts';

/**
 * Every joint WebXR defines, in the order this engine indexes them.
 *
 * Wrist first, then each finger from its base outward, which is the order the specification lists
 * them in and the order a reader expects. **Never reordered**: an index is written into recordings
 * and compared across runs, so moving one would change what a stored hand means.
 */
export const HAND_JOINTS = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
] as const;

export type HandJoint = (typeof HAND_JOINTS)[number];

export const JOINT_COUNT = HAND_JOINTS.length;

/** The index of a named joint, so a consumer never counts. */
export const JOINT_INDEX: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(HAND_JOINTS.map((name, index) => [name, index])),
);

/**
 * One hand's joints, allocated once and written into every frame.
 *
 * Sixteen floats a joint because a joint carries a full transform: a fingertip has an orientation
 * as well as a position, and a consumer drawing a mesh needs both.
 */
export class HandSkeleton {
  /** Row-major transforms, `JOINT_COUNT * 16`, in world space. */
  readonly matrices = new Float32Array(JOINT_COUNT * 16);
  /** Joint radii in metres, or 0 where the runtime offered none. */
  readonly radii = new Float32Array(JOINT_COUNT);
  /** Whether each joint had a pose in the last frame that was read. */
  readonly tracked = new Uint8Array(JOINT_COUNT);
  /** How many joints were tracked in that frame. Zero means the hand is not visible. */
  trackedCount = 0;

  /** Whether anything at all was seen, which is what a consumer branches on before drawing. */
  get visible(): boolean {
    return this.trackedCount > 0;
  }

  /**
   * Forget everything, which is what a source going away means.
   *
   * Separate from a frame where every joint is merely untracked: a hand that has left has no last
   * known pose worth holding, and a consumer that fades on loss needs the two told apart.
   */
  clear(): void {
    this.matrices.fill(0);
    this.radii.fill(0);
    this.tracked.fill(0);
    this.trackedCount = 0;
  }
}

/**
 * Read one hand into a skeleton.
 *
 * Returns whether anything was tracked. `false` with the skeleton left holding its last poses is
 * the ordinary case for a hand that has moved out of the cameras' view, and it is not an error.
 */
export function readHand(
  source: XrInputSource,
  frame: XrFrame,
  referenceSpace: unknown,
  into: HandSkeleton,
): boolean {
  const hand = source.hand as XrHand | undefined;
  if (hand === undefined || frame.getJointPose === undefined) {
    into.trackedCount = 0;
    into.tracked.fill(0);
    return false;
  }

  let tracked = 0;
  for (let i = 0; i < JOINT_COUNT; i++) {
    const space = hand.get(HAND_JOINTS[i] as string);
    const pose =
      space === undefined || space === null
        ? null
        : ((frame.getJointPose(space, referenceSpace) as XrJointPose | null | undefined) ?? null);

    if (pose === null) {
      /*
       * Left as it was. See the header: zeroing an occluded joint collapses that finger onto the
       * wrist for one frame and snaps it back on the next, and a hand tracker loses joints
       * constantly. The flag says the pose is stale; what to do about it is the consumer's.
       */
      into.tracked[i] = 0;
      continue;
    }

    into.matrices.set(pose.transform.matrix, i * 16);
    into.radii[i] = pose.radius ?? 0;
    into.tracked[i] = 1;
    tracked++;
  }

  into.trackedCount = tracked;
  return tracked > 0;
}

/** A joint's position, read out of the flat storage without allocating. */
export function jointPosition(
  skeleton: HandSkeleton,
  joint: HandJoint | number,
  out: Float32Array,
): boolean {
  const index = typeof joint === 'number' ? joint : (JOINT_INDEX[joint] ?? -1);
  if (index < 0 || index >= JOINT_COUNT) return false;
  /* Column-major, as every matrix in this engine is, so the translation is elements 12 to 14. */
  const at = index * 16;
  out[0] = skeleton.matrices[at + 12] as number;
  out[1] = skeleton.matrices[at + 13] as number;
  out[2] = skeleton.matrices[at + 14] as number;
  return skeleton.tracked[index] === 1;
}
