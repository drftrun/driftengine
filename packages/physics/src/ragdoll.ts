import { BODY_DYNAMIC } from './bodies.ts';
import { JOINT_CONE_TWIST } from './joints.ts';
import { capsuleShape } from './shape.ts';
import type { PhysicsWorld } from './world.ts';

/**
 * A ragdoll built from bones, where a bone is a joint and its parent.
 *
 * **It takes plain data and never learns what a skeleton is.** `Skeleton` lives in
 * `@driftengine/animation`, which imports core, the container package and `gl-matrix`; this package
 * imports no other engine package, and that is not a rule to bend for one function. So the builder
 * takes a parent array and a flat array of joint world matrices — both of which a skeleton already
 * exposes — and writes back through a *structural* target with `translation`, `rotation` and
 * `scale`, which `ShapePose` satisfies exactly. Nothing is imported in either direction, and the two
 * shapes cannot drift apart because neither names the other.
 *
 * **One capsule per bone, cone-twist jointed to its parent's.** A joint with no parent has no bone;
 * a humanoid's hips are usually that joint, and the spine and thigh bones hang off it.
 *
 * `drive` steers the bodies toward an animated pose rather than replacing them, which is what makes
 * a hit reaction. A fully limp ragdoll is the degenerate case of that, at weight zero.
 */

/** Anything shaped like an animation pose. Declared structurally so nothing is imported. */
export interface PoseTarget {
  readonly translation: Float32Array;
  readonly rotation: Float32Array;
  readonly scale: Float32Array;
}

export interface RagdollOptions {
  /** Capsule radius, as a fraction of the bone's length. */
  radiusRatio?: number;
  /** A floor under the radius, so a short bone is not a needle. */
  minRadius?: number;
  density?: number;
  /**
   * Cosine of the swing cone allowed: one number for every joint, or one per joint.
   *
   * **It was one number for a whole body until 2026-08-28, and a body is not one joint.** A knee is
   * a hinge with no twist; a shoulder is nearly a ball. Given one pair, a consumer chooses which of
   * the two is wrong — and the one who reported this chose loose, a 78° cone and 74° of twist at
   * every joint, with a comment saying tight limits look like a wooden puppet. What it produced was
   * reported from play as *a scrambled ball of things, limbs torso head mixed together*: at 78°
   * nothing stops a knee or an elbow folding a limb through the torso, so a body that lands rolls
   * itself into a knot.
   *
   * An array is **indexed by the joint, exactly as `parents` is**, so the entry at the knee limits
   * the knee: the joint a bone gets is the one at its parent end, and the bone at index `j` is the
   * one below joint `j`. Index 0 is a rig's root, which has no bone and therefore no joint, and its
   * entry is ignored. An index the array does not reach, or one holding anything that is not a
   * finite number, takes the default — which matters more than it sounds, because the alternative
   * reading of a missing entry is zero, and zero is a 90° cone at exactly the joint nobody thought
   * about.
   *
   * **What this does not buy is a real hinge.** A narrow cone with no twist is a *near* hinge: it
   * still bends a little in every direction, because a cone is a cone. A knee that cannot bend
   * sideways at all needs a revolute joint and an axis, and the axis is rig data this builder is
   * never given — a parent array and a set of world matrices do not say which way a knee folds.
   * **What would change it** is a consumer measuring that sideways bend as the problem, and the
   * answer then is a joint type per bone with the axis supplied, not a wider cone.
   *
   * **A value here is compared every tick, so compute it the way the block below computes its
   * defaults.** `Math.cos` is not specified precisely by ECMAScript, so a limit built with one is a
   * limit that can differ by a ulp between two engines, and a ragdoll that diverges. Write the
   * numbers down.
   */
  swingCos?: number | ArrayLike<number>;
  /** Sine of the half-angle of twist allowed: one number for every joint, or one per joint. */
  twistSin?: number | ArrayLike<number>;
  /** Bones shorter than this get no body, which is how a rig's leaf tips are skipped. */
  minLength?: number;
  layer?: number;
  mask?: number;
  /**
   * Whether the doll's own bones collide with each other. Default `true`.
   *
   * **Bones that share an end are excluded either way, and that is not a setting.** Two capsules
   * jointed end to end overlap near the joint by construction, because that is what having a
   * radius means, so every parent and child in a doll and every pair of siblings starts
   * interpenetrating. Left to resolve, that contact fights the joint holding them together: a
   * consumer measured it holding settled joints 14.2 cm open, turning a body at 3.0 rad/s while it
   * lay still, and propping it 28 cm off the road on its own thighs.
   *
   * **`false` is the cheap answer and it is measurably worse.** With nothing inside the doll
   * colliding, the cones alone do not stop a limb folding through the torso — the same consumer
   * measured a foot reaching 15% of its resting distance from the chest, which is a foot inside
   * the ribcage. Pass it for a crowd far enough away that nobody can see, and not otherwise.
   */
  selfCollision?: boolean;
}

