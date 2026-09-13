import { describe, expect, it } from 'vitest';

import { fbm2, rand3, valueNoise2, valueNoise3 } from './noise';

describe('the noise the terrain is built from', () => {
  it('gives the same value for the same seed and point', () => {
    /* Determinism is what the save format rests on: a world is a seed plus its edits, so
       noise that drifted would reload as a different world. */
    expect(valueNoise2(1337, 12.5, -4.25)).toBe(valueNoise2(1337, 12.5, -4.25));
    expect(valueNoise3(1337, 1.5, 2.5, 3.5)).toBe(valueNoise3(1337, 1.5, 2.5, 3.5));
    expect(rand3(1337, 7, 8, 9)).toBe(rand3(1337, 7, 8, 9));
  });

  it('gives different values for different seeds', () => {
    expect(valueNoise2(1, 4.5, 4.5)).not.toBe(valueNoise2(2, 4.5, 4.5));
  });

  it('stays inside the unit range', () => {
    for (let i = 0; i < 200; i++) {
      const v = valueNoise2(1337, i * 0.37, i * 0.11);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('sums octaves without leaving the unit range', () => {
    for (let i = 0; i < 200; i++) {
      const v = fbm2(1337, i * 0.37, i * 0.11, 4);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
