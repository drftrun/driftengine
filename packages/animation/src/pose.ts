/**
 * A pose: one transform per joint, as three flat arrays rather than an array of objects.
 *
 * **Structure-of-arrays because a pose is bulk data on a hot path.** A rig is sixty to ninety
 * joints and a scene holds several characters, so a pose per character per frame as objects is
 * exactly the allocation the performance rules forbid. Three typed arrays are claimed once and
 * written in place for the character's whole life, and the palette they resolve into is
 * contiguous for the same reason.
 *
 * What it costs is that reading one joint is three indexed reads rather than a property access.
 * What would make it wrong is a caller needing to hold a single joint's transform as a value —
 * which `blend.ts`'s `setJoint` answers by writing rather than by handing one out.
 */

export interface Pose {
  /** Three floats a joint. */
  readonly translation: Float32Array;
  /** Four floats a joint, xyzw, in the order `gl-matrix` uses. */
  readonly rotation: Float32Array;
  /** Three floats a joint. */
  readonly scale: Float32Array;
}

/**
 * A pose sized for `jointCount` joints, already at rest.
 *
 * **At rest rather than zeroed**, and that is a correctness matter rather than a convenience.
 * A zero quaternion normalises to NaN and a zero scale collapses every vertex the joint touches,
 * so a caller who allocates a pose and forgets to rest it would get a rig that vanishes rather
 * than one that stands still. The same reasoning `vertexDefaults.ts` gives for handing an absent
 * tangent `(1, 0, 0, 1)` instead of zero: the safe default is a usable value, never a sentinel
 * that arithmetic turns into NaN.
 */
export function createPose(jointCount: number): Pose {
  const pose: Pose = {
    translation: new Float32Array(jointCount * 3),
    rotation: new Float32Array(jointCount * 4),
    scale: new Float32Array(jointCount * 3),
  };
  restPose(jointCount, pose);
  return pose;
}

/**
 * Write the rest pose — no translation, identity rotation, unit scale — into an existing pose.
 *
 * Separate from `createPose` so a caller can return a pose to rest without allocating a second
 * one, which is what a state machine does when it re-enters a state.
 */
export function restPose(jointCount: number, out: Pose): void {
  out.translation.fill(0);
  out.scale.fill(1);
  for (let j = 0; j < jointCount; j++) {
    const at = j * 4;
    out.rotation[at] = 0;
    out.rotation[at + 1] = 0;
    out.rotation[at + 2] = 0;
    out.rotation[at + 3] = 1;
  }
}
