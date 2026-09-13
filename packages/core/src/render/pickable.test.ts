import { expect, test } from 'vitest';
import { PickableSet } from './pickable.ts';

/** A unit quad in the z = 0 plane, centred on the origin. */
function quad() {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function identity(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function translated(x: number, y: number, z: number): Float32Array {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

test('a ray at a registered quad reports its handle and distance', () => {
  const set = new PickableSet();
  const handle = set.add(quad(), identity());

  const hit = set.pick([0, 0, 5], [0, 0, -1]);
  expect(hit).not.toBeNull();
  expect(hit?.handle).toBe(handle);
  expect(hit?.distance).toBeCloseTo(5, 5);
});

test('a ray past everything reports nothing', () => {
  const set = new PickableSet();
  set.add(quad(), identity());
  expect(set.pick([9, 9, 5], [0, 0, -1])).toBeNull();
});

/* The nearest wins, which is the entire reason distance is carried rather than a boolean. */
test('the nearest of two overlapping pickables wins', () => {
  const set = new PickableSet();
  const far = set.add(quad(), translated(0, 0, -4));
  const near = set.add(quad(), translated(0, 0, -1));

  expect(set.pick([0, 0, 5], [0, 0, -1])?.handle).toBe(near);
  set.remove(near);
  expect(set.pick([0, 0, 5], [0, 0, -1])?.handle).toBe(far);
});

test('a model matrix moves what the ray can reach', () => {
  const set = new PickableSet();
  const handle = set.add(quad(), translated(6, 0, 0));

  expect(set.pick([0, 0, 5], [0, 0, -1])).toBeNull();
  expect(set.pick([6, 0, 5], [0, 0, -1])?.handle).toBe(handle);

  set.update(handle, identity());
  expect(set.pick([0, 0, 5], [0, 0, -1])?.handle).toBe(handle);
});

test('a removed pickable is not picked', () => {
  const set = new PickableSet();
  const handle = set.add(quad(), identity());
  set.remove(handle);
  expect(set.pick([0, 0, 5], [0, 0, -1])).toBeNull();
});

/*
 * A pick runs on pointermove. The rule for a hot path is zero allocation, and the way that
 * is kept honest is by asserting the returned object is the same one every time rather
 * than by trusting a comment.
 */
test('picking twice reuses one hit object rather than allocating per query', () => {
  const set = new PickableSet();
  set.add(quad(), identity());
  const first = set.pick([0, 0, 5], [0, 0, -1]);
  const second = set.pick([0, 0, 5], [0, 0, -1]);
  expect(first).toBe(second);
});

/* A scaled model must not distort the distance a pick reports: distances are compared
   against other entries and returned to a caller who is working in world units. */
test('a pick reports world distance even when the model is scaled', () => {
  const set = new PickableSet();
  const scaled = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  const handle = set.add(quad(), scaled);

  /* The quad is now 4 units across, so a ray 1.5 out still lands on it. */
  const hit = set.pick([1.5, 0, 5], [0, 0, -1]);
  expect(hit?.handle).toBe(handle);
  expect(hit?.distance).toBeCloseTo(5, 5);
});
