import { expect, it } from 'vitest';

import { LOOK_FLOATS, asksLayerLooks, packLayerLooks } from './surfaceLayerLooks.ts';
import type { SurfaceMeshOcclusion } from './surfaceLayerLooks.ts';

/** The identity of one layer's two vectors: white, the map's own bend, both ranges 0 to 1. */
const PLAIN_LAYER = [1, 1, 1, 1, 0, 1, 0, 1];
/** Five layers' worth of them. */
const PLAIN_LAYERS = [
  ...PLAIN_LAYER,
  ...PLAIN_LAYER,
  ...PLAIN_LAYER,
  ...PLAIN_LAYER,
  ...PLAIN_LAYER,
];

/*
 * **A LAYERED MATERIAL THAT ASKS FOR NONE OF THIS DRAWS EXACTLY AS IT DID**, because once one
 * material switches `LAYER_LOOKS` on every layered material is drawn through it: layer `i` reads
 * layer `i`, the maps beyond the layers start at the count, nothing is occluded, every look is the
 * identity, every specular is the surface's own (-1), and every repeat down is the repeat across.
 * Written out by hand.
 */
it('PACKS THE IDENTITY FOR A LAYERED MATERIAL THAT ASKS FOR NO PICKS AND NO LOOKS', () => {
  const out = new Float32Array(LOOK_FLOATS).fill(9);
  packLayerLooks({ mask: 'orm', repeats: [40, 3, 12] }, out);
  expect(Array.from(out)).toEqual([
    ...[0, 1, 2, 3, 4, 3, 0, 0],
    ...PLAIN_LAYERS,
    ...[-1, -1, -1, -1, -1],
    ...[40, 3, 12, 1, 1],
    ...[0, 1],
  ]);
});

/*
 * **Layers picked from shared arrays, each with its own look**: the picks base first, the extras'
 * start, the occlusion's strength on the colour and on the ambient light, then each layer's tint and normal strength and its
 * two ranges, then each layer's specular, its repeat down, and the occlusion's range. A layer given
 * no look keeps the identity; a repeat given as a pair keeps its second number down.
 */
it('PACKS EACH PICK, THE EXTRAS, THE OCCLUSION, EACH LOOK, EACH SPECULAR AND EACH REPEAT DOWN', () => {
  const out = new Float32Array(LOOK_FLOATS);
  packLayerLooks(
    {
      mask: 'orm',
      repeats: [8, [4, 0.5], 2],
      arrayLayers: [12, 3, 30],
      extrasAt: 40,
      meshOcclusion: { strength: 0.75, into: 'ambient', range: [0.2, 0.9] },
      looks: [
        { tint: [2.5, 2.46, 1.33], normalStrength: 7, specular: 0.1 },
        null,
        { roughness: [0.2, 0.9], metalness: [0, 0.5] },
      ],
    },
    out,
  );
  expect(Array.from(out.subarray(0, 8))).toEqual([12, 3, 30, 3, 4, 40, 0, 0.75]);
  expect(Array.from(out.subarray(8, 16))).toEqual(
    [2.5, 2.46, 1.33, 7, 0, 1, 0, 1].map(Math.fround),
  );
  expect(Array.from(out.subarray(16, 24)), 'a layer with no look').toEqual(PLAIN_LAYER);
  expect(Array.from(out.subarray(24, 32))).toEqual([1, 1, 1, 1, 0.2, 0.9, 0, 0.5].map(Math.fround));
  expect(Array.from(out.subarray(48, 53)), 'specular: the base names one').toEqual(
    [0.1, -1, -1, -1, -1].map(Math.fround),
  );
  expect(Array.from(out.subarray(53, 58)), 'down: the pair keeps its own').toEqual([
    8, 0.5, 2, 1, 1,
  ]);
  expect(Array.from(out.subarray(58, 60))).toEqual([0.2, 0.9].map(Math.fround));
});

/* The number form of the occlusion is a strength darkening the colour, its range 0 to 1. */
it('READS A NUMBER OCCLUSION AS A STRENGTH ON THE COLOUR, AND AN OBJECT AS STRENGTH 1 UNLESS IT SAYS', () => {
  const out = new Float32Array(LOOK_FLOATS);
  packLayerLooks({ mask: 'orm', repeats: [1], meshOcclusion: 0.5 }, out);
  expect([out[6], out[7], out[58], out[59]]).toEqual([0.5, 0, 0, 1]);
  packLayerLooks({ mask: 'orm', repeats: [1], meshOcclusion: { into: 'ambient' } }, out);
  expect([out[6], out[7]]).toEqual([0, 1]);
});