export interface Ragdoll {
  /** Body index per joint, or −1 where the joint has no bone. */
  readonly bodyOf: Int32Array;
  /** How many bones were built. */
  readonly boneCount: number;
  /** Write the ragdoll's current shape into a pose. */
  writePose(out: PoseTarget): void;
  /** Steer the bodies toward a pose. Weight 1 tracks it, weight 0 goes limp. */
  drive(world: PhysicsWorld, pose: PoseTarget, weight: number): void;
  /**
   * Put every body back on its bone and clear its velocity.
   *
   * **A hit reaction starts from the pose the character is in now, and this is how it says so.**
   * A ragdoll is built once, because building one allocates bodies and joints and a hit is not
   * the moment for that — but between reactions the character keeps moving and the bodies do not.
   * They sit where the last reaction left them, or where they were on the frame the ragdoll was
   * built, and a reaction that begins by blending toward *that* snaps the character to a stale
   * shape somewhere else before it starts.
   *
   * `worldMatrices` is the same sixteen-floats-a-joint array `ragdollFromBones` took. The joints
   * are left alone: they connect bones and the bones have not changed length.
   */
  sync(world: PhysicsWorld, worldMatrices: Float32Array): void;
  /**
   * Where the first bone's parent end is now, so a caller can move the character's node.
   *
   * The **head** of that bone, which is a different point from the body holding it: a capsule is
   * built about its bone's middle, so the two are half a bone apart — 0.46 m for a root bone of
   * 0.92 m, which is a character standing in the air. Read all three or none; there is nothing
   * else here that answers a centre, and a caller wanting one reads `world.bodies` directly.
   *
   * **Two of these answered the centre until 2026-08-28 and the third only looked as if it did
   * not.** Reported from outside, where the symptom was a body drawn half a metre above the
   * physics holding it — which reads exactly like a pose that never arrived, and cost the reporter
   * two weeks of looking for one. `rootX` reached the centre through a helper named `boneHeadX`,
   * so the name answered the question and the arithmetic did not. **What would make this wrong**
   * is a rig whose first bone is not the one a caller wants to place a node by; `bodyOf` is the
   * door to any other bone, and this is the convenience for the common case.
   */
  rootX(): number;
  rootY(): number;
  rootZ(): number;
}

const TMP = new Float64Array(4);

/**
 * Build one.
 *
 * `worldMatrices` is sixteen floats a joint, column-major, exactly as a skinning pipeline's world
 * array is. `parents` is one index a joint, negative for a root.
 */
