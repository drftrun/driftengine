import { expect, it } from 'vitest';

import {
  clothTextureSize,
  packClothBinding,
  packClothParticles,
  validateClothBinding,
} from './clothBindingData.ts';
import type { ClothBindingData } from './clothBindingData.ts';

const binding = (vertices: number): ClothBindingData => ({
  triangles: new Uint32Array(vertices * 3),
  coordinates: new Float32Array(vertices * 2),
  offsets: new Float32Array(vertices),
  weights: new Float32Array(vertices),
  rest: new Float32Array(9),
});

/*
 * **Two texels a vertex, in the order the vertex stage reads them**: the three indices and the
 * weight, then u, v, the offset and a zero. A vertex bound to particles (4, 5, 6) at weight 0.75,
 * barycentrics (0.25, 0.5), 0.02 along the normal, is (4, 5, 6, 0.75, 0.25, 0.5, 0.02, 0).
 */
it('PACKS A VERTEX AS THE STAGE READS IT: INDICES AND WEIGHT, THEN UV, OFFSET AND ZERO', () => {
  const data = binding(1);
  data.triangles.set([4, 5, 6]);
  data.coordinates.set([0.25, 0.5]);
  data.offsets[0] = 0.02;
  data.weights[0] = 0.75;
  const packed = packClothBinding(data);
  expect(Array.from(packed.subarray(0, 8))).toEqual([
    4,
    5,
    6,
    0.75,
    0.25,
    0.5,
    Math.fround(0.02),
    0,
  ]);
});

/* Wrapped onto rows no wider than WebGL2 guarantees, and padded to whole rows. */
it('wraps a texture onto rows of at most 2048 texels', () => {
  expect(clothTextureSize(80_000)).toEqual({ width: 2048, height: 40 });
  expect(clothTextureSize(3)).toEqual({ width: 3, height: 1 });
  expect(packClothBinding(binding(1500)).length).toBe(2048 * 2 * 4);
});

/* Particles go up as one RGBA texel each: x, y, z and a zero. */
it('packs particles one texel each', () => {
  const out = new Float32Array(8);
  packClothParticles(new Float32Array([1, 2, 3, 4, 5, 6]), out);
  expect(Array.from(out)).toEqual([1, 2, 3, 0, 4, 5, 6, 0]);
});

/*
 * **Refused by name before a byte goes to a device**: arrays that disagree with the mesh's vertex
 * count, and an index past the particles — which the vertex stage would read as whatever the
 * texture's padding holds, a vertex pinned to the origin.
 */
it('refuses a binding that disagrees with its mesh or names a particle it does not have', () => {
  expect(() => validateClothBinding(binding(4), 5)).toThrow(/4 vertices .* mesh has 5/);
  const bad = binding(2);
  bad.triangles.set([0, 1, 3, 0, 1, 2]);
  expect(() => validateClothBinding(bad, 2)).toThrow(/particle 3 of 3/);
  expect(() => validateClothBinding(binding(2), 2)).not.toThrow();
});
