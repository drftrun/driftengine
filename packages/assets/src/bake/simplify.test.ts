import { expect, test } from 'vitest';
import type { MeshData } from '@driftengine/drft';
import { simplifyMesh } from './simplify.ts';

/**
 * The bake-time simplifier, held to the promises a model's author is owed: the surface moves no
 * further than asked, nothing turns over, a texture stays where it was painted, a seam stays shut, and
 * a mesh it cannot reason about comes back untouched.
 *
 * Every mesh here is built by hand, so each expectation is a count or a coordinate worked out from
 * the construction rather than from the code under test.
 */

/** An `n` × `n` grid of quads over [0, 1]², flat at y = height(x, z), with uvs equal to x and z. */
function grid(n: number, height: (x: number, z: number) => number = () => 0): MeshData {
  const side = n + 1;
  const count = side * side;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = j * side + i;
      const x = i / n;
      const z = j / n;
      positions.set([x, height(x, z), z], v * 3);
      normals.set([0, 1, 0], v * 3);
      uvs.set([x, z], v * 2);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      /* Wound so the face normal is +y. */
      indices.push(a, c, b, b, c, d);
    }
  }
  return {
    positions,
    normals,
    colors: new Float32Array(count * 3).fill(1),
    emissive: new Float32Array(count),
    uvs,
    indices: new Uint32Array(indices),
  };
}

function faceNormalY(mesh: MeshData, face: number): number {
  const p = mesh.positions;
  const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[face * 3 + k] as number) as [
    number,
    number,
    number,
  ];
  const ux = (p[b * 3] as number) - (p[a * 3] as number);
  const uy = (p[b * 3 + 1] as number) - (p[a * 3 + 1] as number);
  const uz = (p[b * 3 + 2] as number) - (p[a * 3 + 2] as number);
  const vx = (p[c * 3] as number) - (p[a * 3] as number);
  const vy = (p[c * 3 + 1] as number) - (p[a * 3 + 1] as number);
  const vz = (p[c * 3 + 2] as number) - (p[a * 3 + 2] as number);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return ny / Math.hypot(nx, ny, nz);
}

test('A FLAT GRID COMES DOWN TO ITS CORNERS, and every vertex left is one it had', () => {
  /*
   * 800 triangles of a plane: nothing about the surface needs more than the two its corners make,
   * and a border that is a straight line needs no vertex in the middle of a side either.
   */
  const source = grid(20);
  const out = simplifyMesh(source, { maxError: 1e-4 });
  expect(out.indices.length / 3).toBe(2);
  /* Half-edge collapses keep a survivor's own attributes: each vertex is an original, uv and all. */
  for (let v = 0; v < out.positions.length / 3; v++) {
    const x = out.positions[v * 3] as number;
    const z = out.positions[v * 3 + 2] as number;
    expect([0, 1]).toContain(x);
    expect([0, 1]).toContain(z);
    expect(out.uvs?.[v * 2]).toBe(x);
    expect(out.uvs?.[v * 2 + 1]).toBe(z);
  }
  for (let f = 0; f < out.indices.length / 3; f++) expect(faceNormalY(out, f)).toBeCloseTo(1, 6);
});

test('A CURVED SURFACE KEEPS WHAT THE ERROR BOUND SAYS IT MUST', () => {
  /*
   * A bowl, y = (x - 0.5)² + (z - 0.5)², sampled 16 × 16. Its curvature is 2 everywhere, so
   * replacing a span `s` of it by a chord moves the surface by about s² / 4: a tenth of a millimetre
   * allows spans of 2 cm, which the sampling (6 cm) already exceeds, and nothing may go. A
   * centimetre allows spans of 20 cm, and most of it goes.
   */
  const bowl = grid(16, (x, z) => (x - 0.5) ** 2 + (z - 0.5) ** 2);
  const faces = bowl.indices.length / 3;
  /* The shape's bound alone: its planar uvs are held by the test below, not this one. */
  const shape = { maxUvError: 1 };
  expect(simplifyMesh(bowl, { maxError: 1e-4, ...shape }).indices.length / 3).toBe(faces);
  const loose = simplifyMesh(bowl, { maxError: 0.01, ...shape }).indices.length / 3;
  expect(loose).toBeLessThan(faces / 2);
  expect(loose).toBeGreaterThan(8);
});

