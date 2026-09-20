import { expect, test } from 'vitest';
import { visibleRange, visibleRangeVariable } from './virtualList.ts';

test('the top of a long list shows a screenful, not the list', () => {
  expect(visibleRange(0, 100, 20, 10000, 0)).toEqual({ first: 0, count: 5 });
});

test('scrolling moves the window rather than growing it', () => {
  expect(visibleRange(200, 100, 20, 10000, 0)).toEqual({ first: 10, count: 5 });
});

test('a partial row at the top is included, because half a row is still drawn', () => {
  expect(visibleRange(10, 100, 20, 10000, 0)).toEqual({ first: 0, count: 6 });
});

test('overscan widens the window without running past either end', () => {
  expect(visibleRange(0, 100, 20, 10000, 3).first).toBe(0);
  expect(visibleRange(400, 100, 20, 10000, 3).first).toBe(17);
});

test('the window never runs past the last row', () => {
  const range = visibleRange(100000, 100, 20, 10, 0);
  expect(range.first + range.count).toBeLessThanOrEqual(10);
});

test('an empty list has an empty window rather than a negative one', () => {
  expect(visibleRange(0, 100, 20, 0, 3)).toEqual({ first: 0, count: 0 });
});

test('variable row heights find the window through their offset table', () => {
  const offsets = new Float64Array([0, 10, 40, 50, 90, 200]);
  expect(visibleRangeVariable(40, 60, offsets, 5, 0).first).toBe(2);
});

test('variable rows include every row the window touches', () => {
  const offsets = new Float64Array([0, 10, 40, 50, 90, 200]);
  const range = visibleRangeVariable(40, 60, offsets, 5, 0);
  expect(range.first + range.count).toBeGreaterThanOrEqual(4);
});
