import { expect, test } from 'vitest';
import { SLICE_STRIDE, sliceInto } from './uiSlice.ts';

const FRAME = { u0: 0, v0: 0, u1: 1, v1: 1 };
const INSET = { left: 8, top: 8, right: 8, bottom: 8 };
const out = () => new Float32Array(9 * SLICE_STRIDE);

/** w of the nth placement. */
function w(a: Float32Array, n: number): number {
  return a[n * SLICE_STRIDE + 2] as number;
}
function h(a: Float32Array, n: number): number {
  return a[n * SLICE_STRIDE + 3] as number;
}

test('nine placements come back for a box larger than its insets', () => {
  expect(sliceInto(out(), FRAME, 32, 32, INSET, 0, 0, 100, 100)).toBe(9);
});

test('the corners keep their source size however large the box is', () => {
  const a = out();
  sliceInto(a, FRAME, 32, 32, INSET, 0, 0, 500, 500);
  expect(w(a, 0)).toBe(8);
  expect(h(a, 0)).toBe(8);
  expect(w(a, 8)).toBe(8);
});

test('the middle stretches to whatever is left between the insets', () => {
  const a = out();
  sliceInto(a, FRAME, 32, 32, INSET, 0, 0, 100, 100);
  expect(w(a, 4)).toBe(100 - 16);
  expect(h(a, 4)).toBe(100 - 16);
});

test('a box narrower than its insets shrinks the corners rather than overlapping them', () => {
  const a = out();
  sliceInto(a, FRAME, 32, 32, INSET, 0, 0, 10, 100);
  expect(w(a, 0)).toBeLessThanOrEqual(5);
  expect(w(a, 0) + w(a, 4) + w(a, 2)).toBeCloseTo(10, 5);
});

test('a box exactly the inset size still writes nine placements, with a zero-width middle', () => {
  const a = out();
  expect(sliceInto(a, FRAME, 32, 32, INSET, 0, 0, 16, 16)).toBe(9);
  expect(w(a, 4)).toBe(0);
});

test('the nine cells tile the box with no gap and no overlap', () => {
  const a = out();
  sliceInto(a, FRAME, 32, 32, INSET, 5, 7, 100, 60);
  // Left column x, then the middle starts where it ends, and the right ends at the box edge.
  expect(a[0]).toBe(5);
  expect(a[2 * SLICE_STRIDE] as number).toBeCloseTo(5 + 100 - 8, 5);
  expect((a[2 * SLICE_STRIDE] as number) + w(a, 2)).toBeCloseTo(105, 5);
  expect((a[1] as number) + h(a, 0) + h(a, 3) + h(a, 6)).toBeCloseTo(67, 5);
});

test('the uv splits follow the insets as a fraction of the source, not of the box', () => {
  const a = out();
  sliceInto(a, FRAME, 32, 32, INSET, 0, 0, 500, 500);
  // Top-left cell's u1 is 8/32 of the way across the frame.
  expect(a[6] as number).toBeCloseTo(0.25, 6);
});
