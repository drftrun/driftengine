import { expect, test } from 'vitest';

import { addBias, erf, gelu, layerNorm, matmul, sigmoid, softmax } from './linear.ts';

/**
 * The dense operators a transformer is built from, each against numbers worked by hand.
 *
 * **Every expected value here is a literal derived on paper**, never an evaluation of the code
 * under test: a matrix product small enough to multiply in the head, a softmax of two logits whose
 * answer is a logistic, a layer norm of three numbers, and the standard normal's own table for GELU.
 */

test('a matrix product, and the same product against a transposed right-hand side', () => {
  /* [1 2 3; 4 5 6] times [1 0; 0 1; 1 1] is [4 5; 10 11]. */
  const a = Float32Array.from([1, 2, 3, 4, 5, 6]);
  const b = Float32Array.from([1, 0, 0, 1, 1, 1]);
  const out = new Float32Array(4);
  matmul(out, a, b, 2, 3, 2);
  expect(Array.from(out)).toEqual([4, 5, 10, 11]);
  /* The right-hand side stored as its transpose, 2 by 3, row by row: the same answer. */
  const bT = Float32Array.from([1, 0, 1, 0, 1, 1]);
  matmul(out, a, bT, 2, 3, 2, true);
  expect(Array.from(out)).toEqual([4, 5, 10, 11]);
});

test('a product read and written at offsets, which is how one head of many is taken', () => {
  const a = Float32Array.from([9, 9, 1, 2]);
  const b = Float32Array.from([7, 3, 4]);
  const out = Float32Array.from([0, 0]);
  /* One row of two, at offset 2, times a column of two at offset 1: 1*3 + 2*4 = 11. */
  matmul(out, a, b, 1, 2, 1, false, 1, 2, 1);
  expect(Array.from(out)).toEqual([0, 11]);
});

test('a bias is added to every row', () => {
  const x = Float32Array.from([1, 2, 3, 4]);
  addBias(x, 2, 2, Float32Array.from([10, 20]));
  expect(Array.from(x)).toEqual([11, 22, 13, 24]);
});

test('LAYER NORM OF A CONSTANT ROW IS ITS BETA, NOT NaN', () => {
  /* Zero variance: with epsilon forgotten this is 0 / 0. */
  const out = new Float32Array(3);
  layerNorm(
    Float32Array.from([5, 5, 5]),
    1,
    3,
    Float32Array.from([2, 2, 2]),
    Float32Array.from([0.5, -1, 3]),
    1e-6,
    out,
  );
  expect(Array.from(out)).toEqual([0.5, -1, 3]);
});

test('layer norm uses the population variance, as the upstream frameworks do', () => {
  /* [1 2 3]: mean 2, variance 2/3 (not 1), so the ends are ±1/sqrt(2/3) = ±1.2247448713915890. */
  const out = new Float32Array(3);
  layerNorm(
    Float32Array.from([1, 2, 3]),
    1,
    3,
    Float32Array.from([1, 1, 1]),
    new Float32Array(3),
    0,
    out,
  );
  expect(out[0]).toBeCloseTo(-1.224744871391589, 6);
  expect(out[1]).toBeCloseTo(0, 7);
  expect(out[2]).toBeCloseTo(1.224744871391589, 6);
});

test('erf against its own table, including the tail the series cannot reach', () => {
  expect(erf(0)).toBe(0);
  expect(erf(0.5)).toBeCloseTo(0.5204998778130465, 14);
  expect(erf(1)).toBeCloseTo(0.8427007929497149, 14);
  expect(erf(-2)).toBeCloseTo(-0.9953222650189527, 14);
  expect(erf(3.5)).toBeCloseTo(0.9999992569016276, 14);
  expect(erf(7)).toBe(1);
});

test('GELU IS THE EXACT ONE, x·Φ(x), NOT THE tanh APPROXIMATION', () => {
  /*
   * Φ(3) = 0.9986501019683699 from the standard normal table, so GELU(3) = 2.9959503059051097 and
   * GELU(−3) = −3·(1 − Φ(3)) = −0.0040496940948902. The tanh form gives 2.9963627 at 3 — a
   * different network by 4e-4, which a port against an upstream using the exact one inherits.
   */
  const out = new Float32Array(3);
  gelu(Float32Array.from([-3, 0, 3]), out);
  expect(out[0]).toBeCloseTo(-0.0040496940948902, 7);
  expect(out[1]).toBe(0);
  expect(out[2]).toBeCloseTo(2.9959503059051097, 6);
});

test('SOFTMAX OF LOGITS NEAR A THOUSAND IS A DISTRIBUTION, NOT NaN', () => {
  /* exp(1000) overflows; subtracting the row's largest first leaves e^-1 and e^0: a logistic. */
  const out = new Float32Array(4);
  softmax(Float32Array.from([1000, 1001, -2, -2]), 2, 2, out);
  expect(out[0]).toBeCloseTo(0.2689414213699951, 7);
  expect(out[1]).toBeCloseTo(0.7310585786300049, 7);
  expect(out[2]).toBe(0.5);
  expect(out[3]).toBe(0.5);
});

test('THE LOGISTIC IS ONE OVER ONE PLUS e TO THE MINUS x, finite at both tails', () => {
  /* σ(0) = ½; σ(ln 3) = 1/(1 + ⅓) = ¾; σ(−ln 3) = ¼; and far out, 1 and a number too small to see
     rather than NaN. */
  const out = new Float32Array(5);
  sigmoid(Float32Array.from([0, Math.log(3), -Math.log(3), 100, -100]), out);
  expect(out[0]).toBe(0.5);
  expect(out[1]).toBeCloseTo(0.75, 7);
  expect(out[2]).toBeCloseTo(0.25, 7);
  expect(out[3]).toBe(1);
  expect(out[4]).toBeGreaterThanOrEqual(0);
  expect(out[4]).toBeLessThan(1e-40);
});
