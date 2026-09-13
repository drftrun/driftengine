import { expect, test } from 'vitest';

import { projectDecal } from './decal.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { validateMeshData } from '../render/mesh.ts';

/** A four-metre ground plane at y = 0, facing up. */
function ground(): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addGroundQuad([-2, 0, -2], [2, 0, -2], [2, 0, 2], [-2, 0, 2], [0.4, 0.4, 0.4])
    .build();
}

/** Sum of the triangle areas of a mesh, which is what a clip is measured by. */
function area(mesh: ReturnType<MeshBuilder['build']>): number {
  let total = 0;
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const [i, j, k] = [
      mesh.indices[t * 3] ?? 0,
      mesh.indices[t * 3 + 1] ?? 0,
      mesh.indices[t * 3 + 2] ?? 0,
    ];
    const p = (v: number, axis: number): number => mesh.positions[v * 3 + axis] ?? 0;
    const ux = p(j, 0) - p(i, 0),
      uy = p(j, 1) - p(i, 1),
      uz = p(j, 2) - p(i, 2);
    const vx = p(k, 0) - p(i, 0),
      vy = p(k, 1) - p(i, 1),
      vz = p(k, 2) - p(i, 2);
    total += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 0.5;
  }
  return total;
}

/**
 * A half-metre box projected straight down onto a flat road.
 *
 * The box is 0.5 across and 0.5 up, so it covers one square metre of ground, and the mark is the
 * road's own triangles clipped to it. Area is the assertion because it is the thing a clip either
 * gets right or does not: a square metre, whatever the surface was triangulated into.
 */
test('a decal is the surface clipped to the projector, one square metre of it', () => {
  const decal = projectDecal(ground(), {
    center: [0, 0, 0],
    halfExtents: [0.5, 0.5, 1],
    forward: [0, -1, 0],
    up: [0, 0, 1],
    color: [0.1, 0.1, 0.1],
  });

  expect(area(decal), 'one metre by one metre').toBeCloseTo(1, 6);
  for (let v = 0; v < decal.positions.length / 3; v++) {
    expect(Math.abs(decal.positions[v * 3] ?? 0), 'inside the box across').toBeLessThanOrEqual(
      0.5001,
    );
    expect(Math.abs(decal.positions[v * 3 + 2] ?? 0), 'and up it').toBeLessThanOrEqual(0.5001);
    expect(decal.normals[v * 3 + 1], 'facing the way the road does').toBeCloseTo(1, 6);
  }
  validateMeshData(decal);
});

/**
 * Lifted along the surface's own normal, not along a world axis.
 *
 * Two millimetres by default, which is what keeps a mark out of a depth buffer's way at fifty
 * metres and invisible at one.
 */
test('the mark sits just off the surface it was projected onto', () => {
  const decal = projectDecal(ground(), {
    center: [0, 0, 0],
    halfExtents: [0.5, 0.5, 1],
    forward: [0, -1, 0],
    up: [0, 0, 1],
  });
  for (let v = 0; v < decal.positions.length / 3; v++) {
    expect(decal.positions[v * 3 + 1] ?? 0).toBeCloseTo(0.002, 9);
  }
});

test('the projection is the texture mapping', () => {
  const decal = projectDecal(ground(), {
    center: [0, 0, 0],
    halfExtents: [0.5, 0.5, 1],
    forward: [0, -1, 0],
    up: [0, 0, 1],
  });
  const uvs = decal.uvs ?? new Float32Array();
  let sawZero = false;
  let sawOne = false;
  for (let v = 0; v < uvs.length / 2; v++) {
    const u = uvs[v * 2] ?? 0;
    const w = uvs[v * 2 + 1] ?? 0;
    expect(u, 'inside the image').toBeGreaterThanOrEqual(-0.0001);
    expect(u).toBeLessThanOrEqual(1.0001);
    if (u < 0.0001 && w < 0.0001) sawZero = true;
    if (u > 0.9999 && w > 0.9999) sawOne = true;
  }
  expect(sawZero && sawOne, 'the corners of the box are the corners of the image').toBe(true);
});

