import { expect, test } from 'vitest';

import { createVolume, type Volume } from './fusion.ts';
import { marchVolume } from './marching.ts';

/**
 * **A surface that is closed where the volume is known, and faces outwards.**
 *
 * Two failures this is written against, and both are quiet. A mesh with holes passes every look at
 * a picture and leaks whatever is poured through it — light, a physics query, a character. A mesh
 * wound inside-out collides in reverse: something stands on the floor and falls through the world,
 * which reads as a physics fault and is a meshing one.
 *
 * The scene is a sphere written analytically rather than fused, because what is under test here is
 * the marching and not the fusion: a volume whose distances are exactly right isolates it.
 */

const SPACING = 0.1;
const SIDE = 21;
const ORIGIN = [-1, -1, -1] as const;
const RADIUS = 0.6;

/** The sphere's own distance field, everywhere, with every sample known. */
function sphere(known: (x: number, y: number, z: number) => boolean = () => true): Volume {
  const volume = createVolume([SIDE, SIDE, SIDE], ORIGIN, SPACING);
  for (let k = 0; k < SIDE; k += 1) {
    for (let j = 0; j < SIDE; j += 1) {
      for (let i = 0; i < SIDE; i += 1) {
        const x = (ORIGIN[0] as number) + i * SPACING;
        const y = (ORIGIN[1] as number) + j * SPACING;
        const z = (ORIGIN[2] as number) + k * SPACING;
        const at = (k * SIDE + j) * SIDE + i;
        volume.distance[at] = Math.sqrt(x * x + y * y + z * z) - RADIUS;
        volume.weight[at] = known(x, y, z) ? 1 : 0;
      }
    }
  }
  return volume;
}

/** Every edge of every triangle, as a key with its direction. */
function edges(indices: Uint32Array): Map<string, number> {
  const seen = new Map<string, number>();
  for (let at = 0; at < indices.length; at += 3) {
    const triangle = [indices[at] as number, indices[at + 1] as number, indices[at + 2] as number];
    for (let side = 0; side < 3; side += 1) {
      const from = triangle[side] as number;
      const to = triangle[(side + 1) % 3] as number;
      const key = from < to ? `${from}-${to}` : `${to}-${from}`;
      const direction = from < to ? 1 : -1;
      seen.set(key, (seen.get(key) ?? 0) + direction);
    }
  }
  return seen;
}

test('A SPHERE MARCHES TO A CLOSED SURFACE: every edge is shared by exactly two triangles', () => {
  const mesh = marchVolume(sphere());
  expect(mesh.indices.length).toBeGreaterThan(300);
  expect(mesh.positions.length / 3).toBeGreaterThan(100);

  const counted = new Map<string, number>();
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const triangle = [
      mesh.indices[at] as number,
      mesh.indices[at + 1] as number,
      mesh.indices[at + 2] as number,
    ];
    for (let side = 0; side < 3; side += 1) {
      const from = triangle[side] as number;
      const to = triangle[(side + 1) % 3] as number;
      const key = from < to ? `${from}-${to}` : `${to}-${from}`;
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
  }
  /* A closed surface has no border: every edge belongs to two faces and no more. */
  const open = [...counted.values()].filter((count) => count !== 2);
  expect(open.length).toBe(0);

  /* And each of those pairs traverses the edge once each way, which is a consistent winding. */
  const directed = [...edges(mesh.indices).values()].filter((sum) => sum !== 0);
  expect(directed.length).toBe(0);
});

test('the surface is where the sphere is, and its normals point away from the middle', () => {
  const mesh = marchVolume(sphere());
  let worst = 0;
  let inward = 0;
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
    const x = mesh.positions[vertex * 3] as number;
    const y = mesh.positions[vertex * 3 + 1] as number;
    const z = mesh.positions[vertex * 3 + 2] as number;
    worst = Math.max(worst, Math.abs(Math.sqrt(x * x + y * y + z * z) - RADIUS));
    /* Out of a sphere at the origin is away from the origin. */
    const outward =
      x * (mesh.normals[vertex * 3] as number) +
      y * (mesh.normals[vertex * 3 + 1] as number) +
      z * (mesh.normals[vertex * 3 + 2] as number);
    if (outward <= 0) inward += 1;
  }
  /* The crossing is found by a straight line between two samples, so a curve is cut by its chord. */
  expect(worst).toBeLessThan(SPACING * 0.5);
  expect(inward).toBe(0);
});

