import { MAX_JOINTS } from '@driftengine/core';
import type { Joint } from '@driftengine/drft';
import { mat4, quat, vec3 } from 'gl-matrix';

import type { Pose } from './pose.ts';

/**
 * A joint hierarchy and the skinning palette it resolves a pose into.
 *
 * **A joint is not a `SceneNode`, and that is deliberate.** Core has a transform hierarchy with a
 * parent, dirty tracking and a derived world matrix, and reusing it here is the obvious move. A
 * rig is sixty to ninety joints and a scene holds several characters, so a class instance per node
 * holding its own matrices is the allocation the performance rules forbid — and the palette a
 * shader reads has to be contiguous anyway, which an object graph is not. A *character* is still a
 * `SceneNode`; its skeleton hangs off one, and `rigid.ts` is the seam between them.
 *
 * What it costs is that a joint cannot be reparented or addressed the way a scene node can. What
 * would make it wrong is a consumer needing to attach arbitrary scene content to a joint — a sword
 * in a hand — which is answered by reading the joint's world matrix out rather than by making the
 * joint a node.
 */

/* `Joint` is the format package's, for the reason `clip.ts` gives about the `ANIM` chunk. */
export type { Joint } from '@driftengine/drft';

export class Skeleton {
  readonly joints: readonly Joint[];
  readonly jointCount: number;

  /**
   * Sixteen floats a joint, column-major, claimed once and written in place.
   *
   * This is a *skinning* palette rather than a set of world matrices: each entry is the joint's
   * world transform times its inverse bind, so it takes a vertex from model space to where the
   * joint has moved it. At the bind pose every entry is identity, whatever the bind pose is, which
   * is the property `skeleton.test.ts` pins — a reversed multiplication order does not shift a
   * mesh slightly, it explodes it.
   */
  readonly palette: Float32Array;

  /**
   * Each joint's world matrix, sixteen floats a joint, resolved on the way to the palette.
   *
   * **Public because a palette entry is not a world transform.** An entry is the world matrix
   * times the joint's inverse bind, which is what a shader needs and is useless to anything asking
   * *where a joint is* — attaching a sword to a hand, or an IK solver reading a chain. Those want
   * this. Valid after `applyPose` and meaningless before it.
   */
  readonly world: Float32Array;

  private readonly inverseBind: Float32Array;

  /*
   * One 16-float view per joint into each of the three arrays, built once at construction.
   *
   * `gl-matrix` writes through whatever it is handed, so a view lets `applyPose` multiply straight
   * into the palette with no copy at all. The views exist because `subarray` **is an allocation** —
   * a new typed-array object every call — and `applyPose` runs per character per frame, which is
   * exactly where §4's rule about typed-array views bites. Built here, they cost one object per
   * joint for the skeleton's life and nothing per frame.
   *
   * What it costs is three arrays of small objects held for the skeleton's life. What would make it
   * wrong is a joint count large enough for that to matter, which the 512-joint cap rules out.
   */
  private readonly worldViews: Float32Array[] = [];
  private readonly paletteViews: Float32Array[] = [];
  private readonly bindViews: Float32Array[] = [];

  /**
   * @param joints Sorted **parents-first**. Refused otherwise.
   * @param inverseBind Sixteen floats a joint, column-major, in the same order as `joints`.
   */
  constructor(joints: readonly Joint[], inverseBind: Float32Array) {
    /*
     * Parents before children, checked once here rather than sorted here.
     *
     * `applyPose` walks the joints in index order and reads each joint's parent matrix as it goes,
     * which is only correct on a sorted hierarchy — and a rig that is nearly sorted produces a
     * skeleton that is wrong in one limb, which reads as a bad animation rather than as a data
     * error. Sorting is the importer's job because it is the layer that can also remap every index
     * that names a joint; sorting here would leave a mesh's joint attribute pointing at the old
     * order. See `gltfSkin.ts`.
     */
    for (let j = 0; j < joints.length; j++) {
      const parent = (joints[j] as Joint).parent;
      if (parent >= j) {
        throw new Error(
          `Skeleton: joint ${j} ("${(joints[j] as Joint).name}") names parent ${parent}, which is ` +
            `not before it. Joints must be sorted parents-first, because the palette is resolved ` +
            `in index order and a parent read before it is written is a limb in the wrong place.`,
        );
      }
      if (parent < -1) {
        throw new Error(`Skeleton: joint ${j} names parent ${parent}; -1 means "no parent"`);
      }
    }

    /*
     * The cap is a fact about the palette *texture* — 2048 is WebGL2's guaranteed width and four
     * texels carry a matrix — so it is defined in core beside the texture and imported here rather
     * than restated. Two numbers for one decision is the shape that drifts, and this one would
     * drift silently: a rig between the two would build here and read past the end of a texture row
     * on the GPU, which draws limbs from whatever memory follows rather than failing.
     */
    if (joints.length > MAX_JOINTS) {
      throw new Error(
        `Skeleton: ${joints.length} joints exceeds the ${MAX_JOINTS} a palette texture holds. ` +
          `That is WebGL2's guaranteed texture width rather than this machine's limit.`,
      );
    }

    if (inverseBind.length !== joints.length * 16) {
      throw new Error(
        `Skeleton: the inverse bind array has ${inverseBind.length} floats for ${joints.length} ` +
          `joints; expected ${joints.length * 16} (16 per joint, column-major).`,
      );
    }

    this.joints = joints;
    this.jointCount = joints.length;
    this.inverseBind = inverseBind;
    this.palette = new Float32Array(joints.length * 16);
    this.world = new Float32Array(joints.length * 16);

    for (let j = 0; j < joints.length; j++) {
      const at = j * 16;
      this.worldViews.push(this.world.subarray(at, at + 16));
      this.paletteViews.push(this.palette.subarray(at, at + 16));
      this.bindViews.push(inverseBind.subarray(at, at + 16));
    }
  }

