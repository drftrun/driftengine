import { expect, test } from 'vitest';

import { halfBits } from './halfFloat.ts';

/**
 * **A value is carried to the nearest half, ties to even** — what IEEE 754 conversion means by
 * default, and what the network runner's half-precision weights need, since the reference they are
 * checked against rounds the same way. Truncating instead moves every value toward zero, which in an
 * environment cube is radiance lost on every texel rather than rounded on each.
 *
 * The half above 1 is 1 + 2^-10, so its unit in the last place there is 2^-10 and every value below
 * is a known fraction of it. Each expectation is worked from that, never from the code.
 */
test('A VALUE ROUNDS TO THE NEARER HALF, not toward zero', () => {
  /* Three quarters of the way to the next half up: nearer it. */
  expect(halfBits(1 + 0.75 * 2 ** -10)).toBe(0x3c01);
  /* A quarter of the way: nearer the one below. */
  expect(halfBits(1 + 0.25 * 2 ** -10)).toBe(0x3c00);
  expect(halfBits(-(1 + 0.75 * 2 ** -10))).toBe(0xbc01);
});

test('a value halfway between two halves goes to the even one', () => {
  expect(halfBits(1 + 0.5 * 2 ** -10)).toBe(0x3c00);
  expect(halfBits(1 + 1.5 * 2 ** -10)).toBe(0x3c02);
});

test('rounding carries into the exponent, and past the largest finite half to infinity', () => {
  /* The largest subnormal is 1023 · 2^-24; half a unit above it is a tie, and 1024 is the even side. */
  expect(halfBits(1023.5 * 2 ** -24)).toBe(0x0400);
  /* 65,504 is 2^15 · (1 + 1023/1024); 65,520 is the tie above it, and even is the carry. */
  expect(halfBits(65504)).toBe(0x7bff);
  expect(halfBits(65520)).toBe(0x7c00);
});

test('a subnormal rounds as a normal does', () => {
  expect(halfBits(0.75 * 2 ** -24)).toBe(0x0001);
  expect(halfBits(0.5 * 2 ** -24)).toBe(0x0000);
  expect(halfBits(1.5 * 2 ** -24)).toBe(0x0002);
});

test('a NaN stays a NaN', () => {
  const bits = halfBits(Number.NaN);
  expect(bits & 0x7c00).toBe(0x7c00);
  expect(bits & 0x03ff).not.toBe(0);
});
