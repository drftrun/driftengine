import type { MeshData } from '@driftengine/drft';
import { expect, test } from 'vitest';

import { decimate } from './decimate.ts';
import { createVolume, type Volume } from './fusion.ts';
import { marchVolume } from './marching.ts';

/**
 * **Fewer triangles, the same shape, and still facing outwards.**
 *
 * A marched surface spends its triangles on the lattice it was sampled on rather than on the shape
 * it is: a flat wall costs as much as a folded one. What has to hold after decimation is that the
 * budget is met, that the silhouette has not moved further than a stated tolerance, that an open
 * mesh still ends where the evidence ended, and that nothing has turned inside out — the last two
 * being the ones that look fine in a picture and fail against a character walking on them.
 */

const SPACING = 0.1;
const SIDE = 21;
const ORIGIN = [-1, -1, -1] as const;
const RADIUS = 0.6;

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

/** How many triangles, and how far the worst vertex is from the sphere it came from. */
function offSphere(mesh: MeshData): number {
  let worst = 0;
  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
    const x = mesh.positions[vertex * 3] as number;
    const y = mesh.positions[vertex * 3 + 1] as number;
    const z = mesh.positions[vertex * 3 + 2] as number;
    worst = Math.max(worst, Math.abs(Math.sqrt(x * x + y * y + z * z) - RADIUS));
  }
  return worst;
}

/** How long an open mesh's border is, all the way round. */
function borderLength(mesh: MeshData): number {
  const counted = new Map<string, number>();
  for (let at = 0; at < mesh.indices.length; at += 3) {
    for (let slot = 0; slot < 3; slot += 1) {
      const a = mesh.indices[at + slot] as number;
      const b = mesh.indices[at + ((slot + 1) % 3)] as number;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
  }
  let total = 0;
  for (const [key, count] of counted) {
    if (count !== 1) continue;
    const [a, b] = key.split('-').map((value) => Number(value)) as [number, number];
    let square = 0;
    for (let k = 0; k < 3; k += 1) {
      const step = (mesh.positions[a * 3 + k] as number) - (mesh.positions[b * 3 + k] as number);
      square += step * step;
    }
    total += Math.sqrt(square);
  }
  return total;
}

/** A torus written analytically, which is the shape a sphere is not: it has a hole to collapse across. */
function torus(): Volume {
  const side = 41;
  const spacing = 0.05;
  const volume = createVolume([side, side, side], [-1, -1, -1], spacing);
  for (let k = 0; k < side; k += 1) {
    for (let j = 0; j < side; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const x = -1 + i * spacing;
        const y = -1 + j * spacing;
        const z = -1 + k * spacing;
        const ring = Math.sqrt(x * x + z * z) - 0.55;
        const at = (k * side + j) * side + i;
        volume.distance[at] = Math.sqrt(ring * ring + y * y) - 0.18;
        volume.weight[at] = 1;
      }
    }
  }
  return volume;
}

/** Faces pointing the wrong way, against the torus's own outward direction. */
function facingInOnTorus(mesh: MeshData): number {
  let count = 0;
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
    const middle = [0, 1, 2].map((axis) => (point(a, axis) + point(b, axis) + point(c, axis)) / 3);
    const radius = Math.sqrt(
      (middle[0] as number) * (middle[0] as number) + (middle[2] as number) * (middle[2] as number),
    );
    const scale = (radius - 0.55) / Math.max(1e-9, radius);
    const outward =
      (face[0] as number) * (middle[0] as number) * scale +
      (face[1] as number) * (middle[1] as number) +
      (face[2] as number) * (middle[2] as number) * scale;
    if (outward <= 0) count += 1;
  }
  return count;
}

/** Edges used by exactly one triangle: an open mesh's border. */
function border(mesh: MeshData): number {
  const counted = new Map<string, number>();
  for (let at = 0; at < mesh.indices.length; at += 3) {
    for (let slot = 0; slot < 3; slot += 1) {
      const a = mesh.indices[at + slot] as number;
      const b = mesh.indices[at + ((slot + 1) % 3)] as number;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
  }
  return [...counted.values()].filter((count) => count === 1).length;
}

/** How many faces point back at the middle of a sphere they are supposed to enclose. */
function facingIn(mesh: MeshData): number {
  let count = 0;
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
    const middle = [0, 1, 2].map((axis) => (point(a, axis) + point(b, axis) + point(c, axis)) / 3);
    const outward =
      (face[0] as number) * (middle[0] as number) +
      (face[1] as number) * (middle[1] as number) +
      (face[2] as number) * (middle[2] as number);
    if (outward <= 0) count += 1;
  }
  return count;
}

