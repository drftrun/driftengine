import { expect, test } from 'vitest';
import { createLineSegments, setPolyline } from './linePoints.ts';

/** Four points on a line, three floats each. */
const POINTS = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);

test('n points become n-1 segments, end to end', () => {
  const segments = createLineSegments(8);
  expect(setPolyline(segments, POINTS, 4)).toBe(3);
  expect(segments.count).toBe(3);
  expect([...segments.from.slice(0, 3)]).toEqual([0, 0, 0]);
  expect([...segments.to.slice(0, 3)]).toEqual([1, 0, 0]);
  /* The third segment runs from the third point to the fourth. */
  expect([...segments.from.slice(6, 9)]).toEqual([2, 0, 0]);
  expect([...segments.to.slice(6, 9)]).toEqual([3, 0, 0]);
});

/* A single point is not a line. Zero segments, not a segment of zero length, which would
   be a degenerate quad the shader has to reject at every vertex. */
test('one point or none produces nothing', () => {
  const segments = createLineSegments(8);
  expect(setPolyline(segments, POINTS, 1)).toBe(0);
  expect(setPolyline(segments, POINTS, 0)).toBe(0);
  expect(segments.count).toBe(0);
});

/* A caller that overruns loses its tail rather than its frame, which is the rule
   `expandBoltSegments` already follows for the same reason. */
test('more points than capacity fills to capacity and stops', () => {
  const segments = createLineSegments(2);
  expect(setPolyline(segments, POINTS, 4)).toBe(2);
  expect(segments.count).toBe(2);
});

/*
 * This runs every frame a waveform moves. The rule for a hot path is zero allocation, and
 * the way that stays honest is by asserting the buffers are the same objects afterwards
 * rather than by trusting a comment.
 */
test('rewriting a polyline reuses the same buffers', () => {
  const segments = createLineSegments(8);
  const from = segments.from;
  const to = segments.to;
  setPolyline(segments, POINTS, 4);
  setPolyline(segments, POINTS, 3);
  expect(segments.from).toBe(from);
  expect(segments.to).toBe(to);
});
