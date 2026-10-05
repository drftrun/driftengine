import { describe, expect, it } from 'vitest';

import { RGB9E5_MAX, packRgb9e5, unpackRgb9e5 } from './rgb9e5.ts';

const decode = (bits: number): number[] => {
  const out = [0, 0, 0];
  unpackRgb9e5(bits, out);
  return out;
};

describe('rgb9e5, the shared-exponent word', () => {
  /*
   * (1, 0.5, 0): the largest is 1, so the exponent is floor(log2 1) + 1 + 15 = 16 and a step is
   * 2^(16 - 24) = 1/256, giving mantissas 256, 128 and 0 and the word
   * 256 | 128 << 9 | 16 << 27 = 2,147,549,440, which decodes exactly.
   */
  it('PACKS A COLOUR INTO THE BITS THE FORMAT NAMES, AND READS IT BACK', () => {
    expect(packRgb9e5(1, 0.5, 0)).toBe(2147549440);
    expect(decode(2147549440)).toEqual([1, 0.5, 0]);
  });

  /*
   * 511.9 has exponent floor(log2 511.9) + 1 + 15 = 24 and a step of one, so its mantissa rounds to
   * 512, which does not fit: the format takes the next exponent instead, a step of two, and the
   * value comes back as 512 rather than wrapping to nothing.
   */
  it('takes the next exponent where the largest channel rounds up to 512', () => {
    expect(decode(packRgb9e5(511.9, 0, 0))).toEqual([512, 0, 0]);
  });

  /*
   * What it gives up, stated as a number: beside 1,000 the step is two, so 1 comes back as 2 —
   * a channel a thousandth of its neighbour keeps about one bit.
   */
  it('shares the largest channel exponent, so a small channel beside a large one is coarse', () => {
    expect(decode(packRgb9e5(1000, 1, 0))).toEqual([1000, 2, 0]);
  });

  it('holds nothing negative, nothing undefined, and nothing past its largest value', () => {
    expect(decode(packRgb9e5(-1, Number.NaN, 0))).toEqual([0, 0, 0]);
    expect(decode(packRgb9e5(1e9, 0, 0))[0]).toBe(RGB9E5_MAX);
    expect(RGB9E5_MAX).toBe(65408);
  });
});