test('A SPHERE MEETS ITS BUDGET AND KEEPS ITS SHAPE', () => {
  const full = marchVolume(sphere());
  const before = full.indices.length / 3;
  expect(before).toBeGreaterThan(3000);
  /* It started 0.05 m from a perfect sphere, because a curve is cut by its chord. */
  expect(offSphere(full)).toBeLessThan(SPACING * 0.5);

  const budget = 600;
  const small = decimate(full, budget);
  expect(small.indices.length / 3).toBeLessThanOrEqual(budget);
  expect(small.indices.length / 3).toBeGreaterThan(budget * 0.8);
  /*
   * A sixth of the triangles and the surface has moved by a third of a sample spacing. The
   * tolerance is measured rather than chosen: what this fails on is a collapse that ignores its
   * quadric and wanders, which moves a vertex by whole spacings at a time.
   */
  expect(offSphere(small)).toBeLessThan(SPACING * 0.4);
  expect(facingIn(small)).toBe(0);
  /* Still closed: a decimation that tore the surface would leave a border where there was none. */
  expect(border(small)).toBe(0);
});

test('AN OPEN MESH KEEPS ITS BORDER, because that is where the evidence stopped', () => {
  const full = marchVolume(sphere((_x, y) => y > -0.05));
  expect(border(full)).toBeGreaterThan(20);
  const was = borderLength(full);

  const small = decimate(full, Math.floor(full.indices.length / 3 / 4));
  /*
   * **Measured by the border's length rather than by its edge count**, which is what the first
   * attempt used and which passed with the border weight set to nothing. A border left to collapse
   * like any other edge does not vanish — it goes *ragged*, and its length grows: measured at 3.765
   * metres before, 3.763 with the weight and 3.985 without it. Held, it is the same border.
   */
  expect(Math.abs(borderLength(small) - was) / was).toBeLessThan(0.02);
  let lowest = Infinity;
  for (let vertex = 0; vertex < small.positions.length / 3; vertex += 1) {
    lowest = Math.min(lowest, small.positions[vertex * 3 + 1] as number);
  }
  expect(lowest).toBeGreaterThan(-0.25);
});

test('A COLLAPSE THAT WOULD TURN A FACE INSIDE OUT IS REFUSED', () => {
  /*
   * **On a torus, because a sphere cannot show it.** Every collapse on a convex surface leaves the
   * faces around it pointing much where they did, so the refusal never fires and a decimation with
   * it taken out is identical — which is what the first attempt at this test measured, and passed.
   * A torus has a hole, and a collapse across it inverts the faces on the far side: measured on the
   * same mesh at the same budget, **four inverted faces without the refusal and none with it**.
   */
  const full = marchVolume(torus());
  expect(full.indices.length / 3).toBeGreaterThan(10000);
  expect(facingInOnTorus(full)).toBe(0);

  const small = decimate(full, 2000);
  expect(small.indices.length / 3).toBeLessThanOrEqual(2000);
  expect(facingInOnTorus(small)).toBe(0);
});

test('a mesh already inside its budget is handed back as it stands', () => {
  const full = marchVolume(sphere());
  const same = decimate(full, full.indices.length / 3);
  expect(Array.from(same.indices)).toEqual(Array.from(full.indices));
  expect(Array.from(same.positions)).toEqual(Array.from(full.positions));
  /* A copy rather than the caller's own arrays, so a caller never has to ask which it got. */
  expect(same.positions).not.toBe(full.positions);
});

test('the same mesh and budget give the same mesh', () => {
  const full = marchVolume(sphere());
  const first = decimate(full, 800);
  const second = decimate(full, 800);
  expect(Array.from(second.indices)).toEqual(Array.from(first.indices));
  expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
  expect(Array.from(second.normals)).toEqual(Array.from(first.normals));
});

test('a budget of nothing is refused rather than dissolving the mesh', () => {
  const full = marchVolume(sphere());
  const same = decimate(full, 0);
  expect(same.indices.length).toBe(full.indices.length);
});
