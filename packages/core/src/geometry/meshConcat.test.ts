import { expect, test } from 'vitest';
import { concatMeshes, placeMesh } from './meshConcat.ts';
import type { MeshData } from '../render/mesh.ts';

/**
 * Meshes moved and joined as typed arrays. The expected values are written out by hand: a
 * triangle at known corners, moved by a known fit, and two joined with known attributes.
 */

function triangle(x: number, withTangents: boolean): MeshData {
  return {
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.5),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
    ...(withTangents
      ? {
          tangents: new Float32Array([1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1]),
          uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        }
      : {}),
  };
}

test('A MESH PLACED AT THE IDENTITY IS THE SAME MESH, and a fit moves its positions alone', () => {
  const mesh = triangle(0, true);
  expect(placeMesh(mesh, 0, 0, 0, 1)).toBe(mesh);
  const moved = placeMesh(mesh, 10, 20, 30, 2);
  expect([...moved.positions]).toEqual([10, 20, 30, 12, 20, 30, 10, 22, 30]);
  expect(moved.normals).toBe(mesh.normals);
  expect(moved.tangents, 'every other attribute is carried, the frame included').toBe(
    mesh.tangents,
  );
  expect([...mesh.positions], 'and the source is untouched').toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test('JOINED MESHES KEEP EVERY ATTRIBUTE A MEMBER CARRIES, TANGENTS INCLUDED', () => {
  const joined = concatMeshes([triangle(0, true), triangle(5, false)]);
  expect(joined.positions.length).toBe(18);
  expect([...joined.indices], "the second member's indices follow the first's vertices").toEqual([
    0, 1, 2, 3, 4, 5,
  ]);
  expect(joined.positions[9]).toBe(5);
  /* The first member's own frame, then the default a mesh with none draws with: (1, 0, 0, 1). */
  expect([...(joined.tangents ?? [])]).toEqual([
    1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1,
  ]);
  expect([...(joined.uvs ?? [])]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  /* An attribute no member carries is not invented. */
  expect(joined.specular).toBeUndefined();
  expect(joined.roughness).toBeUndefined();
});

test('one mesh joined is that mesh', () => {
  const mesh = triangle(0, false);
  expect(concatMeshes([mesh])).toBe(mesh);
});

test('JOINED MESHES KEEP THEIR TEXTURE-ARRAY LAYERS, and a member without them wears layer 0', () => {
  const a = { ...triangle(0, true), layers: new Float32Array([3, 3, 3]) };
  const joined = concatMeshes([a, triangle(5, true)]);
  expect([...(joined.layers ?? [])]).toEqual([3, 3, 3, 0, 0, 0]);
});
