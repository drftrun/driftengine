import { expect, it } from 'vitest';

import { LAYER_FLOATS, packSurfaceLayers } from './surfaceLayers.ts';

/*
 * **The two vectors are a contract with `shaders/flat/layered.ts`**: the five repeats, base first,
 * then the count and the glowing layer. Written out by hand.
 */
it('PACKS EACH LAYER’S REPEAT, THEN HOW MANY AND WHICH ONE GLOWS', () => {
  const out = new Float32Array(LAYER_FLOATS).fill(9);
  packSurfaceLayers({ mask: 'm', repeats: [40, 3, 12], emissiveLayer: 1 }, out);
  expect(Array.from(out)).toEqual([40, 3, 12, 1, 1, 3, 1, 0]);
  packSurfaceLayers(null, out);
  expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
});

/* A layer is never laid at a scale that collapses it, and a glow names a layer that exists or none. */
it('HOLDS A REPEAT TO A POSITIVE NUMBER AND A GLOW TO A LAYER THERE IS', () => {
  const out = new Float32Array(LAYER_FLOATS);
  packSurfaceLayers({ mask: 'm', repeats: [0, -2, Number.NaN, 2, 3, 4], emissiveLayer: 3 }, out);
  expect(Array.from(out.subarray(0, 5))).toEqual([1, 1, 1, 2, 3]);
  expect(out[5], 'five at most').toBe(5);
  expect(out[6]).toBe(3);
  packSurfaceLayers({ mask: 'm', repeats: [2, 2], emissiveLayer: 4 }, out);
  expect(out[6], 'no layer 4 among two').toBe(-1);
});