/**
 * A surface turned away from the projector is not marked, and the test that matters is the one
 * behind the wall.
 *
 * A projector aimed down at a floor should not paint the ceiling above it, and a box deep enough to
 * reach both is exactly how that happens. The facing test is what stops it.
 */
test('a surface facing away is not marked, however deep the box reaches', () => {
  const room = new MeshBuilder()
    .addGroundQuad([-2, 0, -2], [2, 0, -2], [2, 0, 2], [-2, 0, 2], [0.4, 0.4, 0.4])
    /* A ceiling: the same quad three metres up, facing down. */
    .addWallQuad([-2, 3, -2], [2, 3, -2], [2, 3, 2], [-2, 3, 2], [0, 6, 0], [0.5, 0.5, 0.5])
    .build();

  const decal = projectDecal(room, {
    center: [0, 1.5, 0],
    /* Three metres deep: it contains the floor and the ceiling both. */
    halfExtents: [0.5, 0.5, 2],
    forward: [0, -1, 0],
    up: [0, 0, 1],
  });
  expect(area(decal), 'the floor only').toBeCloseTo(1, 6);
  for (let v = 0; v < decal.positions.length / 3; v++) {
    expect(decal.positions[v * 3 + 1] ?? 0, 'nothing landed on the ceiling').toBeLessThan(1);
  }
});

test('a projector over nothing produces nothing rather than an empty draw', () => {
  const decal = projectDecal(ground(), {
    center: [50, 0, 50],
    halfExtents: [0.5, 0.5, 1],
    forward: [0, -1, 0],
    up: [0, 0, 1],
  });
  expect(decal.indices.length).toBe(0);
  expect(decal.positions.length).toBe(0);
});

/**
 * The reason this technique was chosen over a projected quad: it *is* the surface.
 *
 * A ramp and a flat, meeting under one projector. A quad would cross both at one angle and float
 * over one of them; here each triangle keeps the shape and the normal it had, so the mark bends at
 * the join. The ramp climbs one in one, so its normal is `(0, √½, -√½)` and its area under a
 * half-metre-wide box is `√2` times the flat's.
 */
test('a decal follows a surface that changes angle under it', () => {
  const bent = new MeshBuilder()
    .addGroundQuad([-1, 0, -1], [1, 0, -1], [1, 0, 0], [-1, 0, 0], [0.4, 0.4, 0.4])
    .addGroundQuad([-1, 0, 0], [1, 0, 0], [1, 1, 1], [-1, 1, 1], [0.4, 0.4, 0.4])
    .build();

  const decal = projectDecal(bent, {
    center: [0, 0.5, 0],
    halfExtents: [0.5, 0.5, 2],
    forward: [0, -1, 0],
    up: [0, 0, 1],
  });

  let flat = 0;
  let sloped = 0;
  for (let v = 0; v < decal.normals.length / 3; v++) {
    if ((decal.normals[v * 3 + 1] ?? 0) > 0.99) flat++;
    else sloped++;
  }
  expect(flat, 'part of the mark is on the level').toBeGreaterThan(0);
  expect(sloped, 'and part of it climbs').toBeGreaterThan(0);

  /* Half a metre of flat plus half a metre of run up a one-in-one ramp: 0.5 + 0.5·√2 square metres
     over a metre of width. */
  expect(area(decal)).toBeCloseTo(1 * (0.5 + 0.5 * Math.SQRT2), 5);
});

test('a projector with no orientation is refused', () => {
  expect(() =>
    projectDecal(ground(), {
      center: [0, 0, 0],
      halfExtents: [0.5, 0.5, 1],
      forward: [0, -1, 0],
      up: [0, 1, 0],
    }),
  ).toThrow(/parallel to forward/);
  expect(() =>
    projectDecal(ground(), {
      center: [0, 0, 0],
      halfExtents: [0, 0.5, 1],
      forward: [0, -1, 0],
      up: [0, 0, 1],
    }),
  ).toThrow(/must be positive/);
});
