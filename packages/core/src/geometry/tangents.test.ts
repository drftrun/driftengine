import { expect, test } from 'vitest';

import { generateTangents } from './tangents.ts';

/** A quad in the XY plane, u running with x and v with y, normal +Z. */
const QUAD = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

test('a quad whose u runs along +x gets a +x tangent', () => {
  const t = generateTangents(QUAD.positions, QUAD.normals, QUAD.uvs, QUAD.indices);
  expect(t.length, 'four floats a vertex').toBe(16);
  expect(t[0]).toBeCloseTo(1, 5);
  expect(t[1]).toBeCloseTo(0, 5);
  expect(t[2]).toBeCloseTo(0, 5);
});

test('a quad whose u runs along +y gets a +y tangent', () => {
  /* u with y and v with x: v0 (0,0)→(0,0), v1 (1,0,0)→(0,1), v2 (1,1,0)→(1,1), v3 (0,1,0)→(1,0). */
  const swapped = new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]);
  const t = generateTangents(QUAD.positions, QUAD.normals, swapped, QUAD.indices);
  expect(t[0]).toBeCloseTo(0, 5);
  expect(t[1]).toBeCloseTo(1, 5);
});

/**
 * The sign, which is the whole reason this is four floats rather than three.
 *
 * Mirroring u flips the bitangent's direction. Without `w` the frame is left-handed on that side
 * and a normal map lights it inside out — which reads as a lighting bug and is a missing float.
 * Every format that has been through this, glTF included, settled on the same four.
 */
test('a mirrored uv layout gets the opposite handedness', () => {
  const mirrored = new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]);
  const normal = generateTangents(QUAD.positions, QUAD.normals, QUAD.uvs, QUAD.indices);
  const flipped = generateTangents(QUAD.positions, QUAD.normals, mirrored, QUAD.indices);
  expect(Math.abs(normal[3] ?? 0), 'and it is a sign, not a magnitude').toBeCloseTo(1, 5);
  expect(Math.sign(normal[3] ?? 0)).not.toBe(Math.sign(flipped[3] ?? 0));
});

test('a tangent is unit length', () => {
  const t = generateTangents(QUAD.positions, QUAD.normals, QUAD.uvs, QUAD.indices);
  for (let v = 0; v < 4; v += 1) {
    expect(Math.hypot(t[v * 4] ?? 0, t[v * 4 + 1] ?? 0, t[v * 4 + 2] ?? 0)).toBeCloseTo(1, 5);
  }
});

/**
 * Gram-Schmidt, which is what keeps the frame square after per-vertex averaging.
 *
 * A vertex shared by two triangles gets the sum of their tangents, and that sum is no longer
 * perpendicular to the interpolated normal. Dropping the orthogonalisation is a normal map that
 * shears wherever the geometry curves.
 */
test('a tangent is perpendicular to its normal, even where the two disagree', () => {
  /* A normal deliberately tilted away from the face, as a smoothed vertex normal would be. */
  const tilted = new Float32Array([0.6, 0, 0.8, 0.6, 0, 0.8, 0.6, 0, 0.8, 0.6, 0, 0.8]);
  const t = generateTangents(QUAD.positions, tilted, QUAD.uvs, QUAD.indices);
  for (let v = 0; v < 4; v += 1) {
    const dot = (t[v * 4] ?? 0) * 0.6 + (t[v * 4 + 1] ?? 0) * 0 + (t[v * 4 + 2] ?? 0) * 0.8;
    expect(dot, 'orthogonalised against the normal it will be interpolated with').toBeCloseTo(0, 5);
  }
});

/**
 * Degenerate UVs are the common case in a bought asset rather than an edge case.
 *
 * A triangle whose three vertices share one UV has no direction along the texture at all and the
 * arithmetic divides by zero. The answer has to be *some* unit vector perpendicular to the
 * normal, because a NaN in a vertex buffer takes the whole triangle off the screen.
 */
test('a triangle with no uv area gets a usable frame rather than a NaN', () => {
  const flat = new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  const t = generateTangents(QUAD.positions, QUAD.normals, flat, QUAD.indices);
  for (const value of t) expect(Number.isFinite(value)).toBe(true);
  for (let v = 0; v < 4; v += 1) {
    expect(Math.hypot(t[v * 4] ?? 0, t[v * 4 + 1] ?? 0, t[v * 4 + 2] ?? 0)).toBeCloseTo(1, 5);
    const dot = (t[v * 4 + 2] ?? 0) * 1;
    expect(dot, 'and it is still perpendicular to the normal').toBeCloseTo(0, 5);
  }
});

/** A vertex no triangle mentions has no frame to derive, and still must not be a NaN. */
test('an orphan vertex gets a usable frame', () => {
  const positions = new Float32Array([...QUAD.positions, 5, 5, 5]);
  const normals = new Float32Array([...QUAD.normals, 0, 1, 0]);
  const uvs = new Float32Array([...QUAD.uvs, 0, 0]);
  const t = generateTangents(positions, normals, uvs, QUAD.indices);
  const at = 4 * 4;
  expect(Number.isFinite(t[at] ?? NaN)).toBe(true);
  expect(Math.hypot(t[at] ?? 0, t[at + 1] ?? 0, t[at + 2] ?? 0)).toBeCloseTo(1, 5);
});

test('it fills the array it was given rather than making one', () => {
  const out = new Float32Array(16);
  expect(generateTangents(QUAD.positions, QUAD.normals, QUAD.uvs, QUAD.indices, out)).toBe(out);
});

test('it accepts a 16-bit index buffer', () => {
  const t = generateTangents(
    QUAD.positions,
    QUAD.normals,
    QUAD.uvs,
    new Uint16Array([0, 1, 2, 0, 2, 3]),
  );
  expect(t[0]).toBeCloseTo(1, 5);
});
