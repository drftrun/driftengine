import { expect, test } from 'vitest';
import { emptySolid, mergeSolids, solidToMesh, solidVolume, transformSolid } from './solid.ts';
import type { Solid } from './solid.ts';
import { edgesPairOnce, normalsFaceOutward, scaling, translation } from './solidHarness.ts';
import { solidBox, solidExtrude, solidPrism, solidRoundedBox, solidSweep } from './solidFlat.ts';
import {
  solidCapsule,
  solidCone,
  solidCylinder,
  solidFrustum,
  solidHemisphere,
  solidIcosphere,
  solidLathe,
  solidSphere,
  solidTorus,
  solidTube,
} from './solidRound.ts';
import { smoothSolidNormals } from './solidNormals.ts';

/**
 * Solids are checked the way a closed surface can be: every edge shared by exactly two triangles
 * running opposite ways, every vertex normal on the outward side of its triangle, and the volume
 * the divergence theorem gives equal to one derived by hand from the shape's own formula.
 */

test('A BOX IS CLOSED, FACES OUTWARD, AND HOLDS EXACTLY ITS VOLUME', () => {
  const box = solidBox(2, 3, 4);
  expect(edgesPairOnce(box)).toBe(true);
  expect(normalsFaceOutward(box)).toBe(true);
  expect(solidVolume(box)).toBeCloseTo(24, 10);
  expect(box.positions.length / 3, 'faceted: four corners per face').toBe(24);
  expect(box.uvs.length / 2).toBe(24);
});

test("MERGING SOLIDS ADDS THEIR VOLUMES and offsets the second one's indices", () => {
  const a = solidBox(1, 1, 1);
  const b = transformSolid(solidBox(1, 1, 1), translation(5, 0, 0));
  const merged = mergeSolids([a, b]);
  expect(solidVolume(merged)).toBeCloseTo(2, 10);
  expect(merged.indices[a.indices.length]).toBe(a.positions.length / 3 + (b.indices[0] ?? 0));
  expect(mergeSolids([]).indices.length, 'nothing merged is empty, not an error').toBe(0);
  expect(solidVolume(emptySolid())).toBe(0);
});

test('A NON-UNIFORM SCALE KEEPS NORMALS PERPENDICULAR TO THE SURFACE (inverse transpose)', () => {
  /*
   * A sphere scaled to an ellipsoid with semi-axes (1, 2, 4). The true normal at (x, y, z) is
   * proportional to (x/a², y/b², z/c²) — the gradient of x²/a² + y²/b² + z²/c² — which a normal
   * rotated by the model matrix itself does not follow.
   */
  const e = transformSolid(solidSphere(1, 24, true), scaling(1, 2, 4));
  let checked = 0;
  for (let v = 0; v < e.positions.length / 3; v += 7) {
    const x = e.positions[v * 3] ?? 0;
    const y = e.positions[v * 3 + 1] ?? 0;
    const z = e.positions[v * 3 + 2] ?? 0;
    const gx = x;
    const gy = y / 4;
    const gz = z / 16;
    const len = Math.hypot(gx, gy, gz);
    const dot =
      ((e.normals[v * 3] ?? 0) * gx +
        (e.normals[v * 3 + 1] ?? 0) * gy +
        (e.normals[v * 3 + 2] ?? 0) * gz) /
      len;
    expect(dot).toBeGreaterThan(0.995);
    checked++;
  }
  expect(checked).toBeGreaterThan(20);
  expect(
    solidVolume(transformSolid(solidBox(1, 1, 1), scaling(-1, 1, 1))),
    'a mirror flips the winding back to outward',
  ).toBeCloseTo(1, 10);
});

test('A SOLID BECOMES A MESH with its colour on every vertex', () => {
  const mesh = solidToMesh(solidBox(1, 1, 1), [0.25, 0.5, 0.75], 0.4);
  expect(mesh.positions.length).toBe(72);
  expect([mesh.colors[0], mesh.colors[1], mesh.colors[2]]).toEqual([0.25, 0.5, 0.75]);
  expect(mesh.emissive[23]).toBeCloseTo(0.4, 6);
  expect(mesh.uvs?.length).toBe(48);
});

