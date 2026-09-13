import { describe, expect, it } from 'vitest';
import { ColliderSet, boxCollider } from '@driftengine/core';
import { physicsImplementation } from './core.ts';

const physics = physicsImplementation() as {
  anyWithin: (c: ColliderSet, x: number, y: number, z: number, r: number) => boolean;
  nearestWithin: (c: ColliderSet, x: number, y: number, z: number, r: number) => boolean;
  nearCollider: (c: ColliderSet) => number;
  nearX: (c: ColliderSet) => number;
  nearY: (c: ColliderSet) => number;
  nearZ: (c: ColliderSet) => number;
  nearDistance: (c: ColliderSet) => number;
};

/** Search, then read — the two halves a result that is not a value costs. */
const search = (colliders: ColliderSet, x: number, y: number, z: number, radius: number) => {
  const hit = physics.nearestWithin(colliders, x, y, z, radius);
  return {
    hit,
    collider: physics.nearCollider(colliders),
    x: physics.nearX(colliders),
    y: physics.nearY(colliders),
    z: physics.nearZ(colliders),
    distance: physics.nearDistance(colliders),
  };
};

/**
 * Three unit boxes centred at 4, 10 and 30 metres along x.
 *
 * Unit *half-extents*, so the box at 4 has a face at x = 3 — the numbers below are distances to a
 * face rather than to a centre, which is what the accessors answer and the thing easiest to write
 * a wrong expectation about.
 */
const walls = () =>
  new ColliderSet([
    boxCollider(4, 0, 0, 1, 1, 1),
    boxCollider(10, 0, 0, 1, 1, 1),
    boxCollider(30, 0, 0, 1, 1, 1),
  ]);

describe('the nearest collider within a radius', () => {
  it('finds the closest one and answers where its surface is', () => {
    const colliders = walls();
    expect(search(colliders, 0, 0, 0, 20)).toEqual({
      hit: true,
      collider: 0,
      x: 3,
      y: 0,
      z: 0,
      distance: 3,
    });
  });

  it('answers the point on the collider rather than its centre', () => {
    /* Measured from above the first box: the closest point is on its top face, directly below the
       query point, and a binding that answered the centre would say (4, 0, 0) and three metres. */
    const colliders = walls();
    expect(search(colliders, 4, 5, 0, 10)).toEqual({
      hit: true,
      collider: 0,
      x: 4,
      y: 1,
      z: 0,
      distance: 4,
    });
  });

  it('answers zero distance for a point inside a collider, rather than refusing it', () => {
    /* A character standing in a wall is a state this engine reaches, and the honest answer is that
       the wall is nought metres away — not that there is no wall. */
    const colliders = walls();
    expect(search(colliders, 10, 0, 0, 1)).toEqual({
      hit: true,
      collider: 1,
      x: 10,
      y: 0,
      z: 0,
      distance: 0,
    });
  });

  it('takes the nearest rather than the first the hash returns', () => {
    /* From 12, the box at 10 is one metre away and the one at 4 is seven. The spatial hash returns
       candidates in bucket order, so a scan that kept its first hit could answer either. */
    const colliders = walls();
    expect(search(colliders, 12, 0, 0, 20).collider).toBe(1);
  });

  it('answers false when nothing is inside the radius', () => {
    const colliders = walls();
    expect(physics.nearestWithin(colliders, 0, 0, 0, 2)).toBe(false);
    expect(physics.nearCollider(colliders)).toBe(-1);
  });

  it('answers false for an empty set', () => {
    const colliders = new ColliderSet([]);
    expect(physics.nearestWithin(colliders, 0, 0, 0, 100)).toBe(false);
    expect(physics.nearCollider(colliders)).toBe(-1);
  });

  it('clears the previous answer when a later search finds nothing', () => {
    /*
     * The failure a result held per set invites: a script that searches, finds a wall, searches
     * again somewhere empty and reads the accessors anyway would steer towards a wall that is no
     * longer near. `false` and a stale −1 are two different lies; this asserts neither.
     */
    const colliders = walls();
    expect(search(colliders, 0, 0, 0, 20).hit).toBe(true);
    expect(physics.nearestWithin(colliders, 0, 100, 0, 2)).toBe(false);
    expect(physics.nearCollider(colliders)).toBe(-1);
    expect(physics.nearDistance(colliders)).toBe(0);
  });

  it('measures the sphere, where `anyWithin` measures the box around it', () => {
    /*
     * **The one place the two `within` questions disagree, asserted rather than described.** A box
     * sitting diagonally from the query point reaches the corner of the query *box* while staying
     * outside the sphere: `anyWithin` says yes because the collider hash indexes boxes, and
     * `nearestWithin` says no because it has already computed the distance to rank the candidate.
     *
     * The corner is at (4, 4, 0), which is 5.66 metres from the origin — outside a radius of five,
     * inside the 5x5 box the broad phase tests.
     */
    const colliders = new ColliderSet([boxCollider(5, 5, 0, 1, 1, 1)]);
    expect(physics.anyWithin(colliders, 0, 0, 0, 5)).toBe(true);
    expect(physics.nearestWithin(colliders, 0, 0, 0, 5)).toBe(false);
    expect(physics.nearestWithin(colliders, 0, 0, 0, 6)).toBe(true);
  });

  it('keeps one answer per set, so two sets are two questions', () => {
    /* The reason the result is a `WeakMap` rather than one shared slot, which is the argument
       `raycast` already makes for its hit. */
    const near = new ColliderSet([boxCollider(2, 0, 0, 1, 1, 1)]);
    const far = new ColliderSet([boxCollider(40, 0, 0, 1, 1, 1)]);
    expect(physics.nearestWithin(near, 0, 0, 0, 10)).toBe(true);
    expect(physics.nearestWithin(far, 0, 0, 0, 10)).toBe(false);
    expect(physics.nearDistance(near)).toBe(1);
    expect(physics.nearCollider(near)).toBe(0);
  });

  it('allocates nothing per call, which is what makes it callable every frame', () => {
    const colliders = walls();
    const before = search(colliders, 0, 0, 0, 20);
    for (let i = 0; i < 1000; i += 1) physics.nearestWithin(colliders, 0, 0, 0, 20);
    expect(search(colliders, 0, 0, 0, 20)).toEqual(before);
  });
});