export function ragdollFromBones(
  world: PhysicsWorld,
  parents: ArrayLike<number>,
  worldMatrices: Float32Array,
  options: RagdollOptions = {},
): Ragdoll {
  const jointCount = parents.length;
  const radiusRatio = options.radiusRatio ?? 0.22;
  const minRadius = options.minRadius ?? 0.03;
  const density = options.density ?? 1000;
  /*
   * **Literals, not `Math.cos(Math.PI / 4)`.**
   *
   * These run once, when a ragdoll is built, so they looked like a legitimate build-time use — and
   * they are not, because what they produce is a *joint limit compared every tick*. ECMAScript does
   * not specify `cos` or `sin` precisely, so two engines would get swing cones a ulp apart and the
   * ragdoll would diverge. The determinism gate caught it, which is the whole reason that gate
   * scans the package rather than the tick: a value's *use* decides whether it may be computed,
   * not the moment it is computed at.
   *
   * `Math.SQRT1_2` is a constant rather than a call, and `cos(45°)` is exactly that. `sin(22.5°)`
   * has no named constant, so it is written out.
   */
  const swingCos = options.swingCos ?? Math.SQRT1_2;
  const twistSin = options.twistSin ?? 0.3826834323650898;
  const minLength = options.minLength ?? 0.02;

  /**
   * One limit, for one joint.
   *
   * Resolved per joint at build time rather than once for the rig, which is the whole of the
   * per-joint change: a scalar answers the same number everywhere and an array answers its entry,
   * with the default standing in wherever the array does not reach or holds something that is not a
   * number. `Number.isFinite` and not a truthiness test, because zero is a legitimate limit — a
   * 90° cone — and `NaN` is the one value that would reach the solver and stay there.
   */
  const limitAt = (given: number | ArrayLike<number>, fallback: number, joint: number): number => {
    if (typeof given === 'number') return given;
    const value = given[joint];
    return value === undefined || !Number.isFinite(value) ? fallback : value;
  };

  const bodyOf = new Int32Array(jointCount).fill(-1);
  /** `conj(bodyRotation) · jointWorldRotation`, so a pose can be recovered from a body. */
  const bodyToJoint = new Float32Array(jointCount * 4);
  const localRest = new Float32Array(jointCount * 3);
  const restRotation = new Float32Array(jointCount * 4);
  /**
   * Half of each bone's length, which is where its two ends are in its own body frame.
   *
   * A capsule stands along its own +y, so a bone's head is at `-halfOf[j]` and its tail at
   * `+halfOf[j]`. The bone's length and not the capsule's half height: `minLength` can float a
   * short bone's capsule out past the end of the bone it stands for, and the joint belongs where
   * the bones meet.
   */
  const halfOf = new Float32Array(jointCount);
  let boneCount = 0;
  let firstBone = -1;
  /** Half the first bone's length, which is how far its head sits from the body's centre. */
  let firstBoneHalf = 0;

  for (let j = 0; j < jointCount; j++) {
    const p = parents[j] ?? -1;
    matrixRotation(worldMatrices, j, restRotation, j * 4);
    if (p < 0) continue;

    const hx = worldMatrices[p * 16 + 12] ?? 0;
    const hy = worldMatrices[p * 16 + 13] ?? 0;
    const hz = worldMatrices[p * 16 + 14] ?? 0;
    const tx = worldMatrices[j * 16 + 12] ?? 0;
    const ty = worldMatrices[j * 16 + 13] ?? 0;
    const tz = worldMatrices[j * 16 + 14] ?? 0;
    localRest[j * 3] = tx - hx;
    localRest[j * 3 + 1] = ty - hy;
    localRest[j * 3 + 2] = tz - hz;

    const dx = tx - hx;
    const dy = ty - hy;
    const dz = tz - hz;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < minLength) continue;

    const radius = Math.max(minRadius, length * radiusRatio);
    // A capsule stands along y, so the body is turned to put its y along the bone.
    alignYTo(dx / length, dy / length, dz / length, TMP);
    const body = world.addBody({
      type: BODY_DYNAMIC,
      shape: capsuleShape(radius, Math.max(minLength, length / 2)),
      x: (hx + tx) / 2,
      y: (hy + ty) / 2,
      z: (hz + tz) / 2,
      qx: TMP[0],
      qy: TMP[1],
      qz: TMP[2],
      qw: TMP[3],
      density,
      layer: options.layer,
      mask: options.mask,
    });
    bodyOf[j] = body;
    halfOf[j] = length / 2;
    // What takes the body's rotation back to the joint's, captured while both are at rest.
    multiplyConjugate(TMP, restRotation, j * 4, bodyToJoint, j * 4);
    boneCount++;
    if (firstBone < 0) {
      firstBone = j;
      /* Taken here rather than derived later: this is the length the body was placed from, so
         the two cannot disagree, and a bone is rigid so it stays true for as long as the doll. */
      firstBoneHalf = length / 2;
    }
  }

  // Joint each bone to its parent's bone, at the shared end.
  for (let j = 0; j < jointCount; j++) {
    const body = bodyOf[j] ?? -1;
    if (body < 0) continue;
    const p = parents[j] ?? -1;
    const parentBody = p >= 0 ? (bodyOf[p] ?? -1) : -1;
    if (parentBody < 0) continue;
    world.addJoint({
      type: JOINT_CONE_TWIST,
      bodyA: parentBody,
      bodyB: body,
      /* `j` and not `p`: the joint a bone hangs from is the one at its own parent end, so the
         entry at the knee is the knee's. */
      swingCos: limitAt(swingCos, Math.SQRT1_2, j),
      twistSin: limitAt(twistSin, 0.3826834323650898, j),
      axisY: 1,
      /*
       * **The shared end, which is what makes the line above this loop true.**
       *
       * Given no anchors a joint takes the default `joints.ts` documents: B's centre, expressed in
       * A's frame. That default is right for what it was written for — it stops a fixed joint
       * yanking its body onto the origin on the first tick — and wrong for a limb. A knee is not
       * the middle of a shin. Anchored at the child's centre, the shin is pinned by its middle and
       * free to turn about it inside its cone, so the knee end of the shin swings up to half a
       * shin away from the knee end of the thigh, and the cone meant to limit the knee is measured
       * about the wrong pivot. Reported from outside as joints a body wide and everything
       * vibrating, and measured there: a knee opening to 100 cm in flight and still 72 cm open
       * after the body had landed, against 8.2 and 4.1 with the anchors here.
       *
       * Both resolve to the same world point at rest, because a bone's head is its parent's tail,
       * so the first tick still moves nothing.
       */
      anchorAY: halfOf[p] ?? 0,
      anchorBY: -(halfOf[j] ?? 0),
    });
  }

  /*
   * **Bones that share an end must not collide, and it cannot be said with layers.**
   *
   * A mask is a property of one body, so it can say what a bone is and not who two bones are to
   * each other, and a doll needs the second: a thigh must not collide with the shin it is jointed
   * to while still colliding with the *other* shin. `pairKey` carries why, and a consumer that
   * tried it with layers spent a bit per bone and most of the 32 on one doll.
   */
  for (let j = 0; j < jointCount; j++) {
    const body = bodyOf[j] ?? -1;
    if (body < 0) continue;
    for (let k = j + 1; k < jointCount; k++) {
      const other = bodyOf[k] ?? -1;
      if (other < 0) continue;
      if (options.selfCollision === false) {
        world.ignorePair(body, other);
        continue;
      }
      const pj = parents[j] ?? -1;
      const pk = parents[k] ?? -1;
      /* Jointed, either way round, or two bones hanging off the same parent joint: siblings share
         a head the way a parent and child share a point, so they overlap there too. */
      if (pk === j || pj === k || (pj === pk && pj >= 0)) world.ignorePair(body, other);
    }
  }

  const root = firstBone;
  return {
    bodyOf,
    boneCount,
    writePose(out: PoseTarget): void {
      for (let j = 0; j < jointCount; j++) {
        const body = bodyOf[j] ?? -1;
        const p = parents[j] ?? -1;
        if (body < 0) {
          // No bone: leave the joint as the pose already had it.
          continue;
        }
        // The joint's world rotation, recovered from the body's.
        readBodyRotation(world, body, TMP);
        multiplyInto(TMP, bodyToJoint, j * 4, WORLD_ROT, j * 4);
        const parentBody = p >= 0 ? (bodyOf[p] ?? -1) : -1;
        if (parentBody >= 0) {
          conjugateMultiply(WORLD_ROT, p * 4, WORLD_ROT, j * 4, out.rotation, j * 4);
        } else {
          copy4(WORLD_ROT, j * 4, out.rotation, j * 4);
        }
        // Bones are rigid, so translation stays what the rig was built with.
        out.translation[j * 3] = localRest[j * 3] ?? 0;
        out.translation[j * 3 + 1] = localRest[j * 3 + 1] ?? 0;
        out.translation[j * 3 + 2] = localRest[j * 3 + 2] ?? 0;
        out.scale[j * 3] = 1;
        out.scale[j * 3 + 1] = 1;
        out.scale[j * 3 + 2] = 1;
      }
    },
    drive(w: PhysicsWorld, pose: PoseTarget, weight: number): void {
      if (weight <= 0) return;
      const k = weight > 1 ? 1 : weight;
      for (let j = 0; j < jointCount; j++) {
        const body = bodyOf[j] ?? -1;
        if (body < 0) continue;
        const p = parents[j] ?? -1;
        const parentBody = p >= 0 ? (bodyOf[p] ?? -1) : -1;
        /*
         * The target is the pose's local rotation composed onto the parent's *current* world
         * rotation, so a driven limb follows the animation relative to a body that may itself have
         * been knocked aside — which is what a partial ragdoll is.
         */
        if (parentBody >= 0) {
          readBodyRotation(w, parentBody, TMP);
          multiplyInto(TMP, bodyToJoint, p * 4, PARENT_ROT, 0);
          multiplyRaw(PARENT_ROT, 0, pose.rotation, j * 4, TARGET_ROT, 0);
        } else {
          copy4(pose.rotation, j * 4, TARGET_ROT, 0);
        }
        readBodyRotation(w, body, TMP);
        multiplyInto(TMP, bodyToJoint, j * 4, CURRENT_ROT, 0);
        // Twice the vector part of target · conj(current) is the rotation that closes the gap.
        conjugateMultiply(CURRENT_ROT, 0, TARGET_ROT, 0, ERROR_ROT, 0);
        let ex = ERROR_ROT[0] ?? 0;
        let ey = ERROR_ROT[1] ?? 0;
        let ez = ERROR_ROT[2] ?? 0;
        if ((ERROR_ROT[3] ?? 1) < 0) {
          ex = -ex;
          ey = -ey;
          ez = -ez;
        }
        // A proportional pull on angular velocity, which the solver then reconciles with the joints.
        const gain = 20 * k;
        w.bodies.angX[body] = (w.bodies.angX[body] ?? 0) + 2 * ex * gain;
        w.bodies.angY[body] = (w.bodies.angY[body] ?? 0) + 2 * ey * gain;
        w.bodies.angZ[body] = (w.bodies.angZ[body] ?? 0) + 2 * ez * gain;
      }
    },
    sync(w: PhysicsWorld, worldMatrices: Float32Array): void {
      for (let j = 0; j < jointCount; j++) {
        const body = bodyOf[j] ?? -1;
        if (body < 0) continue;
        const p = parents[j] ?? -1;
        if (p < 0) continue;

        const hx = worldMatrices[p * 16 + 12] ?? 0;
        const hy = worldMatrices[p * 16 + 13] ?? 0;
        const hz = worldMatrices[p * 16 + 14] ?? 0;
        const tx = worldMatrices[j * 16 + 12] ?? 0;
        const ty = worldMatrices[j * 16 + 13] ?? 0;
        const tz = worldMatrices[j * 16 + 14] ?? 0;

        w.bodies.posX[body] = (hx + tx) / 2;
        w.bodies.posY[body] = (hy + ty) / 2;
        w.bodies.posZ[body] = (hz + tz) / 2;

        /*
         * The rotation is taken from the *bone*, the same way the build took it: the capsule
         * stands along y, so the body is turned to put its y along the bone. Taking it from the
         * joint's world matrix instead would be wrong wherever a rig's bind orientation is not
         * the bone direction, which is most rigs.
         */
        const dx = tx - hx;
        const dy = ty - hy;
        const dz = tz - hz;
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (length > 0) {
          alignYTo(dx / length, dy / length, dz / length, TMP);
          w.bodies.rotX[body] = TMP[0] ?? 0;
          w.bodies.rotY[body] = TMP[1] ?? 0;
          w.bodies.rotZ[body] = TMP[2] ?? 0;
          w.bodies.rotW[body] = TMP[3] ?? 1;
        }

        /* At rest, which is the half that makes it a reaction rather than a continuation: a body
           carrying the speed of a two-second fall is thrown across the character the instant it
           is written into the pose. */
        w.bodies.velX[body] = 0;
        w.bodies.velY[body] = 0;
        w.bodies.velZ[body] = 0;
        w.bodies.angX[body] = 0;
        w.bodies.angY[body] = 0;
        w.bodies.angZ[body] = 0;
        w.wakeIsland(body);
      }
    },
    rootX(): number {
      return root < 0 ? 0 : boneHeadX(world, bodyOf[root] ?? 0, firstBoneHalf);
    },
    rootY(): number {
      return root < 0 ? 0 : boneHeadY(world, bodyOf[root] ?? 0, firstBoneHalf);
    },
    rootZ(): number {
      return root < 0 ? 0 : boneHeadZ(world, bodyOf[root] ?? 0, firstBoneHalf);
    },
  };
}