test('EVERY FACE IS WOUND OUTWARDS, which is what stops a mesh colliding inside-out', () => {
  const mesh = marchVolume(sphere());
  let faces = 0;
  let facingIn = 0;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const [a, b, c] = [
      mesh.indices[at] as number,
      mesh.indices[at + 1] as number,
      mesh.indices[at + 2] as number,
    ];
    const point = (index: number, axis: number) => mesh.positions[index * 3 + axis] as number;
    const u = [0, 1, 2].map((axis) => point(b, axis) - point(a, axis));
    const v = [0, 1, 2].map((axis) => point(c, axis) - point(a, axis));
    const face = [
      (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
      (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
      (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
    ];
    /* Against the middle of the triangle, which for a sphere at the origin is its own outward. */
    const middle = [0, 1, 2].map((axis) => (point(a, axis) + point(b, axis) + point(c, axis)) / 3);
    const outward =
      (face[0] as number) * (middle[0] as number) +
      (face[1] as number) * (middle[1] as number) +
      (face[2] as number) * (middle[2] as number);
    faces += 1;
    if (outward <= 0) facingIn += 1;
  }
  expect(faces).toBeGreaterThan(100);
  expect(facingIn).toBe(0);
});

test('an open scene keeps its boundary rather than growing a surface to close it', () => {
  /*
   * The same sphere with everything below the middle never seen — a clip that walked around the
   * front of something and never looked underneath. What must **not** appear is a floor across the
   * bottom: the capture has no evidence there, and a surface drawn through it would be one nobody
   * measured. So the mesh is open, and the hole is exactly where the evidence stops.
   */
  const mesh = marchVolume(sphere((_x, y) => y > -0.05));
  expect(mesh.indices.length).toBeGreaterThan(150);

  let lowest = Infinity;
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
    lowest = Math.min(lowest, mesh.positions[vertex * 3 + 1] as number);
  }
  /* Nothing below where the volume stopped being known, and certainly no cap under the sphere. */
  expect(lowest).toBeGreaterThan(-0.2);

  /* It is open: some edges belong to one triangle, which is the boundary and is meant to be there. */
  const counted = new Map<string, number>();
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const triangle = [
      mesh.indices[at] as number,
      mesh.indices[at + 1] as number,
      mesh.indices[at + 2] as number,
    ];
    for (let side = 0; side < 3; side += 1) {
      const from = triangle[side] as number;
      const to = triangle[(side + 1) % 3] as number;
      const key = from < to ? `${from}-${to}` : `${to}-${from}`;
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
  }
  const border = [...counted.values()].filter((count) => count === 1);
  expect(border.length).toBeGreaterThan(10);
});

test('a volume with no crossing is an empty mesh, not a throw', () => {
  const empty = createVolume([4, 4, 4], [0, 0, 0], 0.1);
  empty.distance.fill(0.5);
  empty.weight.fill(1);
  const mesh = marchVolume(empty);
  expect(mesh.indices.length).toBe(0);
  expect(mesh.positions.length).toBe(0);
  /*
   * **Every attribute is one the container will accept**, which for emissive means one float a
   * vertex and here means none. This line asserted three until 2026-09-20, and three is what
   * `MeshData` means by `emissiveColor` rather than by `emissive` — a defect nothing could see
   * until a captured mesh was written to a `.drft`, where the writer checks each attribute's
   * length against the vertex count and refuses a short one by name.
   */
  expect(mesh.emissive.length).toBe(0);
  expect(mesh.colors.length).toBe(0);
});

test('the same volume marches to the same mesh', () => {
  const first = marchVolume(sphere());
  const second = marchVolume(sphere());
  expect(Array.from(second.indices)).toEqual(Array.from(first.indices));
  expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
  expect(Array.from(second.normals)).toEqual(Array.from(first.normals));
});