  /**
   * Resolve a pose into the palette. Allocates nothing.
   *
   * One pass in index order: compose the joint's local matrix from its TRS, multiply by its
   * parent's already-written world matrix, then by its inverse bind into the palette. The
   * parents-first ordering the constructor checks is what makes the single pass correct.
   */
  /**
   * Resolve the hierarchy from local matrices rather than from TRS.
   *
   * **For a rig whose poses are authored as matrices.** `applyPose` is the right door for
   * anything that interpolates — a clip, a blend tree, a state machine — because a quaternion is
   * what you can blend and Euler angles are not. But a rig computed fresh every frame from
   * gameplay state has no interpolation to do, and forcing it through TRS means decomposing
   * matrices it just composed: a square root and a branch per joint, and a chance to get the
   * rotation order wrong that no test of the *engine* can catch.
   *
   * The two writers agree, and `skeleton.test.ts` pins that against `applyPose` rather than
   * asserting it — a caller choosing between them on convenience must not be choosing between two
   * answers.
   *
   * **What it costs** is a second way in, which is a real cost: a reader now has to know both
   * exist. **What would make it wrong** is a caller reaching for this to avoid learning
   * quaternions and then wanting to blend — at which point they need `applyPose` and have built
   * their rig in the one representation that cannot get there.
   *
   * @param locals Sixteen floats a joint, column-major, in joint order. Each is the joint's
   *   transform **relative to its parent**, not its world transform.
   */
  applyLocalMatrices(locals: Float32Array): void {
    if (locals.length !== this.jointCount * 16) {
      throw new Error(
        `Skeleton: applyLocalMatrices wants sixteen floats a joint — ` +
          `${this.jointCount * 16} for ${this.jointCount} joints, got ${locals.length}. ` +
          `A short array leaves the tail joints holding whatever the last frame wrote, which ` +
          `animates as one limb frozen rather than as an error.`,
      );
    }
    for (let j = 0; j < this.jointCount; j++) {
      const at = j * 16;
      /* Copied element by element rather than with `subarray`, because a subarray is a new
         typed-array object every call — the same allocation the views above exist to avoid,
         and this runs per character per frame beside `applyPose`. */
      for (let i = 0; i < 16; i++) SCRATCH_LOCAL[i] = locals[at + i] as number;

      const parent = (this.joints[j] as Joint).parent;
      const world = this.worldViews[j] as Float32Array;
      if (parent < 0) {
        world.set(SCRATCH_LOCAL);
      } else {
        mat4.multiply(world, this.worldViews[parent] as Float32Array, SCRATCH_LOCAL);
      }
      mat4.multiply(this.paletteViews[j] as Float32Array, world, this.bindViews[j] as Float32Array);
    }
  }

  applyPose(pose: Pose): void {
    for (let j = 0; j < this.jointCount; j++) {
      SCRATCH_T[0] = pose.translation[j * 3] as number;
      SCRATCH_T[1] = pose.translation[j * 3 + 1] as number;
      SCRATCH_T[2] = pose.translation[j * 3 + 2] as number;
      SCRATCH_R[0] = pose.rotation[j * 4] as number;
      SCRATCH_R[1] = pose.rotation[j * 4 + 1] as number;
      SCRATCH_R[2] = pose.rotation[j * 4 + 2] as number;
      SCRATCH_R[3] = pose.rotation[j * 4 + 3] as number;
      SCRATCH_S[0] = pose.scale[j * 3] as number;
      SCRATCH_S[1] = pose.scale[j * 3 + 1] as number;
      SCRATCH_S[2] = pose.scale[j * 3 + 2] as number;

      mat4.fromRotationTranslationScale(SCRATCH_LOCAL, SCRATCH_R, SCRATCH_T, SCRATCH_S);

      const parent = (this.joints[j] as Joint).parent;
      const world = this.worldViews[j] as Float32Array;
      if (parent < 0) {
        world.set(SCRATCH_LOCAL);
      } else {
        mat4.multiply(world, this.worldViews[parent] as Float32Array, SCRATCH_LOCAL);
      }

      mat4.multiply(this.paletteViews[j] as Float32Array, world, this.bindViews[j] as Float32Array);
    }
  }
}

/*
 * Module-scope scratch, claimed once for the process rather than per skeleton or per call.
 *
 * `applyPose` runs per character per frame, so anything allocated inside it is a garbage collector
 * in the frame loop. Module scope rather than instance fields because these hold nothing between
 * calls and one set serves every skeleton — the engine is single-threaded on this path, and a
 * worker gets its own module instance.
 *
 * What would make it wrong is `applyPose` ever being re-entered, which would need it to call back
 * into caller code; it calls only `gl-matrix`.
 */
const SCRATCH_T = vec3.create();
const SCRATCH_S = vec3.create();
const SCRATCH_R = quat.create();
const SCRATCH_LOCAL = mat4.create();