const WORLD_ROT = new Float32Array(256 * 4);
const PARENT_ROT = new Float32Array(4);
const TARGET_ROT = new Float32Array(4);
const CURRENT_ROT = new Float32Array(4);
const ERROR_ROT = new Float32Array(4);

/*
 * A bone's head, from the body standing along it: the centre, half a bone back along the body's
 * own +y.
 *
 * **Written out per component rather than rotating a vector**, because a caller asks for one
 * number at a time and the three columns of a quaternion's rotation matrix are three short
 * expressions. This is +y turned by the body's rotation — the second column — and nothing else,
 * so an axis it does not need costs nothing. `alignYTo` at build time is the other half of the
 * same fact: a capsule stands along +y, so +y is where the bone points.
 *
 * The cost is that the three do not share the multiplies they have in common. That is the trade a
 * per-axis accessor makes, and it is a handful of arithmetic against a call a consumer makes once
 * or three times a frame.
 */
function boneHeadX(world: PhysicsWorld, body: number, half: number): number {
  const x = world.bodies.rotX[body] ?? 0;
  const y = world.bodies.rotY[body] ?? 0;
  const z = world.bodies.rotZ[body] ?? 0;
  const w = world.bodies.rotW[body] ?? 1;
  return (world.bodies.posX[body] ?? 0) - half * 2 * (x * y - z * w);
}

