import { expect, it } from 'vitest';

import {
  LAYER_FLOATS,
  layerMaskMap,
  layeredProjection,
  layersFitBeside,
  packSurfaceLayers,
} from './surfaceLayers.ts';

/*
 * **The four vectors are a contract with `shaders/flat/layered.ts`**: the five repeats, base first,
 * then the count, the glowing layer and where the mask comes from; the blend, the mesh normal, the
 * added mask's layer and repeat; its intensity and the facing layer's three numbers. Written out by
 * hand.
 */
it('PACKS EACH LAYER’S REPEAT, THEN HOW MANY, WHICH ONE GLOWS AND WHERE THE MASK COMES FROM', () => {
  const out = new Float32Array(LAYER_FLOATS).fill(9);
  packSurfaceLayers({ mask: 'm', repeats: [40, 3, 12], emissiveLayer: 1 }, out);
  expect(Array.from(out)).toEqual([40, 3, 12, 1, 1, 3, 1, 0, 0, 0, -1, 0, 0, -1, 0, 0]);
  packSurfaceLayers(null, out);
  expect(Array.from(out)).toEqual(new Array(LAYER_FLOATS).fill(0));
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

/*
 * **Everything a layered family needs beyond laying over**: the mask from the ORM array or the
 * vertex colour, a weighted sum, a normal at the mesh's coordinates, a placed mask added to a layer
 * and a layer laid by facing up — each in its own float, so the shader reads one name for each.
 */
it('PACKS THE MASK’S SOURCE, THE SUM, THE MESH NORMAL, THE ADDED MASK AND THE FACING LAYER', () => {
  const out = new Float32Array(LAYER_FLOATS);
  packSurfaceLayers(
    {
      mask: 'orm',
      repeats: [1, 2, 3, 4],
      blend: 'sum',
      meshNormal: true,
      addMask: { layer: 2, repeat: 0.5, intensity: 2 },
      facing: { layer: 3, bias: -0.25, sharpness: 1.5 },
    },
    out,
  );
  expect(Array.from(out)).toEqual([1, 2, 3, 4, 1, 4, -1, 1, 1, 1, 2, 0.5, 2, 3, -0.25, 1.5]);
  packSurfaceLayers({ mask: 'vertex', repeats: [1, 2] }, out);
  expect(out[7], 'the vertex colour').toBe(2);
});

/*
 * **Only a layer a channel lays can be added to or faced**: the base has no channel, and a layer past
 * the count is not there, so either is none (−1) and its numbers are zero rather than half-applied.
 */
it('HOLDS AN ADDED MASK AND A FACING LAYER TO A LAYER A CHANNEL LAYS', () => {
  const out = new Float32Array(LAYER_FLOATS);
  packSurfaceLayers(
    {
      mask: 'vertex',
      repeats: [1, 2, 3],
      addMask: { layer: 0, repeat: 2, intensity: 1 },
      facing: { layer: 3, bias: 1, sharpness: 1 },
    },
    out,
  );
  expect(Array.from(out.subarray(10, 16))).toEqual([-1, 0, 0, -1, 0, 0]);
  packSurfaceLayers(
    { mask: 'vertex', repeats: [1, 2], addMask: { layer: 1, repeat: -1, intensity: Number.NaN } },
    out,
  );
  expect(Array.from(out.subarray(10, 13)), 'a repeat that collapses is 1, no intensity 0').toEqual([
    1, 1, 0,
  ]);
});

/*
 * **A mask that is a map takes the model's slot, and nothing else does.** So a lightmapped material,
 * whose page is its model map, keeps its layers where its mask is in its ORM array or its vertices,
 * and is drawn as one layer only where the mask is a map of its own.
 */
it('A MASK IN AN ARRAY OR THE VERTICES LEAVES THE MODEL MAP FREE, AND A MAP DOES NOT', () => {
  expect(layerMaskMap({ mask: 'm', repeats: [1, 2] })).toBe('m');
  expect(layerMaskMap({ mask: 'orm', repeats: [1, 2] })).toBeNull();
  expect(layerMaskMap({ mask: 'vertex', repeats: [1, 2] })).toBeNull();
  expect(layersFitBeside({ mask: 'm', repeats: [1, 2] }, 'page')).toBe(false);
  expect(layersFitBeside({ mask: 'm', repeats: [1, 2] }, null)).toBe(true);
  expect(layersFitBeside({ mask: 'orm', repeats: [1, 2] }, 'page')).toBe(true);
  expect(layersFitBeside({ mask: 'vertex', repeats: [1, 2] }, 'page')).toBe(true);
});

/* Layers are laid on the horizontal plane under any projection, at the projection's own scale. */
it('LAYS A LAYERED MATERIAL’S TRIPLANAR PROJECTION ON THE HORIZONTAL PLANE, AND LEAVES THE REST', () => {
  const layers = { mask: 'm', repeats: [1, 2] };
  expect(layeredProjection({ kind: 'triplanar', scale: 0.5, sharpness: 8 }, layers)).toEqual({
    kind: 'planar',
    scale: 0.5,
  });
  const planar = { kind: 'planar', scale: 2 } as const;
  expect(layeredProjection(planar, layers)).toBe(planar);
  const triplanar = { kind: 'triplanar', scale: 2 } as const;
  expect(layeredProjection(triplanar, null), 'one layer: as asked').toBe(triplanar);
  expect(layeredProjection(null, layers)).toBeNull();
});
