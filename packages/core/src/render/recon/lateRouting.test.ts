import { describe, expect, it } from 'vitest';
import { routesLate, tracksMotion } from './lateRouting.ts';

describe('late routing', () => {
  it('NOTHING ROUTES LATE AND NOTHING TRACKS MOTION WHEN THE FRAME IS NOT RECONSTRUCTED', () => {
    expect(routesLate(false, false, false, false)).toBe(false);
    expect(tracksMotion(false, false, false, false)).toBe(false);
  });

  it('a reconstructed frame routes its own blended draws late and tracks its movers', () => {
    expect(routesLate(true, false, false, false)).toBe(true);
    expect(tracksMotion(true, false, false, false)).toBe(true);
  });

  it('a mirror, a probe bake and the overlay after the frame are not the reconstructed picture', () => {
    for (const [mirror, probe, presented] of [
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ] as const) {
      expect(routesLate(true, mirror, probe, presented)).toBe(false);
      expect(tracksMotion(true, mirror, probe, presented)).toBe(false);
    }
  });
});