function boneHeadY(world: PhysicsWorld, body: number, half: number): number {
  const x = world.bodies.rotX[body] ?? 0;
  const z = world.bodies.rotZ[body] ?? 0;
  return (world.bodies.posY[body] ?? 0) - half * (1 - 2 * (x * x + z * z));
}

function boneHeadZ(world: PhysicsWorld, body: number, half: number): number {
  const x = world.bodies.rotX[body] ?? 0;
  const y = world.bodies.rotY[body] ?? 0;
  const z = world.bodies.rotZ[body] ?? 0;
  const w = world.bodies.rotW[body] ?? 1;
  return (world.bodies.posZ[body] ?? 0) - half * 2 * (y * z + x * w);
}

function readBodyRotation(world: PhysicsWorld, body: number, out: Float64Array): void {
  out[0] = world.bodies.rotX[body] ?? 0;
  out[1] = world.bodies.rotY[body] ?? 0;
  out[2] = world.bodies.rotZ[body] ?? 0;
  out[3] = world.bodies.rotW[body] ?? 1;
}

/** The rotation part of a column-major 4x4, as a quaternion. */
function matrixRotation(m: Float32Array, index: number, out: Float32Array, at: number): void {
  const o = index * 16;
  const m00 = m[o] ?? 1;
  const m01 = m[o + 4] ?? 0;
  const m02 = m[o + 8] ?? 0;
  const m10 = m[o + 1] ?? 0;
  const m11 = m[o + 5] ?? 1;
  const m12 = m[o + 9] ?? 0;
  const m20 = m[o + 2] ?? 0;
  const m21 = m[o + 6] ?? 0;
  const m22 = m[o + 10] ?? 1;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    out[at + 3] = s / 4;
    out[at] = (m21 - m12) / s;
    out[at + 1] = (m02 - m20) / s;
    out[at + 2] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out[at + 3] = (m21 - m12) / s;
    out[at] = s / 4;
    out[at + 1] = (m01 + m10) / s;
    out[at + 2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out[at + 3] = (m02 - m20) / s;
    out[at] = (m01 + m10) / s;
    out[at + 1] = s / 4;
    out[at + 2] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out[at + 3] = (m10 - m01) / s;
    out[at] = (m02 + m20) / s;
    out[at + 1] = (m12 + m21) / s;
    out[at + 2] = s / 4;
  }
}

