import { mat3, quat, vec3 } from 'gl-matrix';

import type { Pose } from './pose.ts';
import type { Skeleton } from './skeleton.ts';

/**
 * Two-bone inverse kinematics: put a chain's tip on a target, closed form.
 *
 * **Closed form rather than iterative**, because two bones and a target are a triangle and a
 * triangle has an answer. An iterative solver — FABRIK, or gradient descent — earns its keep on
 * longer chains where there is no closed form; spending iterations on a case with an exact
 * solution buys nothing and makes the result depend on how many were run, which a replay cannot
 * tolerate.
 *
 * What it does not do is limits, twist or more than two bones. A knee that should not hyperextend
 * is a constraint this does not know about, and it is a game's decision rather than the engine's —
 * the same line the state machine draws about a character's verbs.
 */

/**
 * Reach `target` with the chain `root` → `mid` → `tip`, writing the two rotations into `pose`.
 *
 * Returns whether the target was reachable. An unreachable one straightens the chain toward it,
 * which is the behaviour a limb should have: an arm reaching for something too far away extends,
 * it does not give up or fold.
 *
 * `poleHint` decides the one thing the target cannot — which way the joint bends. A world-space
 * point or direction the mid joint should lean toward; without it, a chain that is already
 * straight has no plane to bend in and the elbow would flip unpredictably as a character turned.
 *
 * The skeleton's world matrices are refreshed as it goes, so they are current when this returns.
 */
export function solveTwoBone(
  skeleton: Skeleton,
  pose: Pose,
  root: number,
  mid: number,
  tip: number,
  target: ArrayLike<number>,
  poleHint: ArrayLike<number>,
): boolean {
  const joints = skeleton.joints;
  if (joints[mid]?.parent !== root || joints[tip]?.parent !== mid) {
    throw new Error(
      `solveTwoBone: ${root} → ${mid} → ${tip} is not a parent-to-child chain in this skeleton`,
    );
  }

  skeleton.applyPose(pose);
  worldPosition(skeleton, root, ROOT_POS);
  worldPosition(skeleton, mid, MID_POS);
  worldPosition(skeleton, tip, TIP_POS);

  const upper = vec3.distance(ROOT_POS, MID_POS);
  const lower = vec3.distance(MID_POS, TIP_POS);
  vec3.set(TARGET, target[0] as number, target[1] as number, target[2] as number);
  vec3.subtract(TO_TARGET, TARGET, ROOT_POS);
  const reach = vec3.length(TO_TARGET);

  /*
   * A chain with a zero-length bone, or a target sitting exactly on the root, has no triangle at
   * all — every angle below would come from a division by zero. Answered by leaving the pose alone
   * and reporting failure, because no pose is more correct than the one the animation produced.
   */
  if (upper <= EPSILON || lower <= EPSILON || reach <= EPSILON) return false;

  /*
   * The reachable band. Past `upper + lower` the chain cannot stretch; inside `|upper - lower|` it
   * cannot fold that far. Both make the law of cosines take an argument outside [-1, 1], where
   * `Math.acos` answers NaN — and a NaN rotation reaches the palette and takes every vertex the
   * joint touches. Clamped rather than refused, so the chain still points the right way.
   */
  const longest = upper + lower;
  const shortest = Math.abs(upper - lower);
  const reachable = reach <= longest && reach >= shortest;
  const distance = Math.min(Math.max(reach, shortest + EPSILON), longest - EPSILON);

  /*
   * **The mid joint first, and the order is the whole of it.** Rotating the root turns its entire
   * subtree, so it changes where the chain *points* and never how long it is — only the mid joint
   * can set `|tip - root|`. Bending the root first, as the obvious reading of the triangle
   * suggests, leaves the tip at whatever length the pose already had and the aim step then puts it
   * on the wrong point of the right ray. Measured as a tip 1.22 units out where 1.00 was wanted.
   */
  vec3.subtract(TO_ROOT, ROOT_POS, MID_POS);
  vec3.subtract(TO_TIP, TIP_POS, MID_POS);
  const midNow = angleBetween(TO_ROOT, TO_TIP);
  const midWanted = Math.acos(
    clampCosine((upper * upper + lower * lower - distance * distance) / (2 * upper * lower)),
  );
  bendAxis(TO_ROOT, TO_TIP, poleHint, ROOT_POS, AXIS);
  rotateJointAboutWorldAxis(skeleton, pose, mid, AXIS, midWanted - midNow);
  skeleton.applyPose(pose);

  /*
   * Now the chain is the right length, so aiming it puts the tip on the target exactly — where a
   * chain of the wrong length would land on the right ray at the wrong distance.
   */
  worldPosition(skeleton, root, ROOT_POS);
  worldPosition(skeleton, tip, TIP_POS);
  vec3.subtract(CHAIN_DIR, TIP_POS, ROOT_POS);
  vec3.subtract(TO_TARGET, TARGET, ROOT_POS);
  if (vec3.length(CHAIN_DIR) > EPSILON && vec3.length(TO_TARGET) > EPSILON) {
    vec3.normalize(CHAIN_DIR, CHAIN_DIR);
    vec3.normalize(TO_TARGET, TO_TARGET);
    quat.rotationTo(AIM, CHAIN_DIR, TO_TARGET);
    applyWorldRotation(skeleton, pose, root, AIM);
    skeleton.applyPose(pose);
  }

  /*
   * **The roll, which is what the pole is actually for.** Aiming leaves the chain free to spin
   * about the line to the target, and every angle of that spin puts the tip in the same place — so
   * nothing above decides which way the elbow points. Without this an elbow flips unpredictably as
   * a character turns, which is the defect a pole hint exists to prevent.
   */
  rollTowardPole(skeleton, pose, root, mid, poleHint);
  skeleton.applyPose(pose);

  return reachable;
}

