import { describe, expect, it } from 'vitest';

import type { SurfaceTextureHandle } from './backend/api.ts';
import { OVERLAY_FLOATS, overlayLays, packSurfaceOverlay } from './surfaceOverlay.ts';

/** An atlas, which the packing reads only for being there. */
const maps: SurfaceTextureHandle = {};

/*
 * **The layout is a contract with `shaders/flat/overlay.ts`**, which reads each lane by its index,
 * so the expectations below are the indices written out by hand from the layout `packSurfaceOverlay`
 * documents — not read back through it.
 */
describe('A SURFACE OVERLAY PACKS INTO THE LANES THE SHADER READS', () => {
  it('PACKS A RIM: COLOUR, STRENGTH, THE THREE EXPONENTS, NOISE, PULSE AND MASK', () => {
    const out = new Float32Array(OVERLAY_FLOATS);
    packSurfaceOverlay(
      {
        maps,
        rim: {
          colour: [1, 0.5, 0.25],
          intensity: 4,
          alpha: 0.5,
          falloff: 1.5,
          upward: 0.4,
          contrast: 2,
          noise: {
            region: { scale: [0.5, 0.25], offset: [0, 0.75] },
            scroll: [0, 0.2],
            tiling: 3,
          },
          pulse: { rate: 1.257, low: 0.6, high: 1 },
          mask: { region: { scale: [0.5, 0.5], offset: [0.5, 0] }, weight: 0.8 },
        },
      },
      out,
    );
    /* Vector 0: colour, and strength = intensity 4 times alpha 0.5. */
    expect(Array.from(out.slice(0, 4))).toEqual([1, 0.5, 0.25, 2]);
    /* Vector 1: falloff, upward, contrast, mask weight. */
    expect(Array.from(out.slice(4, 8))).toEqual([1.5, 0.4, 2, 0.8].map(Math.fround));
    /* Vector 2: the noise's region; 3: scroll x, y, tiling, pulse rate; 4: low, high. */
    expect(Array.from(out.slice(8, 12))).toEqual([0.5, 0.25, 0, 0.75]);
    expect(Array.from(out.slice(12, 16))).toEqual([0, 0.2, 3, 1.257].map(Math.fround));
    expect(Array.from(out.slice(16, 18))).toEqual([0.6, 1].map(Math.fround));
    /* Vector 5: the mask's region. */
    expect(Array.from(out.slice(20, 24))).toEqual([0.5, 0.5, 0.5, 0]);
    /* Nothing else is laid: no dissolve region, no wrinkle region. */
    expect(out[24]).toBe(0);
    expect(out[40]).toBe(0);
  });

  /*
   * **A rim may blend the base colour instead of adding light.** Then vector 0 is the colour the
   * surface is pulled toward, its intensity folded in and each channel held at 1 as a base colour
   * is, and the weight the edge is taken times — the alpha alone — and the mode sits in vector 4's
   * third lane, which an added rim leaves at 0. A colour of 8 red at alpha 1.5 is the case: it pulls
   * toward a red of 1, by up to one and a half times the edge.
   */
  it('PACKS A BLENDING RIM AS THE COLOUR IT PULLS TOWARD, HELD AT ONE, THE ALPHA AND ITS MODE', () => {
    const out = new Float32Array(OVERLAY_FLOATS);
    packSurfaceOverlay(
      { rim: { colour: [8, 0.2, 0.1], intensity: 1, alpha: 1.5, mode: 'blend', contrast: 2 } },
      out,
    );
    expect(Array.from(out.slice(0, 4))).toEqual([1, 0.2, 0.1, 1.5].map(Math.fround));
    expect(out[6], 'the contrast, as for an added rim').toBe(2);
    expect(out[18], 'blend').toBe(1);
    const added = new Float32Array(OVERLAY_FLOATS);
    packSurfaceOverlay({ rim: { colour: [8, 0.2, 0.1], intensity: 1, alpha: 1.5 } }, added);
    expect(Array.from(added.slice(0, 4)), 'an added rim keeps its light').toEqual(
      [8, 0.2, 0.1, 1.5].map(Math.fround),
    );
    expect(added[18], 'add').toBe(0);
  });

  it('HOLDS A RIM WITHOUT A PULSE AT ONE, AND A RIM WITHOUT A MASK UNMASKED', () => {
    const out = new Float32Array(OVERLAY_FLOATS);
    packSurfaceOverlay({ rim: { colour: [1, 1, 1], intensity: 1 } }, out);
    /* mix(1, 1, anything) is 1: the shader's pulse is exactly nothing. */
    expect(out[16]).toBe(1);
    expect(out[17]).toBe(1);
    expect(out[7], 'mask weight').toBe(0);
    /* The defaults the type documents: falloff 1.5, upward 0.4, contrast 1, tiling 1. */
    expect(out[4]).toBe(Math.fround(1.5));
    expect(out[5]).toBe(Math.fround(0.4));
    expect(out[6]).toBe(1);
    expect(out[14]).toBe(1);
  });

  it('PACKS A DISSOLVE: REGION, TILING, THRESHOLD, EDGE AND BOTH COLOURS', () => {
    const out = new Float32Array(OVERLAY_FLOATS);
    packSurfaceOverlay(
      {
        maps,
        dissolve: {
          noise: { region: { scale: [0.25, 0.25], offset: [0.75, 0.75] }, tiling: [2, 4] },
          threshold: 0.3,
          edge: 0.1,
          edgeColour: [1, 0.2, 0],
          edgeIntensity: 6,
          overlay: { colour: [0, 0.5, 1], amount: 0.25 },
        },
      },
      out,
    );
    expect(Array.from(out.slice(24, 28))).toEqual([0.25, 0.25, 0.75, 0.75]);
    expect(Array.from(out.slice(28, 32))).toEqual([2, 4, 0.3, 0.1].map(Math.fround));
    expect(Array.from(out.slice(32, 36))).toEqual([1, 0.2, 0, 6].map(Math.fround));
    expect(Array.from(out.slice(36, 40))).toEqual([0, 0.5, 1, 0.25]);
    /* No rim: a strength of zero is what the shader's rim branch tests. */
    expect(out[3]).toBe(0);
  });

  it('CLAMPS A THRESHOLD, AN EDGE AND THE WEIGHTS INTO WHAT THE SHADER CAN DIVIDE BY', () => {
    const out = new Float32Array(OVERLAY_FLOATS);
    const region = { scale: [1, 1], offset: [0, 0] } as const;
    packSurfaceOverlay(
      {
        maps,
        dissolve: { noise: { region }, threshold: 2, edge: 0 },
        wrinkle: {
          normal: region,
          masks: [region, region],
          weights: [1.5, -1, 0.5, Number.NaN, 0.25, 1],
        },
      },
      out,
    );
    expect(out[30], 'threshold held at 1').toBe(1);
    /* The edge divides the band, so zero is held at the smallest width rather than passed on. */
    expect(out[31]).toBe(Math.fround(1e-4));
    /* Vectors 13 and 14: the six weights, each held in 0 to 1, and a NaN taken as none. */
    expect(Array.from(out.slice(52, 58))).toEqual([1, 0, 0.5, 0, 0.25, 1]);
  });

  /*
   * **Without the atlas, a region names nothing**: the slot then holds a stand-in, and a region read
   * there is a noise of the stand-in's colour — which cut a whole dissolving panel away and erased a
   * whole rim under its mask, on the device check's first run. So every region packs as none.
   */
  it('READS NO IMAGE WHERE THE OVERLAY HAS NO ATLAS, whatever regions it names', () => {
    const out = new Float32Array(OVERLAY_FLOATS);
    const region = { scale: [0.5, 0.5], offset: [0, 0] } as const;
    packSurfaceOverlay(
      {
        rim: {
          colour: [1, 1, 1],
          intensity: 1,
          noise: { region },
          mask: { region, weight: 1 },
        },
        dissolve: { noise: { region }, threshold: 0.5 },
        wrinkle: { normal: region, masks: [region, region], weights: [1, 1, 1, 1, 1, 1] },
      },
      out,
    );
    for (const at of [8, 20, 24, 40, 44, 48]) expect(out[at], `region at ${at}`).toBe(0);
    /* And the rim itself is still laid, smooth. */
    expect(out[3]).toBe(1);
  });

  it('IS ALL ZEROS FOR NO OVERLAY, AND SAYS WHEN ONE LAYS NOTHING', () => {
    const out = new Float32Array(OVERLAY_FLOATS).fill(7);
    packSurfaceOverlay(null, out);
    expect(out.every((value) => value === 0)).toBe(true);
    expect(overlayLays(null)).toBe(false);
    expect(overlayLays({})).toBe(false);
    expect(overlayLays({ rim: { colour: [1, 1, 1], intensity: 1 } })).toBe(true);
  });
});