/** A rotation taking +y onto the given unit direction, by the shortest arc. */
function alignYTo(dx: number, dy: number, dz: number, out: Float64Array): void {
  const dot = dy;
  if (dot > 0.999999) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return;
  }
  if (dot < -0.999999) {
    // Opposite: a half turn about any perpendicular axis.
    out[0] = 0;
    out[1] = 0;
    out[2] = 1;
    out[3] = 0;
    return;
  }
  // Axis is +y crossed with the direction; the half-angle form avoids a trig call.
  const ax = dz;
  const az = -dx;
  const w = 1 + dot;
  const len = Math.sqrt(ax * ax + az * az + w * w) || 1;
  out[0] = ax / len;
  out[1] = 0;
  out[2] = az / len;
  out[3] = w / len;
}

/** `conj(a) · b` into `out`. */
function multiplyConjugate(
  a: Float64Array,
  b: Float32Array,
  bAt: number,
  out: Float32Array,
  at: number,
): void {
  const ax = -a[0];
  const ay = -a[1];
  const az = -a[2];
  const aw = a[3];
  const bx = b[bAt] ?? 0;
  const by = b[bAt + 1] ?? 0;
  const bz = b[bAt + 2] ?? 0;
  const bw = b[bAt + 3] ?? 1;
  out[at] = aw * bx + ax * bw + ay * bz - az * by;
  out[at + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[at + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[at + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** `a · b` where `a` is a Float64 quaternion, into `out`. */
function multiplyInto(
  a: Float64Array,
  b: Float32Array,
  bAt: number,
  out: Float32Array,
  at: number,
): void {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[bAt] ?? 0;
  const by = b[bAt + 1] ?? 0;
  const bz = b[bAt + 2] ?? 0;
  const bw = b[bAt + 3] ?? 1;
  out[at] = aw * bx + ax * bw + ay * bz - az * by;
  out[at + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[at + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[at + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** `a · b` for two Float32 quaternions. */
function multiplyRaw(
  a: Float32Array,
  aAt: number,
  b: Float32Array,
  bAt: number,
  out: Float32Array,
  at: number,
): void {
  const ax = a[aAt] ?? 0;
  const ay = a[aAt + 1] ?? 0;
  const az = a[aAt + 2] ?? 0;
  const aw = a[aAt + 3] ?? 1;
  const bx = b[bAt] ?? 0;
  const by = b[bAt + 1] ?? 0;
  const bz = b[bAt + 2] ?? 0;
  const bw = b[bAt + 3] ?? 1;
  out[at] = aw * bx + ax * bw + ay * bz - az * by;
  out[at + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[at + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[at + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** `conj(a) · b` for two Float32 quaternions. */
function conjugateMultiply(
  a: Float32Array,
  aAt: number,
  b: Float32Array,
  bAt: number,
  out: Float32Array,
  at: number,
): void {
  const ax = -(a[aAt] ?? 0);
  const ay = -(a[aAt + 1] ?? 0);
  const az = -(a[aAt + 2] ?? 0);
  const aw = a[aAt + 3] ?? 1;
  const bx = b[bAt] ?? 0;
  const by = b[bAt + 1] ?? 0;
  const bz = b[bAt + 2] ?? 0;
  const bw = b[bAt + 3] ?? 1;
  out[at] = aw * bx + ax * bw + ay * bz - az * by;
  out[at + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[at + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[at + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

function copy4(from: Float32Array, fromAt: number, to: Float32Array, toAt: number): void {
  to[toAt] = from[fromAt] ?? 0;
  to[toAt + 1] = from[fromAt + 1] ?? 0;
  to[toAt + 2] = from[fromAt + 2] ?? 0;
  to[toAt + 3] = from[fromAt + 3] ?? 1;
}
