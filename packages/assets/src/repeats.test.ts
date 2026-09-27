import { expect, test } from 'vitest';
import { componentCount, findRepeats } from './repeats.ts';
import type { MeshData } from '@driftengine/drft';

/**
 * Copies merged into one mesh, found again.
 *
 * **Written for a bought scene that shipped ten thousand candles as one mesh of nineteen million
 * triangles**, where each copy was a run of the same triangles in the same vertex order, moved.
 * Every fixture here is built the same way: a small shape, then N runs of it, each placed by a
 * transform written out by hand, so the answer is the transform the test chose.
 */

/** A unit tetrahedron: four vertices, four triangles, normals pointing outward-ish. */
const TET = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const TET_TRIS = [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2];

/** `copies` runs of the tetrahedron, run k placed by `place(k, x, y, z)`. */
function merged(
  copies: number,
  place: (k: number, p: [number, number, number]) => [number, number, number],
): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k < copies; k++) {
    for (let v = 0; v < 4; v++) {
      const p = place(k, [
        TET[v * 3] as number,
        TET[v * 3 + 1] as number,
        TET[v * 3 + 2] as number,
      ]);
      positions.push(...p);
      /* A normal the same rotation turns: the direction from the centroid, placed like a point. */
      const o = place(k, [0.25, 0.25, 0.25]);
      const n = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      const len = Math.hypot(n[0] as number, n[1] as number, n[2] as number);
      normals.push((n[0] as number) / len, (n[1] as number) / len, (n[2] as number) / len);
    }
    for (const i of TET_TRIS) indices.push(i + k * 4);
  }
  const vertices = copies * 4;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(vertices * 3).fill(1),
    emissive: new Float32Array(vertices),
    uvs: new Float32Array(vertices * 2).fill(0.5),
    indices: new Uint32Array(indices),
  };
}

test('A MESH OF TRANSLATED COPIES IS ONE PROTOTYPE AND ONE PLACEMENT A COPY', () => {
  const mesh = merged(3, (k, p) => [p[0] + 10 * k, p[1], p[2] - 2 * k]);
  const found = findRepeats(mesh, [3]);
  expect(found).not.toBeNull();
  expect(found?.prototype.positions).toEqual(new Float32Array(TET));
  expect([...(found?.prototype.indices ?? [])]).toEqual(TET_TRIS);
  expect(found?.count).toBe(3);
  /* Copy 2 is moved by (20, 0, -4): the matrix's translation column, and the identity rotation. */
  const m = found?.transforms.subarray(32, 48) ?? new Float32Array(16);
  expect(m[12]).toBeCloseTo(20, 5);
  expect(m[13]).toBeCloseTo(0, 5);
  expect(m[14]).toBeCloseTo(-4, 5);
  expect(m[0]).toBeCloseTo(1, 6);
  expect(m[5]).toBeCloseTo(1, 6);
  expect(m[10]).toBeCloseTo(1, 6);
});

test('a rotated copy is found, and its matrix is the rotation that placed it', () => {
  /* Copy 1 is turned 90 degrees about +y, which sends +x to -z, then moved by (5, 0, 0). */
  const mesh = merged(2, (k, p) => (k === 0 ? p : [p[2] + 5, p[1], -p[0]]));
  const found = findRepeats(mesh, [2]);
  expect(found).not.toBeNull();
  const m = found?.transforms.subarray(16, 32) ?? new Float32Array(16);
  /* Column-major: the first column is where +x goes, (0, 0, -1); the third is where +z goes, (1, 0, 0). */
  expect(m[0]).toBeCloseTo(0, 5);
  expect(m[2]).toBeCloseTo(-1, 5);
  expect(m[8]).toBeCloseTo(1, 5);
  expect(m[10]).toBeCloseTo(0, 5);
  expect(m[12]).toBeCloseTo(5, 5);
});

test('A SCALED COPY IS NOT A RIGID COPY, and the mesh is left alone', () => {
  const mesh = merged(2, (k, p) => (k === 0 ? p : [p[0] * 2, p[1] * 2, p[2] * 2]));
  expect(findRepeats(mesh, [2])).toBeNull();
});

test('one vertex out of place refuses the whole count, not just its copy', () => {
  const mesh = merged(4, (k, p) => [p[0] + 3 * k, p[1], p[2]]);
  /* Copy 3's first vertex, nudged a centimetre: past any tolerance a unit shape allows. */
  mesh.positions[12 * 3] = (mesh.positions[12 * 3] as number) + 0.01;
  expect(findRepeats(mesh, [4])).toBeNull();
});