/**
 * An axis to bend the mid joint about: **the normal of the chain's own plane**.
 *
 * **Not "anything perpendicular to the bone", which is what this used to say and is what made the
 * solver land short.** The angle asked for above is the interior angle at the mid joint, and
 * rotating by `midWanted - midNow` produces exactly that angle only when the rotation happens *in*
 * the plane the angle is measured in. Any other axis turns the bone out of that plane instead, so
 * the interior angle changes by less than was asked and `|tip - root|` comes out short — after
 * which the aim step lands the tip on the right ray at the wrong distance.
 *
 * The old axis was the bone crossed with the *pole*, and **that is right exactly when the pole lies
 * in the chain's plane** — which is why this survived as long as it did. Every case in `ik.test.ts`
 * put the pole in that plane, and the first test written for the report did too and passed against
 * the unfixed solver. A knee's pole points where the character faces; the plane its leg bends in is
 * wherever the animation left it, and the two coincide only by accident.
 *
 * Reported from outside as a chain reaching its target on the second call and not the first, with
 * the residual falling to zero and staying there — which is a solver converging, and a closed-form
 * solver has nothing to converge. Held now by a leg with a 0.46 m thigh, a 0.44 m shin and a pole
 * off the plane: 0.028 short of its target without this, under a micrometre with it.
 *
 * **The pole is still what decides the bend for a chain with no plane.** A straight chain has
 * `root`, `mid` and `tip` collinear and the cross product below is zero; there is genuinely no
 * plane to bend in, and the pole is the only thing that can choose one. Two non-parallel fallbacks
 * follow it, so a bone parallel to one is not parallel to the other.
 */
function bendAxis(
  toRoot: vec3,
  toTip: vec3,
  poleHint: ArrayLike<number>,
  rootPos: vec3,
  out: vec3,
): void {
  vec3.cross(out, toRoot, toTip);
  if (vec3.length(out) > EPSILON) {
    vec3.normalize(out, out);
    return;
  }
  vec3.set(POLE, poleHint[0] as number, poleHint[1] as number, poleHint[2] as number);
  vec3.subtract(POLE, POLE, rootPos);
  vec3.cross(out, toTip, POLE);
  if (vec3.length(out) > EPSILON) {
    vec3.normalize(out, out);
    return;
  }
  vec3.cross(out, toTip, FALLBACK_POLE);
  if (vec3.length(out) <= EPSILON) vec3.cross(out, toTip, SECOND_FALLBACK);
  vec3.normalize(out, out);
}

/**
 * Spin the chain about the line to the target until the mid joint faces the pole.
 *
 * Both the elbow and the pole are projected onto the plane perpendicular to that line, because the
 * component *along* it is the part the spin cannot change — comparing the unprojected directions
 * would ask for a rotation that does not exist and answer with one that moves the tip.
 */
