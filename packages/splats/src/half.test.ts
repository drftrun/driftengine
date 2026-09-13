import { describe, expect, it } from 'vitest';
import { floatToHalf, halfToFloat, packHalf2x16 } from './half.ts';

/*
 * Every expectation here is a hand-derived bit pattern from the binary16 layout — one sign bit,
 * five exponent bits at excess-15, ten mantissa bits — and not a value this encoder produced.
 */
describe('floatToHalf', () => {
  it('encodes the patterns the format defines', () => {
    expect(floatToHalf(0)).toBe(0x0000);
    expect(floatToHalf(-0)).toBe(0x8000);
    /* 1.0 is exponent 15 (biased 0) with an empty mantissa: 0 01111 0000000000. */
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(-1)).toBe(0xbc00);
    /* 0.5 is one exponent step below: 0 01110 0000000000. */
    expect(floatToHalf(0.5)).toBe(0x3800);
    expect(floatToHalf(2)).toBe(0x4000);
    /* The largest normal, 65504 = (2 − 2^−10) × 2^15: 0 11110 1111111111. */
    expect(floatToHalf(65504)).toBe(0x7bff);
    /* The smallest normal, 2^−14: 0 00001 0000000000. */
    expect(floatToHalf(2 ** -14)).toBe(0x0400);
    /* The smallest subnormal, 2^−24: 0 00000 0000000001. */
    expect(floatToHalf(2 ** -24)).toBe(0x0001);
  });

  it('saturates above the range and flushes below it', () => {
    expect(floatToHalf(1e9), 'past the largest normal').toBe(0x7c00);
    expect(floatToHalf(-1e9)).toBe(0xfc00);
    expect(floatToHalf(Infinity)).toBe(0x7c00);
    /* Half of the smallest subnormal has nowhere to land and no bit to round up into. */
    expect(floatToHalf(2 ** -30)).toBe(0x0000);
    expect(floatToHalf(-(2 ** -30))).toBe(0x8000);
  });

  it('rounds to nearest, ties to even', () => {
    /*
     * 2049 sits exactly halfway between the two representable neighbours at that magnitude: above
     * 2048 the spacing is 2, so the candidates are 2048 and 2050. Ties-to-even takes 2048, whose
     * mantissa is 0. A truncating encoder would also give 2048 here, so the next case is the one
     * that separates them.
     */
    expect(halfToFloat(floatToHalf(2049))).toBe(2048);
    /* 2051 is halfway between 2050 and 2052; ties-to-even takes 2052, and truncation gives 2050. */
    expect(halfToFloat(floatToHalf(2051))).toBe(2052);
    /* Not a tie at all: 2051.5 is nearer 2052 either way, which truncation gets wrong. */
    expect(halfToFloat(floatToHalf(2051.5))).toBe(2052);
  });

  it('round-trips a value inside the range to within half an ulp', () => {
    /* The spacing at 1.0 is 2^−10, so a correctly rounded half is within 2^−11 of the input. */
    for (const value of [0.1, 0.25, 1 / 3, 0.9, 1.7, 12.34, -0.001]) {
      const back = halfToFloat(floatToHalf(value));
      const ulp = 2 ** (Math.floor(Math.log2(Math.abs(value))) - 10);
      expect(Math.abs(back - value), `${value} came back as ${back}`).toBeLessThanOrEqual(ulp / 2);
    }
  });
});

describe('packHalf2x16', () => {
  it('puts the first argument in the low sixteen bits', () => {
    /*
     * The one detail a shader cannot report going wrong: swapping the halves transposes a
     * covariance's terms into each other's places, which is still a valid matrix and still draws
     * a plausible — wrong — ellipse.
     */
    const packed = packHalf2x16(1, 2);
    expect(packed & 0xffff).toBe(0x3c00);
    expect(packed >>> 16).toBe(0x4000);
  });

  it('stays an unsigned 32-bit value with both halves negative', () => {
    /* −1 sets the sign bit of the high half, which is where a signed shift would produce −1. */
    const packed = packHalf2x16(-1, -1);
    expect(packed).toBe(0xbc00bc00);
    expect(packed).toBeGreaterThan(0);
  });
});
