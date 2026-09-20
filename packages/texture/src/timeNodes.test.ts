import { expect, test } from 'vitest';
import { flipbookFrame, latentLerpWeights } from './timeNodes.ts';

test('time zero is the first frame', () => {
  expect(flipbookFrame(0, 8, 24, true)).toBe(0);
});

test('a looping flipbook wraps rather than running off the end', () => {
  expect(flipbookFrame(8 / 24, 8, 24, true)).toBe(0);
  expect(flipbookFrame(9 / 24, 8, 24, true)).toBe(1);
});

test('a non-looping flipbook holds its last frame', () => {
  expect(flipbookFrame(100, 8, 24, false)).toBe(7);
});

test('negative time is handled rather than producing a negative index', () => {
  expect(flipbookFrame(-1 / 24, 8, 24, true)).toBe(7);
  expect(flipbookFrame(-1 / 24, 8, 24, false)).toBe(0);
});

test('the same time always gives the same frame, which is the whole replay guarantee', () => {
  const t = 1.234567;
  expect(flipbookFrame(t, 16, 30, true)).toBe(flipbookFrame(t, 16, 30, true));
});

test('latent interpolation picks the two surrounding keys and a mix between them', () => {
  const out = { a: 0, b: 0, mix: 0 };
  latentLerpWeights(0.5, 3, 1, out);
  expect(out.a).toBe(1);
  expect(out.b).toBe(2);
  expect(out.mix).toBeCloseTo(0, 6);
});

test('interpolation halfway through the first span is halfway between the first two keys', () => {
  const out = { a: 0, b: 0, mix: 0 };
  latentLerpWeights(0.25, 3, 1, out);
  expect(out.a).toBe(0);
  expect(out.b).toBe(1);
  expect(out.mix).toBeCloseTo(0.5, 6);
});

test('at the exact end it lands on the last key', () => {
  const out = { a: 0, b: 0, mix: 0 };
  latentLerpWeights(1, 3, 1, out);
  expect(out.b).toBe(2);
  expect(out.mix).toBe(1);
});

test('a single key needs no interpolation', () => {
  const out = { a: 9, b: 9, mix: 9 };
  latentLerpWeights(0.5, 1, 1, out);
  expect(out).toEqual({ a: 0, b: 0, mix: 0 });
});
