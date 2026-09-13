import { describe, expect, it } from 'vitest';

import { addPose, blendPoses, setJoint } from './blend.ts';
import { createPose, restPose } from './pose.ts';

describe('blending two poses', () => {
  it('at t=0 is a, at t=1 is b', () => {
    const a = createPose(1);
    const b = createPose(1);
    const out = createPose(1);
    a.translation[0] = 2;
    b.translation[0] = 6;
    blendPoses(a, b, 0, out);
    expect(out.translation[0]).toBe(2);
    blendPoses(a, b, 1, out);
    expect(out.translation[0]).toBe(6);
  });

  /* Hand-derived: halfway between 2 and 6 is 4. */
  it('interpolates translation linearly', () => {
    const a = createPose(1);
    const b = createPose(1);
    const out = createPose(1);
    a.translation[0] = 2;
    b.translation[0] = 6;
    blendPoses(a, b, 0.5, out);
    expect(out.translation[0]).toBeCloseTo(4, 6);
  });

  /*
   * A weight outside 0..1 is clamped rather than extrapolated. An extrapolated pose puts limbs
   * past their range, which reads as a broken rig rather than as a weight out of bounds — the
   * same reasoning `sampleClip` holds at a track's ends for.
   */
  it('clamps a weight outside its range', () => {
    const a = createPose(1);
    const b = createPose(1);
    const out = createPose(1);
    a.translation[0] = 2;
    b.translation[0] = 6;
    blendPoses(a, b, 4, out);
    expect(out.translation[0]).toBe(6);
    blendPoses(a, b, -3, out);
    expect(out.translation[0]).toBe(2);
  });

  /*
   * The shorter arc, and the two poses have to sit on opposite hemispheres for this to test
   * anything — the lesson `clip.test.ts` records, where the obvious pair has a dot product of
   * exactly zero and the assertion passes with the correction deleted.
   *
   * Hand-derived: identity against a quarter turn about Y *negated* is the same orientation on the
   * far hemisphere. Halfway is an eighth turn, |w| = cos 22.5deg = 0.92388; going the long way
   * round lands at cos 67.5deg = 0.38268.
   */
  it('takes the shorter arc between opposite hemispheres', () => {
    const c = Math.SQRT1_2;
    const a = createPose(1);
    const b = createPose(1);
    const out = createPose(1);
    a.rotation.set([0, 0, 0, 1]);
    b.rotation.set([0, -c, 0, -c]);
    blendPoses(a, b, 0.5, out);
    expect(Math.abs(out.rotation[3] as number)).toBeCloseTo(0.92388, 4);
  });

  it('writes into out and allocates nothing', () => {
    const a = createPose(1);
    const b = createPose(1);
    const out = createPose(1);
    const before = out.translation;
    blendPoses(a, b, 0.5, out);
    expect(out.translation).toBe(before);
  });

  /* Blending into one of its own inputs must not read a value it has already overwritten. */
  it('is safe when out is also an input', () => {
    const a = createPose(1);
    const b = createPose(1);
    a.translation[0] = 2;
    b.translation[0] = 6;
    blendPoses(a, b, 0.5, a);
    expect(a.translation[0]).toBeCloseTo(4, 6);
  });
});

describe('an additive layer', () => {
  /*
   * Additive is a *delta* applied on top, not a blend toward a target: a wave laid over a walk
   * has to move the arm relative to wherever the walk put it, not replace it. So translation adds
   * and rotation composes, both scaled by the weight.
   *
   * Hand-derived: a base at x=3 with a delta of x=2 at half weight is 4.
   */
  it('adds translation scaled by its weight', () => {
    const base = createPose(1);
    const delta = createPose(1);
    const out = createPose(1);
    base.translation[0] = 3;
    delta.translation[0] = 2;
    addPose(base, delta, 0.5, out);
    expect(out.translation[0]).toBeCloseTo(4, 6);
  });

  it('at weight zero is the base untouched', () => {
    const base = createPose(1);
    const delta = createPose(1);
    const out = createPose(1);
    base.translation[0] = 3;
    delta.translation[0] = 9;
    delta.rotation.set([0, 1, 0, 0]);
    addPose(base, delta, 0, out);
    expect(out.translation[0]).toBe(3);
    expect(Math.abs(out.rotation[3] as number)).toBeCloseTo(1, 6);
  });

  /* Scale multiplies rather than adds: a delta of 1 is "unchanged", not "double". */
  it('multiplies scale rather than adding it', () => {
    const base = createPose(1);
    const delta = createPose(1);
    const out = createPose(1);
    base.scale.set([2, 2, 2]);
    addPose(base, delta, 1, out);
    expect(out.scale[0]).toBeCloseTo(2, 6);
  });
});

describe('a directly written joint', () => {
  /* What a ragdoll needs from Track A: a pose is data, not only a sampling result. */
  it('takes the transform it is given', () => {
    const pose = createPose(2);
    restPose(2, pose);
    setJoint(pose, 1, [1, 2, 3], [0, 0, 0, 1], [1, 1, 1]);
    expect(Array.from(pose.translation.subarray(3, 6))).toEqual([1, 2, 3]);
    expect(Array.from(pose.scale.subarray(3, 6))).toEqual([1, 1, 1]);
  });

  it('leaves every other joint alone', () => {
    const pose = createPose(2);
    pose.translation[0] = 7;
    setJoint(pose, 1, [1, 2, 3], [0, 0, 0, 1], [1, 1, 1]);
    expect(pose.translation[0]).toBe(7);
  });
});
