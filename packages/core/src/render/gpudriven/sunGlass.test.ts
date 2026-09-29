import { expect, test } from 'vitest';

import type { GlassTexel } from '../glassShadow.ts';
import { glassTintAt, type SunGlassMaps } from './sunGlass.ts';

/*
 * **The second pipeline's sun through glass, on a map small enough to reason about by hand.** A
 * 16-texel map, a pane over its left half at depth 0.3, and a receiver somewhere behind or in
 * front of it. Every figure here is the forward path's rule (`glassShadow.ts`): tinted only behind
 * the pane, and frost spreading only the colour.
 */
const SIZE = 16;
const texel = (): GlassTexel => ({ r: 0, g: 0, b: 0, clarity: 0 });

function maps(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number] = left,
): SunGlassMaps {
  const glassDepth = new Float32Array(SIZE * SIZE).fill(1);
  const tint = new Float32Array(SIZE * SIZE * 4).fill(1);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE / 2; x++) {
      glassDepth[y * SIZE + x] = 0.3;
      tint.set(x < SIZE / 4 ? left : right, (y * SIZE + x) * 4);
    }
  }
  return { size: SIZE, glassDepth, tint };
}

const SETTINGS = { depthSpan: 10, uvPerMetre: 0.05, taps: 12 };

test('BEHIND A CLEAR PANE THE SUN TAKES ITS COLOUR, and in front of it keeps its own', () => {
  const clear = maps([0.5, 0.25, 1, 1]);
  const behind = glassTintAt(0.2, 0.5, 0.6, clear, SETTINGS, texel());
  expect([behind.r, behind.g, behind.b].map((v) => Number(v.toFixed(6)))).toEqual([0.5, 0.25, 1]);
  const inFront = glassTintAt(0.2, 0.5, 0.2, clear, SETTINGS, texel());
  expect([inFront.r, inFront.g, inFront.b]).toEqual([1, 1, 1]);
  const open = glassTintAt(0.8, 0.5, 0.6, clear, SETTINGS, texel());
  expect([open.r, open.g, open.b], 'no pane on the ray').toEqual([1, 1, 1]);
});

test('FROST MIXES THE COLOURS OF THE PANES IT SPREADS OVER, and keeps the outline', () => {
  /* Two frosted panes side by side, red-ish and blue-ish, and a receiver where they meet. */
  const frosted = maps([0.9, 0.2, 0.2, 0.2], [0.2, 0.2, 0.9, 0.2]);
  const mixed = glassTintAt(0.25, 0.5, 0.9, frosted, SETTINGS, texel());
  expect(mixed.r, 'between the two').toBeGreaterThan(0.3);
  expect(mixed.r).toBeLessThan(0.8);
  expect(mixed.b).toBeGreaterThan(0.3);
  expect(mixed.b).toBeLessThan(0.8);
  expect(mixed.g, 'a colour both share').toBeCloseTo(0.2, 6);
  /* The same frost with nothing behind to spread over: still the pane's own colour, unmixed. */
  const single = glassTintAt(0.1, 0.5, 0.9, maps([0.9, 0.2, 0.2, 0.2]), SETTINGS, texel());
  expect(single.r).toBeCloseTo(0.9, 6);
});
