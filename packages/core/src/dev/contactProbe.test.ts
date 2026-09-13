import { expect, test } from 'vitest';
import { ColliderSet, boxCollider } from '@driftengine/physics';
import { createContactReports, describeContacts } from './contactProbe.ts';

/*
 * Hand-derived throughout. `depth` is the overlap along an axis — positive is
 * penetration, negative is the gap — and `distanceM` is the straight line between the
 * two boxes, which is 0 exactly when they overlap on all three axes.
 */
const near = { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 };
const set = new ColliderSet([near, boxCollider(5, 0, 0, 1, 1, 1)]);
const probe = { minX: 0.5, minY: 0.5, minZ: 0.5, maxX: 1.5, maxY: 1.5, maxZ: 1.5 };

test('an overlapping collider reports its penetration on every axis', () => {
  const scratch = new Int32Array(64);
  const out = createContactReports();
  const found = describeContacts(set, probe, 0, scratch, out);

  expect(found).toBe(1);
  const hit = out[0];
  // min(1, 1.5) - max(-1, 0.5) = 0.5, the same on all three axes.
  expect(hit?.index).toBe(0);
  expect(hit?.depthX).toBeCloseTo(0.5, 6);
  expect(hit?.depthY).toBeCloseTo(0.5, 6);
  expect(hit?.depthZ).toBeCloseTo(0.5, 6);
  expect(hit?.distanceM).toBe(0);
  expect(hit?.hull).toBe(false);
});

test('a neighbour inside the radius reports its gap, not a penetration', () => {
  /*
   * The character is usually *beside* the thing that is wrong with the world rather than
   * inside it. A probe that only reported overlaps would be silent in exactly the case
   * it exists for.
   */
  const scratch = new Int32Array(64);
  const out = createContactReports();
  const found = describeContacts(set, probe, 3, scratch, out);
  expect(found).toBe(2);

  const far = out.slice(0, found).find((c) => c.index === 1);
  // x: min(1.5, 6) - max(0.5, 4) = -2.5. y and z overlap by 0.5, so the gap is x alone.
  expect(far?.depthX).toBeCloseTo(-2.5, 6);
  expect(far?.depthY).toBeCloseTo(0.5, 6);
  expect(far?.distanceM).toBeCloseTo(2.5, 6);
  // `boxCollider` builds a hull, and which one a collider is decides how it is swept.
  expect(far?.hull).toBe(true);
});

test('the output buffer is a ceiling, not a suggestion', () => {
  // A body in a pile of scenery must cost a fixed amount of memory to describe.
  const scratch = new Int32Array(64);
  const out = createContactReports(1);
  expect(describeContacts(set, probe, 3, scratch, out)).toBe(1);
});

test('the probe reports nothing where there is nothing', () => {
  // Silence has to mean something, or every empty result reads as a broken query.
  const scratch = new Int32Array(64);
  const out = createContactReports();
  const empty = { minX: 400, minY: 400, minZ: 400, maxX: 401, maxY: 401, maxZ: 401 };
  expect(describeContacts(set, empty, 0, scratch, out)).toBe(0);
});
