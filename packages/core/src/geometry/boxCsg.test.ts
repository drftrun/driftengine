import { describe, expect, it } from 'vitest';

import { solidBoxBoolean } from './boxCsg.ts';
import type { BoxOperation } from './boxCsg.ts';
import { solidVolume } from './solid.ts';
import { normalsFaceOutward } from './solidHarness.ts';

const box = (
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  op: BoxOperation['op'] = 'union',
): BoxOperation => ({ box: [x0, y0, z0, x1, y1, z1], op });

describe('box booleans', () => {
  it('A WALL WITH WINDOWS CUT THROUGH IT IS EXACT IN VOLUME AND A HANDFUL OF FACES', () => {
    const windows = [0, 1, 2].map((i) => box(1 + 3 * i, 1, -1, 2 + 3 * i, 2, 1, 'subtract'));
    const wall = solidBoxBoolean([box(0, 0, 0, 10, 3, 0.3), ...windows]);
    /* 10 × 3 × 0.3, less three 1 × 1 openings through its 0.3: 9 − 0.9. */
    /* Positions are f32, so 0.3 carries its rounding: six places. */
    expect(solidVolume(wall)).toBeCloseTo(8.1, 6);
    expect(normalsFaceOutward(wall)).toBe(true);
    /* Two faces of a few rectangles each, twelve reveals, four ends: never hundreds. */
    expect(wall.indices.length / 3).toBeLessThanOrEqual(80);
  });

  it('merges faces across boxes that touch, so two cubes side by side are one box’s six faces', () => {
    const pair = solidBoxBoolean([box(0, 0, 0, 1, 1, 1), box(1, 0, 0, 2, 1, 1)]);
    expect(solidVolume(pair)).toBeCloseTo(2, 12);
    expect(pair.indices.length / 3).toBe(12);
  });

  it('applies the operations left to right from nothing', () => {
    /* A 2-cube, its lower half cut away, and a unit block put back inside the cut: 8 − 4 + 1. */
    const solid = solidBoxBoolean([
      box(0, 0, 0, 2, 2, 2),
      box(-1, -1, -1, 3, 1, 3, 'subtract'),
      box(0.5, 0, 0.5, 1.5, 1, 1.5),
    ]);
    expect(solidVolume(solid)).toBeCloseTo(5, 12);
    const kept = solidBoxBoolean([box(0, 0, 0, 2, 2, 2), box(1, 1, 1, 3, 3, 3, 'intersect')]);
    expect(solidVolume(kept)).toBeCloseTo(1, 12);
    expect(solidBoxBoolean([]).indices.length).toBe(0);
  });
});
