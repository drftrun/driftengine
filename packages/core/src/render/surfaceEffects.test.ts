import { expect, test } from 'vitest';
import { SURFACE_EFFECT_TEXELS, packSurfaceEffects } from './surfaceEffects.ts';

/**
 * The table the lit shader reads a layer's effects from, six RGBA texels a layer. The shader names
 * each value by its place, so the place is the contract: a field written one slot over is an
 * effect reading another's number, which draws a picture rather than failing.
 */
test("A LAYER'S EFFECTS LAND WHERE THE SHADER READS THEM, and a layer with none is all zeros", () => {
  const table = packSurfaceEffects([
    undefined,
    {
      windows: { cells: [4, 6], glass: true, seed: 7, glow: 2.5, colour: [0.9, 0.8, 0.5] },
      interior: { roomLayer: 3, depth: 0.75, lit: 0.5 },
      wear: { dust: 0.25, grime: 0.5, streaks: 0.125, fade: 80 },
      animation: {
        scroll: [0.5, -1],
        pulse: [2, 0.75],
        flicker: 0.25,
        flipbook: [8, 12],
        fade: 300,
      },
      dry: true,
    },
  ]);
  expect(SURFACE_EFFECT_TEXELS).toBe(6);
  expect(table.length).toBe(2 * 6 * 4);
  expect(Array.from(table.subarray(0, 24)).every((v) => v === 0)).toBe(true);
  expect(Array.from(table.subarray(24, 48))).toEqual([
    /* 0 */ 4, 6, 1, 7, /* 1: the room layer plus one, so 0 can mean none */ 4, 0.75, 0.5, 2.5,
    /* 2 */ 0.8999999761581421, 0.800000011920929, 0.5, 1, /* 3 */ 0.25, 0.5, 0.125, 80,
    /* 4 */ 0.5, -1, 2, 0.75, /* 5 */ 0.25, 8, 12, 300,
  ]);
});
