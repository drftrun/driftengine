import { describe, expect, it } from 'vitest';

import { createBounds } from '../math/bounds.ts';
import { poseBounds, reachOf, validatePointSkin, validatePose } from './pointSkin.ts';
import type { PointSkinData } from './pointSkin.ts';

/*
 * Two vertices on two joints, posed by hand. Joint 0 is moved to (1, 2, 3) and turns nothing; joint
 * 1 sits at the origin, scaled by 2. Vertex 0 is (1, 0, 0) on joint 0 alone: posed, (2, 2, 3).
 * Vertex 1 is half (0, 1, 0) on joint 1 and half (0, 0, 1) on joint 0: posed, half (0, 2, 0) and
 * half (1, 2, 4), which is (0.5, 2, 2).
 */
const skin: PointSkinData = {
  joints: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0]),
  weights: new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0]),
  points: new Float32Array([
    1, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  ]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1]),
};
const pose = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1,
]);

describe('a point skin', () => {
  it("KEEPS EVERY POSED VERTEX INSIDE A BOX OF EACH JOINT'S REACH, WITHOUT SEEING ONE", () => {
    const reach = reachOf(skin);
    expect(reach.joints).toBe(2);
    /* The 9s are an influence of weight 0, which reaches nothing. */
    expect(Array.from(reach.reach)).toEqual([1, 1]);
    const bounds = createBounds();
    poseBounds(pose, reach, bounds);
    /* Joint 0: a sphere of 1 about (1, 2, 3). Joint 1: a sphere of 1 · 2 about the origin. */
    expect(Array.from(bounds.min)).toEqual([-2, -2, -2]);
    expect(Array.from(bounds.max)).toEqual([2, 3, 4]);
    for (const posed of [
      [2, 2, 3],
      [0.5, 2, 2],
    ]) {
      posed.forEach((value, axis) => {
        expect(value).toBeGreaterThanOrEqual(bounds.min[axis] as number);
        expect(value).toBeLessThanOrEqual(bounds.max[axis] as number);
      });
    }
    expect(Array.from(bounds.centre)).toEqual([0, 0.5, 1]);
  });

  it('widens the box by the most a vertex weighs, where weights sum past one', () => {
    const heavy = { ...skin, weights: new Float32Array([2, 0, 0, 0, 0.5, 0.5, 0, 0]) };
    const reach = reachOf(heavy);
    expect(reach.sums).toEqual([1, 2]);
    const bounds = createBounds();
    poseBounds(pose, reach, bounds);
    /* Vertex 0 posed is 2 · (2, 2, 3) = (4, 4, 6), past the unscaled box. */
    expect(Array.from(bounds.max)).toEqual([4, 6, 8]);
    expect(Array.from(bounds.min)).toEqual([-4, -4, -4]);
  });

  it('names its first joint whatever it weighs, since that joint turns the normal', () => {
    const silent = { ...skin, joints: new Float32Array([0, 0, 0, 0, 3, 1, 0, 0]) };
    silent.weights[4] = 0;
    expect(reachOf(silent).joints).toBe(4);
  });

  it('refuses arrays that disagree with the mesh, a joint that is not one, and a short pose', () => {
    expect(() => validatePointSkin(skin, 3)).toThrow(/joints holds 2 vertices and the mesh has 3/);
    expect(() =>
      validatePointSkin({ ...skin, joints: new Float32Array([0.5, 0, 0, 0, 1, 0, 0, 0]) }, 2),
    ).toThrow(/vertex 0 names joint 0.5/);
    expect(() =>
      validatePointSkin({ ...skin, joints: new Float32Array([512, 0, 0, 0, 1, 0, 0, 0]) }, 2),
    ).toThrow(/joint 512/);
    expect(() => validatePose(new Float32Array(16), reachOf(skin))).toThrow(
      /a pose of 1 joints for a skin that names 2/,
    );
    expect(() => validatePointSkin(skin, 2)).not.toThrow();
  });
});
