import { describe, expect, it } from 'vitest';
import { glassSeenShare, resolveGlass, schlickFresnel } from './glass.ts';

describe('glass', () => {
  it('GLASS THAT LETS NOTHING THROUGH IS NOT GLASS', () => {
    const out = { transmission: 9, frost: 9, tint: [9, 9, 9] as [number, number, number] };
    expect(resolveGlass({ transmission: 0, frost: 1 }, out)).toBe(false);
    expect(out).toEqual({ transmission: 0, frost: 0, tint: [1, 1, 1] });
    expect(resolveGlass(undefined, out)).toBe(false);
  });

  it('clamps what it is given and tints white by default', () => {
    const out = { transmission: 0, frost: 0, tint: [0, 0, 0] as [number, number, number] };
    expect(resolveGlass({ transmission: 2, frost: -1 }, out)).toBe(true);
    expect(out).toEqual({ transmission: 1, frost: 0, tint: [1, 1, 1] });
    resolveGlass({ transmission: 0.5, frost: 0.25, tint: [1, 0.5, 0.25] }, out);
    expect(out).toEqual({ transmission: 0.5, frost: 0.25, tint: [1, 0.5, 0.25] });
  });

  it('shows less of what is behind it at a grazing angle', () => {
    /* Face-on: 0.04 of the light is reflected. At the 0.05 floor: 0.04 + 0.96 × 0.95⁵. */
    expect(schlickFresnel(1)).toBeCloseTo(0.04, 10);
    expect(schlickFresnel(0)).toBeCloseTo(0.04 + 0.96 * 0.95 ** 5, 10);
    expect(glassSeenShare(0.9, 1)).toBeCloseTo(0.9 * 0.96, 10);
  });
});