function rollTowardPole(
  skeleton: Skeleton,
  pose: Pose,
  root: number,
  mid: number,
  poleHint: ArrayLike<number>,
): void {
  worldPosition(skeleton, root, ROOT_POS);
  worldPosition(skeleton, mid, MID_POS);
  worldPosition(skeleton, tipOf(skeleton, mid), TIP_POS);
  vec3.subtract(TO_TARGET, TIP_POS, ROOT_POS);
  if (vec3.length(TO_TARGET) <= EPSILON) return;
  vec3.normalize(TO_TARGET, TO_TARGET);

  vec3.set(POLE, poleHint[0] as number, poleHint[1] as number, poleHint[2] as number);
  vec3.subtract(POLE, POLE, ROOT_POS);
  vec3.subtract(UPPER_DIR, MID_POS, ROOT_POS);

  projectOntoPlane(UPPER_DIR, TO_TARGET, ELBOW_FLAT);
  projectOntoPlane(POLE, TO_TARGET, POLE_FLAT);
  if (vec3.length(ELBOW_FLAT) <= EPSILON || vec3.length(POLE_FLAT) <= EPSILON) return;
  vec3.normalize(ELBOW_FLAT, ELBOW_FLAT);
  vec3.normalize(POLE_FLAT, POLE_FLAT);

  /* Signed about the aim direction, so the roll turns the short way and to the right side. */
  vec3.cross(AXIS, ELBOW_FLAT, POLE_FLAT);
  const angle = Math.atan2(vec3.dot(AXIS, TO_TARGET), vec3.dot(ELBOW_FLAT, POLE_FLAT));
  rotateJointAboutWorldAxis(skeleton, pose, root, TO_TARGET, angle);
}

/** The child of `joint` in this skeleton, which for a two-bone chain is its tip. */
function tipOf(skeleton: Skeleton, joint: number): number {
  for (let j = joint + 1; j < skeleton.jointCount; j++) {
    if (skeleton.joints[j]?.parent === joint) return j;
  }
  return joint;
}

/** The part of `v` with its component along `normal` removed. */
function projectOntoPlane(v: vec3, normal: vec3, out: vec3): void {
  const along = vec3.dot(v, normal);
  vec3.scaleAndAdd(out, v, normal, -along);
}

/** A joint's world position: the translation column of its world matrix. */
function worldPosition(skeleton: Skeleton, joint: number, out: vec3): void {
  const at = joint * 16 + 12;
  vec3.set(
    out,
    skeleton.world[at] as number,
    skeleton.world[at + 1] as number,
    skeleton.world[at + 2] as number,
  );
}

/**
 * `acos` answers NaN a hair outside its domain, and a NaN rotation reaches the palette.
 *
 * **Defence in depth rather than the guard that matters**, which is worth saying because the
 * comment here claimed otherwise until it was perturbed: `distance` is already clamped into the
 * reachable band above, so every argument reaching this is inside [-1, 1] by construction and
 * removing the clamp leaves every test green. What it defends against is floating point on the
 * boundary of that band, which no deterministic test can reliably reach. Kept because the cost is
 * a comparison and the failure it prevents is a limb full of NaN.
 */