/*
 * **ONE OCCLUSION INTO THE AMBIENT LIGHT AND THE COLOUR AT ONCE, EACH AT ITS OWN STRENGTH**, the
 * colour's past 1: a material that takes its ambient occlusion from a map and darkens its colour by
 * the same map twice as hard. The colour's own strength stands wherever it is named, `into` the
 * colour too; absent, it is the strength where the colour is the target and 0 where the ambient
 * light is. Not a number, or below 0, is none.
 */
it('PACKS AN OCCLUSION INTO THE AMBIENT LIGHT AND THE COLOUR, THE COLOUR PAST 1', () => {
  const out = new Float32Array(LOOK_FLOATS);
  const occluded = (meshOcclusion: SurfaceMeshOcclusion): number[] => {
    packLayerLooks({ mask: 'orm', repeats: [1], meshOcclusion }, out);
    return [out[6] as number, out[7] as number];
  };
  expect(occluded({ strength: 0.5, into: 'ambient', colorStrength: 2 })).toEqual([2, 0.5]);
  expect(occluded({ colorStrength: 1.75 }), 'named on the colour, it is the colour').toEqual([
    1.75, 0,
  ]);
  expect(occluded({ strength: 0.25, colorStrength: 0 })).toEqual([0, 0]);
  expect(occluded({ into: 'ambient', colorStrength: -1 })).toEqual([0, 1]);
  expect(occluded({ into: 'ambient', colorStrength: Number.NaN })).toEqual([0, 1]);
  expect(
    asksLayerLooks({ mask: 'orm', repeats: [1], meshOcclusion: { strength: 0, colorStrength: 2 } }),
  ).toBe(true);
  expect(
    asksLayerLooks({
      mask: 'orm',
      repeats: [1],
      meshOcclusion: { strength: 0, into: 'ambient', colorStrength: 0 },
    }),
  ).toBe(false);
});

/*
 * **Nothing it is handed can make a layer read nowhere or a colour go negative**: a pick that is
 * not a whole number at or above zero reads layer `i`, a start that is not one is the count, an
 * occlusion is held to 0..1, a tint or strength below zero or not a number is 1, a specular that is
 * not a number at or above zero is the surface's own, and a repeat down that is not positive is the
 * repeat across.
 */
it('HOLDS EVERY PICK TO A LAYER THERE CAN BE AND EVERY LOOK TO ONE THAT DRAWS', () => {
  const out = new Float32Array(LOOK_FLOATS);
  packLayerLooks(
    {
      mask: 'vertex',
      repeats: [3, [2, -1]],
      arrayLayers: [-1, 2.5],
      extrasAt: Number.NaN,
      meshOcclusion: 3,
      looks: [
        {
          tint: [-1, Number.NaN, 0.5],
          normalStrength: -2,
          roughness: [Number.NaN, 0.5],
          specular: -0.5,
        },
      ],
    },
    out,
  );
  expect(Array.from(out.subarray(0, 7))).toEqual([0, 1, 2, 3, 4, 2, 1]);
  expect(Array.from(out.subarray(8, 16))).toEqual([1, 1, 0.5, 1, 0, 0.5, 0, 1]);
  expect(out[48], 'no negative specular').toBe(-1);
  expect(Array.from(out.subarray(53, 55)), 'down falls back to across').toEqual([3, 2]);
});

/* The switch is asked for by a material that names any of these, and by no other. */
it('ASKS FOR THE SWITCH ONLY WHERE A MATERIAL NAMES A PICK, A START, A LOOK, A PAIR OR AN OCCLUSION', () => {
  expect(asksLayerLooks(null)).toBe(false);
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, 2] })).toBe(false);
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, 2], meshOcclusion: 0 })).toBe(false);
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, 2], meshOcclusion: { strength: 0 } })).toBe(
    false,
  );
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, 2], meshOcclusion: 0.5 })).toBe(true);
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, 2], meshOcclusion: {} })).toBe(true);
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, [2, 1]] })).toBe(true);
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, 2], arrayLayers: [0, 1] })).toBe(true);
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, 2], extrasAt: 7 })).toBe(true);
  expect(asksLayerLooks({ mask: 'orm', repeats: [1, 2], looks: [] })).toBe(true);
});