test('ROUND AND FLAT PRIMITIVES ARE CLOSED AND HOLD THEIR POLYGONAL VOLUMES', () => {
  /*
   * An n-gon of circumradius r has area (n/2)·r²·sin(2π/n). A prism of that section and height h
   * holds h times it, a pyramid a third of that, and a frustum (h/3)(A0 + A1 + √(A0·A1)).
   */
  const n = 16;
  const h = 3;
  const area = (r: number): number => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
  const cases: [string, Solid, number][] = [
    ['cylinder', solidCylinder(0.5, h, n), h * area(0.5)],
    ['cylinder, smooth', solidCylinder(0.5, h, n, true), h * area(0.5)],
    ['cone', solidCone(0.5, h, n), (h * area(0.5)) / 3],
    [
      'frustum',
      solidFrustum(1, 0.5, h, n),
      (h / 3) * (area(1) + area(0.5) + Math.sqrt(area(1) * area(0.5))),
    ],
    ['tube', solidTube(1, 0.25, h, n), h * (area(1) - area(0.75))],
    ['square tube', solidTube(1, 0.25, h, 4), h * (2 - 2 * 0.75 * 0.75)],
    ['extrude', solidExtrude([0, 0, 2, 0, 2, -1, 0, -1], 3), 6],
    ['extrude, centred', solidExtrude([0, 0, 0, 1, 1, 1, 1, 0], 2, true), 2],
    ['prism', solidPrism(2, 1, 4), 4],
    ['right prism', solidPrism(2, 1, 4, true), 4],
    ['lathe of a unit square', solidLathe([0, 0, 1, 0, 1, 1, 0, 1], n), area(1)],
    [
      'sweep of a unit square along a straight path',
      solidSweep([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], [0, 0, 0, 0, 0, 1, 0, 0, 3], true),
      3,
    ],
  ];
  for (const [name, s, v] of cases) {
    expect(edgesPairOnce(s), `${name} is closed`).toBe(true);
    expect(normalsFaceOutward(s), `${name} faces outward`).toBe(true);
    expect(solidVolume(s), `${name} volume`).toBeCloseTo(v, 6);
  }
});

test('CURVED PRIMITIVES CONVERGE ON THEIR ANALYTIC VOLUMES', () => {
  /*
   * The rounded box is the Minkowski sum of its inner box (1×1×1 here) and a sphere of the
   * radius: the inner volume, six face slabs of area 1 and depth r, twelve quarter-cylinders of
   * length 1, and eight eighth-spheres making one whole one.
   */
  const r = 0.5;
  const rounded = 1 + 6 * r + 12 * ((Math.PI * r * r) / 4) + (4 / 3) * Math.PI * r ** 3;
  const cases: [string, Solid, number, number][] = [
    ['sphere', solidSphere(1, 96), (4 / 3) * Math.PI, 0.005],
    ['hemisphere', solidHemisphere(1, 96), (2 / 3) * Math.PI, 0.005],
    ['icosphere', solidIcosphere(1, 4), (4 / 3) * Math.PI, 0.01],
    ['torus (2π²Rr²)', solidTorus(2, 0.5, 128, 64), 2 * Math.PI * Math.PI * 2 * 0.25, 0.005],
    ['capsule', solidCapsule(0.5, 2, 96), Math.PI * 0.25 * 2 + (4 / 3) * Math.PI * 0.125, 0.005],
    ['rounded box', solidRoundedBox(2, 2, 2, r, 16), rounded, 0.005],
  ];
  for (const [name, s, v, tol] of cases) {
    expect(edgesPairOnce(s), `${name} is closed`).toBe(true);
    expect(normalsFaceOutward(s), `${name} faces outward`).toBe(true);
    expect(Math.abs(solidVolume(s) - v) / v, `${name} within ${tol}`).toBeLessThan(tol);
  }
});

test("SMOOTHING KEEPS A CUBE'S CREASES AND ROUNDS A CYLINDER'S SIDE", () => {
  const cube = smoothSolidNormals(solidBox(1, 1, 1), 30);
  for (let v = 0; v < cube.normals.length / 3; v++) {
    const n = [
      cube.normals[v * 3] ?? 0,
      cube.normals[v * 3 + 1] ?? 0,
      cube.normals[v * 3 + 2] ?? 0,
    ];
    expect(Math.max(...n.map(Math.abs)), 'a face normal survives a 90° crease').toBeCloseTo(1, 6);
  }
  const cyl = smoothSolidNormals(solidCylinder(1, 2, 32), 30);
  let sides = 0;
  for (let v = 0; v < cyl.normals.length / 3; v++) {
    if (Math.abs(cyl.normals[v * 3 + 1] ?? 0) > 0.5) continue;
    const x = cyl.positions[v * 3] ?? 0;
    const z = cyl.positions[v * 3 + 2] ?? 0;
    const len = Math.hypot(x, z);
    expect(
      (x / len) * (cyl.normals[v * 3] ?? 0) + (z / len) * (cyl.normals[v * 3 + 2] ?? 0),
    ).toBeGreaterThan(0.9999);
    sides++;
  }
  expect(sides).toBeGreaterThan(0);
});
