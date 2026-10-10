import { expect, it } from 'vitest';

import { fixedArray, sharedValue, vertexPackingOf } from './vertexPacking.ts';

const triangle = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array([1, 0.5, 0.25, 1, 0.5, 0.25, 1, 0.5, 0.25]),
  emissive: new Float32Array([0, 0, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

/*
 * **Fixed point only inside its range, a constant only where every vertex agrees, floats for the
 * rest.** Each value below sits just past an edge the decision has to respect: a colour one part
 * in a thousand over white, a normal not of unit length. Texture coordinates are never packed,
 * even inside [0, 1], where this mesh's are: see `vertexPacking.ts`.
 */
it('PACKS AN ATTRIBUTE ONLY WHERE IT READS BACK AS IT WENT', () => {
  expect(vertexPackingOf(triangle, false)).toEqual({
    normals: 'snorm16',
    tangents: 'float',
    colors: 'constant',
    emissive: 'constant',
    weights: 'float',
    weights2: 'float',
  });
  expect(sharedValue(triangle.colors, 3)).toEqual([1, 0.5, 0.25]);

  const varied = {
    ...triangle,
    normals: new Float32Array([0, 0, 1.001, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 0.5, 0.25, 0, 0, 0, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 2]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    tangents: new Float32Array([1, 0, 0, -1, 1, 0, 0, 1, 1, 0, 0, 1]),
    joints: new Float32Array(12),
    weights: new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0]),
  };
  expect(vertexPackingOf(varied, false)).toEqual({
    normals: 'float',
    tangents: 'snorm16',
    colors: 'unorm16',
    emissive: 'float',
    weights: 'unorm16',
    weights2: 'float',
  });

  const bright = { ...varied, colors: new Float32Array([1.001, 0, 0, 0, 0, 0, 1, 1, 1]) };
  expect(vertexPackingOf(bright, false).colors).toBe('float');
  /* A rewritten normal would have to be packed on the CPU every frame. */
  expect(vertexPackingOf(triangle, true).normals).toBe('float');
  const empty = { ...triangle, colors: new Float32Array(0), emissive: new Float32Array(0) };
  expect(vertexPackingOf(empty, false).colors, 'a mesh of no vertices shares nothing').not.toBe(
    'constant',
  );
});

/*
 * **Rounded to nearest, both fixed points, by both backends' one function.** 0.5 is 16,383.5 of
 * 32,767 and 32,767.5 of 65,535, where a truncation would answer one less; -1, 0 and 1 are exact.
 */
it('STORES A VALUE AS THE NEAREST STEP OF ITS FIXED POINT', () => {
  expect(Array.from(fixedArray(new Float32Array([-1, 0, 0.5, 1]), 'snorm16'))).toEqual([
    -32767, 0, 16384, 32767,
  ]);
  expect(Array.from(fixedArray(new Float32Array([0, 0.5, 1]), 'unorm16'))).toEqual([
    0, 32768, 65535,
  ]);
});