test('A HEIGHT FIELD NEVER TURNS A FACE OVER', () => {
  /* A ridge sharp enough that a careless collapse across it would fold a face under. */
  const withUvs = grid(24, (x) => (Math.abs(x - 0.5) < 0.05 ? 0.2 : 0));
  /* No uvs and one normal throughout, so only the face check stands between a collapse and a fold. */
  const { uvs: _dropped, ...ridge } = withUvs;
  /* A bound loose enough that the shape's error allows everything, so the fold is the test. */
  const out = simplifyMesh(ridge, { maxError: 1 });
  expect(out.indices.length).toBeLessThan(ridge.indices.length);
  for (let f = 0; f < out.indices.length / 3; f++) {
    expect(faceNormalY(out, f)).toBeGreaterThan(0);
  }
});

test('A UV SEAM STAYS SHUT: the two copies of a seam vertex are never moved', () => {
  /*
   * Two grids side by side sharing the line x = 1, as two uv islands: the right one's vertices on
   * that line are copies of the left one's with different uvs. Were either copy collapsed away, the
   * two sides would stop meeting.
   */
  const left = grid(8);
  const right = grid(8);
  const count = left.positions.length / 3;
  const positions = new Float32Array(count * 6);
  positions.set(left.positions, 0);
  for (let v = 0; v < count; v++) {
    positions[(count + v) * 3] = (right.positions[v * 3] as number) + 1;
    positions[(count + v) * 3 + 1] = 0;
    positions[(count + v) * 3 + 2] = right.positions[v * 3 + 2] as number;
  }
  const uvs = new Float32Array(count * 4);
  uvs.set(left.uvs as Float32Array, 0);
  for (let v = 0; v < count; v++) {
    uvs[(count + v) * 2] = 5 + ((right.uvs as Float32Array)[v * 2] as number);
    uvs[(count + v) * 2 + 1] = (right.uvs as Float32Array)[v * 2 + 1] as number;
  }
  const indices = new Uint32Array(left.indices.length * 2);
  indices.set(left.indices, 0);
  for (let i = 0; i < right.indices.length; i++) {
    indices[left.indices.length + i] = (right.indices[i] as number) + count;
  }
  const seamed: MeshData = {
    positions,
    normals: new Float32Array(count * 6).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)),
    colors: new Float32Array(count * 6).fill(1),
    emissive: new Float32Array(count * 2),
    uvs,
    indices,
  };
  const out = simplifyMesh(seamed, { maxError: 1e-4 });
  /* Nine vertices on the seam, each twice: all eighteen stay. */
  let onSeam = 0;
  for (let v = 0; v < out.positions.length / 3; v++) {
    if (Math.abs((out.positions[v * 3] as number) - 1) < 1e-9) onSeam++;
  }
  expect(onSeam).toBe(18);
  expect(out.indices.length).toBeLessThan(seamed.indices.length);
});

test('a skinned or morphed mesh comes back as it went in', () => {
  const skinned: MeshData = {
    ...grid(4),
    joints: new Float32Array(25 * 4),
    weights: new Float32Array(25 * 4).fill(0.25),
  };
  expect(simplifyMesh(skinned, { maxError: 1 })).toBe(skinned);
});

test('the same mesh simplifies the same way every time', () => {
  const bowl = grid(12, (x, z) => 0.3 * Math.sin(x * 3) * Math.cos(z * 2));
  const a = simplifyMesh(bowl, { maxError: 0.005 });
  const b = simplifyMesh(bowl, { maxError: 0.005 });
  expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
});

