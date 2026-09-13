import { describe, expect, it } from 'vitest';

import { createPose, restPose } from './pose.ts';

describe('a pose', () => {
  it('is three arrays sized for the joint count', () => {
    const pose = createPose(3);
    expect(pose.translation.length).toBe(9);
    expect(pose.rotation.length).toBe(12);
    expect(pose.scale.length).toBe(9);
  });

  /*
   * A rest pose is identity, and the rotation identity is (0,0,0,1) rather than zero. A
   * zero-filled quaternion normalises to NaN, and a NaN reaching the palette takes every vertex
   * the joint touches with it — the same failure `vertexDefaults.ts` records for a zero tangent.
   */
  it('rests at an identity quaternion and unit scale, not at zero', () => {
    const pose = createPose(2);
    restPose(2, pose);
    expect(Array.from(pose.rotation)).toEqual([0, 0, 0, 1, 0, 0, 0, 1]);
    expect(Array.from(pose.scale)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(Array.from(pose.translation)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  /* A fresh pose is already at rest, so a caller that forgets `restPose` does not get NaN. */
  it('is created at rest rather than at zero', () => {
    expect(Array.from(createPose(1).rotation)).toEqual([0, 0, 0, 1]);
    expect(Array.from(createPose(1).scale)).toEqual([1, 1, 1]);
  });
});
