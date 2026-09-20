import { expect, test } from 'vitest';
import { HALF_MAX, fromHalfBits, halfWeights, roundHalf, toHalfBits } from './half.ts';

/*
 * **Anchored on IEEE 754's own bit patterns and on an exhaustive round trip**, not on a second
 * implementation of the same arithmetic. Node 22 has no `Float16Array` and no `Math.f16round`, so
 * there is nothing on the platform to compare against — which is exactly why the anchors have to be
 * the standard's table and the property that every one of the 65,536 patterns survives a decode and
 * an encode.
 */
test('the patterns the standard tabulates come out bit for bit', () => {
  const table: Array<[number, number]> = [
    [0, 0x0000],
    [-0, 0x8000],
    [1, 0x3c00],
    [-2, 0xc000],
    [0.5, 0x3800],
    [65504, 0x7bff],
    [-65504, 0xfbff],
    [2 ** -14, 0x0400],
    [2 ** -24, 0x0001],
    [1023 * 2 ** -24, 0x03ff],
    [Infinity, 0x7c00],
    [-Infinity, 0xfc00],
    [1 / 3, 0x3555],
  ];
  for (const [value, bits] of table) {
    expect(toHalfBits(value), `${value}`).toBe(bits);
  }
  expect(toHalfBits(Number.NaN) & 0x7c00).toBe(0x7c00);
  expect(toHalfBits(Number.NaN) & 0x03ff).not.toBe(0);
});

test('every one of the 65,536 patterns decodes and encodes back to itself', () => {
  let checked = 0;
  for (let bits = 0; bits < 0x10000; bits += 1) {
    const value = fromHalfBits(bits);
    if (Number.isNaN(value)) {
      /* Every NaN pattern is a NaN, and a NaN encodes to a NaN; its payload is not kept. */
      expect((bits & 0x7c00) === 0x7c00 && (bits & 0x03ff) !== 0).toBe(true);
      expect(Number.isNaN(fromHalfBits(toHalfBits(value)))).toBe(true);
      continue;
    }
    expect(toHalfBits(value), `pattern ${bits.toString(16)}`).toBe(bits);
    checked += 1;
  }
  /* 65,536 less the 2,046 NaN patterns (two exponents' worth of non-zero mantissas). */
  expect(checked).toBe(0x10000 - 2 * 1023);
});

test('a tie rounds to the even neighbour, and anything past a tie rounds away', () => {
  /* One unit in the last place above 1 is 2^-10, so 2^-11 is exactly halfway. */
  expect(roundHalf(1 + 2 ** -11)).toBe(1);
  expect(roundHalf(1 + 3 * 2 ** -11)).toBe(1 + 2 * 2 ** -10);
  expect(roundHalf(1 + 2 ** -11 + 2 ** -20)).toBe(1 + 2 ** -10);
  /* The same rule in the subnormal range, where a unit is 2^-24. */
  expect(roundHalf(2 ** -25)).toBe(0);
  expect(roundHalf(3 * 2 ** -25)).toBe(2 * 2 ** -24);
});

test('the largest finite value is the edge, and one tie past it is infinity', () => {
  expect(HALF_MAX).toBe(65504);
  expect(roundHalf(65519.99)).toBe(65504);
  /* 65520 is halfway between 65504 and 65536, and 65536's mantissa is the even one. */
  expect(roundHalf(65520)).toBe(Infinity);
  expect(roundHalf(-70000)).toBe(-Infinity);
  /* Far past it, where an exponent that is not clamped would run into the sign bit. */
  expect(toHalfBits(1e6)).toBe(0x7c00);
  expect(toHalfBits(-1e300)).toBe(0xfc00);
  expect(toHalfBits(Number.MAX_VALUE)).toBe(0x7c00);
});

test('a value too small for the subnormal range keeps its sign as a zero', () => {
  expect(Object.is(roundHalf(-(2 ** -30)), -0)).toBe(true);
  expect(Object.is(roundHalf(2 ** -30), 0)).toBe(true);
});

test('weights convert to half bits as a whole, each rounded on its own', () => {
  const bits = halfWeights(Float32Array.from([1, -2, 1 / 3, 70000]));
  expect(Array.from(bits)).toEqual([0x3c00, 0xc000, 0x3555, 0x7c00]);
});
