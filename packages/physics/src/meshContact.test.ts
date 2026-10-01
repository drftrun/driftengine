import { expect, test } from 'vitest';
import { createManifold } from './manifold.ts';
import { collideMesh } from './meshContact.ts';
import { meshShape } from './meshShape.ts';
import { capsuleShape, sphereShape } from './shape.ts';

/**
 * The interior-edge filter against a curved body: a sphere or capsule's contact points lie on the
 * triangle, so the separation after the filter has to be measured from the body's centre — the
 * number `collideMesh` reports is what the solver and every sweep read.
 */

/** A floor two metres square at y = 0, split along the diagonal from (−1, −1) to (1, 1). */
const FLOOR = meshShape(
  new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
  Uint32Array.from([0, 2, 1, 0, 3, 2]),
);
const AT_REST = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

test('A SPHERE OVER A FLOOR’S DIAGONAL REPORTS ITS REAL GAP, not zero', () => {
  /*
   * Radius 0.5, centre 0.53 above the floor over one triangle, 0.07 from the diagonal: the other
   * triangle's nearest point is on that diagonal, at a slant, and its interior-edge contact is what
   * the filter turns straight up. A 0.03 gap either way.
   */
  const out = [createManifold(), createManifold(), createManifold(), createManifold()];
  const pose = { x: 0.25, y: 0.53, z: 0.15, qx: 0, qy: 0, qz: 0, qw: 1 };
  const met = collideMesh(sphereShape(0.5), pose, FLOOR, AT_REST, 0.1, out);
  expect(met).toBeGreaterThan(0);
  for (let m = 0; m < met; m++) {
    expect(out[m]?.ny, 'straight up, off the face').toBeCloseTo(-1, 6);
    expect(out[m]?.separations[0], 'the gap between the sphere and the floor').toBeCloseTo(0.03, 5);
  }
});

test('a capsule standing on the floor reports touching, and one sunk a little reports its depth', () => {
  const out = [createManifold(), createManifold(), createManifold(), createManifold()];
  const standing = { x: 0.1, y: 0.95, z: 0.1, qx: 0, qy: 0, qz: 0, qw: 1 };
  let met = collideMesh(capsuleShape(0.35, 0.6), standing, FLOOR, AT_REST, 0.1, out);
  expect(met).toBeGreaterThan(0);
  expect(Math.min(...out.slice(0, met).map((m) => m.separations[0] ?? 1))).toBeCloseTo(0, 5);
  const sunk = { x: 0.1, y: 0.9, z: 0.1, qx: 0, qy: 0, qz: 0, qw: 1 };
  met = collideMesh(capsuleShape(0.35, 0.6), sunk, FLOOR, AT_REST, 0.1, out);
  expect(Math.min(...out.slice(0, met).map((m) => m.separations[0] ?? 1))).toBeCloseTo(-0.05, 5);
});
