import { describe, expect, it } from 'vitest';
import { ColliderSet } from '@driftengine/core';
import { physicsImplementation } from './core.ts';

const physics = physicsImplementation() as {
  colliderCount: (c: ColliderSet) => number;
  colliderCapacity: (c: ColliderSet) => number;
  colliderBytes: (c: ColliderSet) => number;
  beginColliderGroup: (c: ColliderSet) => void;
  addColliderBox: (
    c: ColliderSet,
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
  ) => void;
  endColliderGroup: (c: ColliderSet) => number;
  removeColliderGroup: (c: ColliderSet, group: number) => void;
};

/** A region, the way a script would put one down: open, fill, close, keep the handle. */
const putDown = (set: ColliderSet, at: number, boxes: number): number => {
  physics.beginColliderGroup(set);
  for (let i = 0; i < boxes; i++) physics.addColliderBox(set, at + i * 3, 1, 0, 1, 1, 1);
  return physics.endColliderGroup(set);
};

describe('drift/physics collider groups', () => {
  it('puts a region down and takes it away again', () => {
    const set = new ColliderSet([]);
    const group = putDown(set, 10, 4);
    expect(physics.colliderCount(set)).toBe(4);

    physics.removeColliderGroup(set, group);
    expect(physics.colliderCount(set)).toBe(0);
  });

  /*
   * **The handle has to survive a round trip through a script's `u32`.** That is the whole reason
   * `endColliderGroup` returns it rather than `beginColliderGroup`: a script holds an integer, and
   * an integer minted before the group existed would be the binding inventing an id.
   */
  it('hands back a handle that is a plain non-negative integer', () => {
    const set = new ColliderSet([]);
    const group = putDown(set, 0, 2);
    expect(Number.isInteger(group)).toBe(true);
    expect(group).toBeGreaterThanOrEqual(0);
    expect(() => physics.removeColliderGroup(set, group)).not.toThrow();
  });

  it('keeps two regions apart, so dropping one leaves the other', () => {
    const set = new ColliderSet([]);
    const near = putDown(set, 0, 3);
    const far = putDown(set, 500, 3);
    physics.removeColliderGroup(set, near);
    expect(physics.colliderCount(set)).toBe(3);
    physics.removeColliderGroup(set, far);
    expect(physics.colliderCount(set)).toBe(0);
  });

  /* A builder is state, and state a script can leave in a bad shape has to say so. */
  it('refuses a box with no group open', () => {
    const set = new ColliderSet([]);
    expect(() => physics.addColliderBox(set, 0, 0, 0, 1, 1, 1)).toThrow(/beginColliderGroup/);
  });

  it('refuses a second group opened over the first', () => {
    const set = new ColliderSet([]);
    physics.beginColliderGroup(set);
    expect(() => physics.beginColliderGroup(set)).toThrow(/already open/);
  });

  it('refuses to close a group that was never opened', () => {
    expect(() => physics.endColliderGroup(new ColliderSet([]))).toThrow(/no group is open/i);
  });

  /* Two sets are two builders: a shared slot would land one set's region in the other. */
  it("keeps one set's open group out of another set", () => {
    const a = new ColliderSet([]);
    const b = new ColliderSet([]);
    physics.beginColliderGroup(a);
    physics.addColliderBox(a, 0, 0, 0, 1, 1, 1);
    expect(() => physics.addColliderBox(b, 0, 0, 0, 1, 1, 1)).toThrow();
    physics.endColliderGroup(a);
    expect(physics.colliderCount(a)).toBe(1);
    expect(physics.colliderCount(b)).toBe(0);
  });

  it('refuses a handle the set does not hold, and the set it was built with', () => {
    const set = new ColliderSet([]);
    const group = putDown(set, 0, 1);
    physics.removeColliderGroup(set, group);
    expect(() => physics.removeColliderGroup(set, group)).toThrow();
    expect(() => physics.removeColliderGroup(set, ColliderSet.BASE_GROUP)).toThrow(
      /constructed empty/,
    );
  });

  /* Capacity and bytes are what a streamer sizes its resident ring against. */
  it('reports capacity apart from count, and a byte total that follows the geometry', () => {
    const set = new ColliderSet([]);
    const empty = physics.colliderBytes(set);
    const group = putDown(set, 0, 8);
    expect(physics.colliderCapacity(set)).toBeGreaterThanOrEqual(physics.colliderCount(set));
    expect(physics.colliderBytes(set)).toBeGreaterThan(empty);

    physics.removeColliderGroup(set, group);
    /* Count falls, capacity does not: the free list recycles slots and never shrinks, which is the
       honest number for a budget. */
    expect(physics.colliderCount(set)).toBe(0);
    expect(physics.colliderCapacity(set)).toBeGreaterThanOrEqual(8);
  });
});
