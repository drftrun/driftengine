import { describe, expect, it } from 'vitest';

import { MAX_JOINTS } from '@driftengine/core';

import { mat4, quat, vec3 } from 'gl-matrix';

import { createPose, restPose } from './pose.ts';
import { Skeleton } from './skeleton.ts';

/** n identity matrices, column-major, which is what a rig in its bind pose has. */
function identityInverseBind(n: number): Float32Array {
  const out = new Float32Array(n * 16);
  for (let j = 0; j < n; j++) {
    out[j * 16 + 0] = 1;
    out[j * 16 + 5] = 1;
    out[j * 16 + 10] = 1;
    out[j * 16 + 15] = 1;
  }
  return out;
}

/** A three-joint chain, root to tip, at an identity bind pose. */
function chain(): Skeleton {
  return new Skeleton(
    [
      { parent: -1, name: 'root' },
      { parent: 0, name: 'mid' },
      { parent: 1, name: 'tip' },
    ],
    identityInverseBind(3),
  );
}

describe('a skeleton', () => {
  it('refuses a hierarchy whose child precedes its parent', () => {
    const joints = [
      { parent: 1, name: 'child' },
      { parent: -1, name: 'root' },
    ];
    expect(() => new Skeleton(joints, identityInverseBind(2))).toThrow(/parent/i);
  });

  it('refuses an inverse-bind array that does not cover every joint', () => {
    const joints = [
      { parent: -1, name: 'root' },
      { parent: 0, name: 'child' },
    ];
    expect(() => new Skeleton(joints, identityInverseBind(1))).toThrow(/inverse/i);
  });

  /*
   * The palette is claimed once and written in place. A skeleton that allocated per frame would
   * put a garbage collector in the frame loop, which the performance rules forbid outright — and
   * a typed-array *view* counts as an allocation, which is why this asserts identity rather than
   * contents.
   */
  it('writes into one palette for its whole life', () => {
    const skeleton = new Skeleton([{ parent: -1, name: 'root' }], identityInverseBind(1));
    const first = skeleton.palette;
    const pose = createPose(1);
    restPose(1, pose);
    skeleton.applyPose(pose);
    skeleton.applyPose(pose);
    expect(skeleton.palette).toBe(first);
  });

  it('resolves a rest pose against an identity bind to identity matrices', () => {
    const skeleton = new Skeleton([{ parent: -1, name: 'root' }], identityInverseBind(1));
    const pose = createPose(1);
    restPose(1, pose);
    skeleton.applyPose(pose);
    expect(Array.from(skeleton.palette)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  /*
   * The assertion the hierarchy is for. A child translated one unit under a parent translated ten
   * lands at eleven, and it lands there because the parent's matrix was already resolved when the
   * child was reached. Hand-derived: both binds are identity, so a palette entry *is* the world
   * matrix, and the translation column of a column-major 4x4 is elements 12 to 14.
   */
  it('composes a child through its parent', () => {
    const skeleton = new Skeleton(
      [
        { parent: -1, name: 'root' },
        { parent: 0, name: 'child' },
      ],
      identityInverseBind(2),
    );
    const pose = createPose(2);
    restPose(2, pose);
    pose.translation[0] = 10;
    pose.translation[3] = 1;
    skeleton.applyPose(pose);
    expect(Array.from(skeleton.palette.subarray(28, 31))).toEqual([11, 0, 0]);
  });

  /*
   * The inverse bind is what makes a palette a *skinning* matrix rather than a world one: it takes
   * a vertex from model space into the joint's bind-pose space before the joint's current world
   * transform puts it back. A rig at rest must therefore leave every vertex exactly where it was,
   * whatever the bind pose is — which is the property a wrong multiplication order breaks, and it
   * breaks it by exploding the mesh rather than by shifting it slightly.
   */
  it('is identity at the bind pose, whatever the bind pose is', () => {
    const bindOffset = new Float32Array(16);
    bindOffset.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -4, 0, 0, 1]);
    const skeleton = new Skeleton([{ parent: -1, name: 'root' }], bindOffset);
    const pose = createPose(1);
    restPose(1, pose);
    pose.translation[0] = 4;
    skeleton.applyPose(pose);
    expect(Array.from(skeleton.palette)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  /*
   * The cap is a fact about the palette *texture*, so it is defined in core beside the texture and
   * imported here rather than restated — two numbers for one decision is the shape that drifts.
   * Task 1.1 deliberately left this open because the texture did not exist yet; a rig above the cap
   * has to fail where it is built, not draw with its last joints reading past the end of a row.
   */
  it('refuses a rig larger than the palette texture can hold', () => {
    const joints = Array.from({ length: MAX_JOINTS + 1 }, (_, at) => ({
      parent: at === 0 ? -1 : at - 1,
      name: `j${at}`,
    }));
    expect(() => new Skeleton(joints, identityInverseBind(MAX_JOINTS + 1))).toThrow(
      new RegExp(String(MAX_JOINTS)),
    );
  });
});

describe('applyLocalMatrices', () => {
  it('agrees with applyPose for the same transforms', () => {
    /*
     * The two writers must not disagree. A rig authored as matrices and the same rig authored
     * as TRS are the same rig, and a caller choosing between them on convenience must not be
     * choosing between two answers.
     */
    const skeleton = chain();
    const other = chain();
    const pose = createPose(skeleton.jointCount);

    const angles = [0.3, -0.8, 1.1];
    for (let j = 0; j < skeleton.jointCount; j++) {
      quat.setAxisAngle(
        pose.rotation.subarray(j * 4, j * 4 + 4) as unknown as quat,
        [0, 0, 1],
        angles[j % angles.length] ?? 0,
      );
      pose.translation[j * 3] = j * 0.5;
      pose.translation[j * 3 + 1] = 0.25;
    }
    skeleton.applyPose(pose);

    const locals = new Float32Array(other.jointCount * 16);
    const scratch = mat4.create();
    for (let j = 0; j < other.jointCount; j++) {
      mat4.fromRotationTranslationScale(
        scratch,
        pose.rotation.subarray(j * 4, j * 4 + 4) as unknown as quat,
        pose.translation.subarray(j * 3, j * 3 + 3) as unknown as vec3,
        pose.scale.subarray(j * 3, j * 3 + 3) as unknown as vec3,
      );
      locals.set(scratch, j * 16);
    }
    other.applyLocalMatrices(locals);

    for (let i = 0; i < skeleton.palette.length; i++) {
      expect(other.palette[i], `palette[${i}]`).toBeCloseTo(skeleton.palette[i] ?? 0, 5);
    }
    for (let i = 0; i < skeleton.world.length; i++) {
      expect(other.world[i], `world[${i}]`).toBeCloseTo(skeleton.world[i] ?? 0, 5);
    }
  });

  it('refuses an array that is not sixteen floats a joint', () => {
    /* A short array would leave the tail joints reading whatever the previous frame left,
       which animates as one limb frozen — a data error wearing an animation bug's clothes. */
    const skeleton = chain();
    expect(() =>
      skeleton.applyLocalMatrices(new Float32Array(skeleton.jointCount * 16 - 1)),
    ).toThrow(/sixteen|length/i);
  });
});