test('a copy that differs in a UV is a different object, not a repeat', () => {
  const mesh = merged(2, (k, p) => [p[0] + 3 * k, p[1], p[2]]);
  (mesh.uvs as Float32Array)[4 * 2] = 0.75;
  expect(findRepeats(mesh, [2])).toBeNull();
});

test('the largest count that works wins, and a count that does not divide is skipped', () => {
  const mesh = merged(6, (k, p) => [p[0] + 3 * k, p[1], p[2]]);
  expect(findRepeats(mesh, [2, 3, 6, 4])?.count).toBe(6);
  expect(
    findRepeats(
      merged(1, (_, p) => p),
      [1, 2],
    ),
  ).toBeNull();
});

test('connected pieces are counted through the indices', () => {
  expect(componentCount(merged(5, (k, p) => [p[0] + 3 * k, p[1], p[2]]))).toBe(5);
});

test('A VERTEX A CENTIMETRE OUT IN A DENSE COPY IS CAUGHT BY POSITION, not by the normals', () => {
  /*
   * On a four-vertex shape a nudged vertex tilts the whole fit, and the normals refuse it before
   * any position is compared — so the test above proves a refusal and not this tolerance. A
   * hundred-vertex grid barely moves its fit for one vertex, and only the position check sees it.
   */
  const side = 10;
  const copies = 3;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k < copies; k++) {
    for (let j = 0; j < side; j++)
      for (let i = 0; i < side; i++) positions.push(i * 0.1 + 5 * k, 0, j * 0.1);
    for (let j = 0; j + 1 < side; j++) {
      for (let i = 0; i + 1 < side; i++) {
        const a = k * side * side + j * side + i;
        indices.push(a, a + side, a + 1, a + 1, a + side, a + side + 1);
      }
    }
  }
  const vertices = copies * side * side;
  const mesh: MeshData = {
    positions: new Float32Array(positions),
    normals: new Float32Array(vertices * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)),
    colors: new Float32Array(vertices * 3).fill(1),
    emissive: new Float32Array(vertices),
    indices: new Uint32Array(indices),
  };
  expect(findRepeats(mesh, [copies])?.count, 'the unmoved grid is three copies').toBe(copies);
  /* The middle vertex of copy 2, one centimetre up: 1% of a one-metre shape. */
  mesh.positions[(2 * side * side + 55) * 3 + 1] = 0.01;
  expect(findRepeats(mesh, [copies])).toBeNull();
});

test('COPIES THAT SHARE THEIR VERTICES DIFFERENTLY ARE STILL FOUND, THROUGH THEIR TRIANGLES', () => {
  /*
   * A bought scene's candle wicks: every copy the same 128 triangles, but the exporter shared
   * vertices differently from copy to copy, so the vertex count did not divide by the copies at
   * all. Copy 0 here shares its corners; copy 1 is the same four triangles with every corner its
   * own vertex. Expanded to one vertex a corner, the two runs are the same shape.
   */
  const shared = merged(1, (_, p) => p);
  const soupPositions: number[] = [];
  const soupNormals: number[] = [];
  for (const i of TET_TRIS) {
    soupPositions.push(
      (TET[i * 3] as number) + 4,
      TET[i * 3 + 1] as number,
      TET[i * 3 + 2] as number,
    );
    soupNormals.push(
      shared.normals[i * 3] as number,
      shared.normals[i * 3 + 1] as number,
      shared.normals[i * 3 + 2] as number,
    );
  }
  const corners = TET_TRIS.length;
  const mesh: MeshData = {
    positions: new Float32Array([...shared.positions, ...soupPositions]),
    normals: new Float32Array([...shared.normals, ...soupNormals]),
    colors: new Float32Array((4 + corners) * 3).fill(1),
    emissive: new Float32Array(4 + corners),
    uvs: new Float32Array((4 + corners) * 2).fill(0.5),
    indices: new Uint32Array([...TET_TRIS, ...TET_TRIS.map((_, k) => 4 + k)]),
  };
  const found = findRepeats(mesh, [2]);
  expect(found?.count).toBe(2);
  /* The prototype is a corner expansion: twelve vertices for four triangles, one a corner. */
  expect(found?.prototype.positions.length).toBe(corners * 3);
  /* Copy 1 is moved 4 along x: its matrix is the second block, its translation at float 16 + 12. */
  expect(found?.transforms[28]).toBeCloseTo(4, 5);
});