function clampCosine(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

function angleBetween(a: vec3, b: vec3): number {
  const lengths = vec3.length(a) * vec3.length(b);
  if (lengths <= EPSILON) return 0;
  return Math.acos(clampCosine(vec3.dot(a, b) / lengths));
}

/**
 * Turn a joint by `angle` about a **world-space** axis, by writing its local rotation.
 *
 * A joint's world rotation is its parent's times its own, so a world-space delta `Q` gives
 * `local' = inverse(parentWorld) · Q · parentWorld · local` — and conjugating a rotation about an
 * axis is the same rotation about the transformed axis. So the axis is taken into the parent's
 * frame and the delta applied there, which is one vector transform instead of three quaternion
 * products.
 */
function rotateJointAboutWorldAxis(
  skeleton: Skeleton,
  pose: Pose,
  joint: number,
  axis: vec3,
  angle: number,
): void {
  if (!Number.isFinite(angle) || Math.abs(angle) <= EPSILON) return;
  parentFrame(skeleton, joint, PARENT_ROT);
  mat3.invert(PARENT_ROT, PARENT_ROT);
  vec3.transformMat3(LOCAL_AXIS, axis, PARENT_ROT);
  vec3.normalize(LOCAL_AXIS, LOCAL_AXIS);
  quat.setAxisAngle(DELTA, LOCAL_AXIS, angle);
  composeInto(pose, joint, DELTA);
}

/** The same, for a delta already expressed as a world-space quaternion. */
function applyWorldRotation(skeleton: Skeleton, pose: Pose, joint: number, world: quat): void {
  parentFrame(skeleton, joint, PARENT_ROT);
  mat3.invert(INVERSE_PARENT, PARENT_ROT);
  quat.fromMat3(PARENT_QUAT, PARENT_ROT);
  quat.fromMat3(INVERSE_QUAT, INVERSE_PARENT);
  quat.multiply(DELTA, INVERSE_QUAT, world);
  quat.multiply(DELTA, DELTA, PARENT_QUAT);
  composeInto(pose, joint, DELTA);
}

/**
 * The rotation part of a joint's parent's world matrix, or identity for a root.
 *
 * **The columns are normalised, and without that a scaled rig is solved wrong.** A world matrix's
 * upper 3x3 carries the scale as well as the rotation, and one of this function's two callers reads
 * *quaternions* out of it: `quat.fromMat3` recovers a rotation from the matrix trace by way of
 * `sqrt(trace + 1)`, so scaling the matrix scales the trace while that `+ 1` stays put. What comes
 * back is not the original rotation at a different length — it is a **different rotation**, and
 * normalising the quaternion afterwards only fixes the length of something already pointing the
 * wrong way.
 *
 * Measured against `gl-matrix` alone, a known rotation scaled and read back: 13.98 degrees out at
 * scale 0.5, 61.59 at 0.007132, 22.89 at 140.2. Neither direction is safe and nothing but exactly 1
 * is close. Reported from outside against an animal 46 mm long whose model is authored in metres —
 * the chain came out the right length to a part in ten million and pointed 108.8 degrees wrong,
 * with `solveTwoBone` returning `true` while doing it.
 *
 * **Why no test here saw it**: a rig authored at the scale it is played at has determinant 1, where
 * `quat.fromMat3` is exact. A scale in the hierarchy is the ordinary way to reuse one rig at two
 * sizes, and every skeleton in this package's suite was built without one until that report.
 *
 * The bend step is unaffected either way — it transforms an *axis* through this frame and
 * normalises the result, so a uniform scale divides out — but it is normalised for both callers
 * rather than for one, because a frame that means "rotation" should not sometimes mean something
 * else depending on who asked.
 *
 * **Uniform scale is what this makes exact.** A non-uniform one leaves shear that no per-column
 * normalise can remove, and a zero-length column is a collapsed joint with no frame to recover;
 * both keep the axis they had rather than dividing by zero. A hierarchy at unit scale divides by 1
 * and gets precisely what it got before.
 */
function parentFrame(skeleton: Skeleton, joint: number, out: mat3): void {
  const parent = skeleton.joints[joint]?.parent ?? -1;
  if (parent < 0) {
    mat3.identity(out);
    return;
  }
  const at = parent * 16;
  mat3.set(
    out,
    skeleton.world[at] as number,
    skeleton.world[at + 1] as number,
    skeleton.world[at + 2] as number,
    skeleton.world[at + 4] as number,
    skeleton.world[at + 5] as number,
    skeleton.world[at + 6] as number,
    skeleton.world[at + 8] as number,
    skeleton.world[at + 9] as number,
    skeleton.world[at + 10] as number,
  );
  for (let column = 0; column < 3; column++) {
    const c = column * 3;
    const x = out[c] as number;
    const y = out[c + 1] as number;
    const z = out[c + 2] as number;
    const length = Math.hypot(x, y, z);
    if (length <= EPSILON) continue;
    out[c] = x / length;
    out[c + 1] = y / length;
    out[c + 2] = z / length;
  }
}

/** `pose.rotation[joint] = delta · pose.rotation[joint]`, normalised. */
function composeInto(pose: Pose, joint: number, delta: quat): void {
  const at = joint * 4;
  quat.set(
    CURRENT,
    pose.rotation[at] as number,
    pose.rotation[at + 1] as number,
    pose.rotation[at + 2] as number,
    pose.rotation[at + 3] as number,
  );
  quat.multiply(CURRENT, delta, CURRENT);
  quat.normalize(CURRENT, CURRENT);
  for (let c = 0; c < 4; c++) pose.rotation[at + c] = CURRENT[c] as number;
}

/**
 * Below this a length is zero and an angle is nothing.
 *
 * Not a tuning constant: it is the width of the band where the arithmetic above stops being
 * defined. Every use of it guards a division or an `acos` domain.
 */
const EPSILON = 1e-6;

/* Module scope, claimed once: a solve runs per chain per frame. */
const ROOT_POS = vec3.create();
const MID_POS = vec3.create();
const TIP_POS = vec3.create();
const TARGET = vec3.create();
const TO_TARGET = vec3.create();
const UPPER_DIR = vec3.create();
const CHAIN_DIR = vec3.create();
const TO_ROOT = vec3.create();
const TO_TIP = vec3.create();
const AXIS = vec3.create();
const POLE = vec3.create();
const ELBOW_FLAT = vec3.create();
const POLE_FLAT = vec3.create();
const LOCAL_AXIS = vec3.create();
const DELTA = quat.create();
const AIM = quat.create();
const CURRENT = quat.create();
const PARENT_ROT = mat3.create();
const INVERSE_PARENT = mat3.create();
const PARENT_QUAT = quat.create();
const INVERSE_QUAT = quat.create();
/* Two non-parallel axes, so a target parallel to one is not parallel to the other. */
const FALLBACK_POLE = vec3.fromValues(0, 0, 1);
const SECOND_FALLBACK = vec3.fromValues(1, 0, 0);