test('A TEXTURE STAYS WHERE IT WAS PAINTED: a flat surface with a curved uv mapping keeps it', () => {
  /*
   * Flat, so the shape alone would collapse it to two triangles; but its uvs run u = x + 0.1 sin 12x,
   * a mapping no single triangle can carry. What is kept has to carry it: at the middle of every
   * triangle left, the uv the triangle interpolates is within 0.02 of the uv painted there.
   */
  const source = grid(32);
  const uvs = source.uvs as Float32Array;
  const painted = (x: number): number => x + 0.1 * Math.sin(12 * x);
  for (let v = 0; v < uvs.length / 2; v++) uvs[v * 2] = painted(source.positions[v * 3] as number);
  const out = simplifyMesh(source, { maxError: 1e-4 });
  expect(out.indices.length).toBeLessThan(source.indices.length);
  const outUvs = out.uvs as Float32Array;
  for (let f = 0; f < out.indices.length / 3; f++) {
    let x = 0;
    let u = 0;
    for (let k = 0; k < 3; k++) {
      const vert = out.indices[f * 3 + k] as number;
      x += (out.positions[vert * 3] as number) / 3;
      u += (outUvs[vert * 2] as number) / 3;
    }
    expect(Math.abs(u - painted(x))).toBeLessThan(0.02);
  }
});

test('A CLOSED SURFACE STAYS CLOSED: every edge left is shared by exactly two faces', () => {
  /*
   * An octahedron, with an error bound loose enough to take anything: what stops it becoming a fin
   * or a pair of faces back to back is the link condition, and what is left must still enclose.
   */
  const positions = new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
  const indices = new Uint32Array([
    0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5,
  ]);
  const octahedron: MeshData = {
    positions,
    normals: positions.slice(),
    colors: new Float32Array(18).fill(1),
    emissive: new Float32Array(6),
    indices,
  };
  const out = simplifyMesh(octahedron, { maxError: 10, maxUvError: 1 });
  const edges = new Map<string, number>();
  for (let f = 0; f < out.indices.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const a = out.indices[f * 3 + k] as number;
      const b = out.indices[f * 3 + ((k + 1) % 3)] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  expect(out.indices.length / 3).toBeGreaterThanOrEqual(4);
  for (const count of edges.values()) expect(count).toBe(2);
});

test('A COLLAPSE THAT WOULD FOLD A FACE UNDER IS REFUSED, even where it costs nothing', () => {
  /*
   * One vertex at the centre of a flat fan whose rim has a dent: the rim vertex at (0.15, 0.15)
   * points in. Moving the centre onto the first neighbour it meets, (1, 0), costs nothing, the
   * surface being flat, and would lay the face (1, 0)–(0.15, 0.15)–(0, 1) upside down; onto the dent
   * it folds nothing. No uvs and one normal, so only the fold check can tell the two apart.
   */
  const rim = [
    [0, -1],
    [1, 0],
    [0.15, 0.15],
    [0, 1],
    [-1, 0],
  ];
  const positions = new Float32Array([0, 0, 0, ...rim.flatMap(([x, z]) => [x, 0, z])]);
  const indices: number[] = [];
  for (let k = 0; k < rim.length; k++) indices.push(0, 1 + ((k + 1) % rim.length), 1 + k);
  const fan: MeshData = {
    positions,
    normals: new Float32Array(18).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)),
    colors: new Float32Array(18).fill(1),
    emissive: new Float32Array(6),
    indices: new Uint32Array(indices),
  };
  for (let f = 0; f < fan.indices.length / 3; f++) expect(faceNormalY(fan, f)).toBeGreaterThan(0);
  const out = simplifyMesh(fan, { maxError: 1e-3 });
  expect(out.indices.length).toBeLessThan(fan.indices.length);
  for (let f = 0; f < out.indices.length / 3; f++) expect(faceNormalY(out, f)).toBeGreaterThan(0);
});
