import { expect, test } from 'vitest';
import { progressiveOrder, usableAt } from './progressive.ts';

test('the order is a permutation, with every tile present exactly once', () => {
  const out = new Uint32Array(10);
  const count = progressiveOrder(10, out);
  expect(count).toBe(10);
  expect(Array.from(out).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a prefix is spread over the range rather than filling one end', () => {
  const out = new Uint32Array(16);
  progressiveOrder(16, out);
  const firstFour = Array.from(out.subarray(0, 4));
  /* Sequential order would give 0,1,2,3, all inside the first quarter. */
  expect(Math.max(...firstFour)).toBeGreaterThan(7);
});

test('the order is deterministic', () => {
  const a = new Uint32Array(16);
  const b = new Uint32Array(16);
  progressiveOrder(16, a);
  progressiveOrder(16, b);
  expect(Array.from(a)).toEqual(Array.from(b));
});

test('no tiles is an empty order rather than an error', () => {
  expect(progressiveOrder(0, new Uint32Array(4))).toBe(0);
});

test('the level rises monotonically with bytes received', () => {
  let previous = -1;
  for (const bytes of [0, 100, 400, 1600, 6400]) {
    const { level } = usableAt(bytes, 100, 64);
    expect(level).toBeGreaterThanOrEqual(previous);
    previous = level;
  }
});

test('receiving everything reports complete', () => {
  expect(usableAt(6400, 100, 64).complete).toBe(true);
  expect(usableAt(100, 100, 64).complete).toBe(false);
});
