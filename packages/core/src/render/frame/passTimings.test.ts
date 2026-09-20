import { expect, test } from 'vitest';
import {
  createPassTimings,
  passLabel,
  passMs,
  recordPassLabel,
  recordPassSample,
  resetPassTimings,
} from './passTimings.ts';

test('a pass nothing measured reports unmeasured, which is not the same as zero', () => {
  const timings = createPassTimings(4);
  expect(passMs(timings, 2)).toBe(null);
});

test('a pass measured at zero reports zero, which is not the same as unmeasured', () => {
  const timings = createPassTimings(4);
  recordPassSample(timings, 2, 0);
  expect(passMs(timings, 2)).toBe(0);
});

test('two samples in one pass sum rather than replace', () => {
  const timings = createPassTimings(4);
  recordPassSample(timings, 0, 0.5);
  recordPassSample(timings, 0, 0.25);
  expect(passMs(timings, 0)).toBeCloseTo(0.75, 10);
});

test('a reset clears the timings and keeps the names', () => {
  const timings = createPassTimings(4);
  recordPassLabel(timings, 1, 'visibility');
  recordPassSample(timings, 1, 2);
  resetPassTimings(timings);
  expect(passMs(timings, 1)).toBe(null);
  expect(passLabel(timings, 1)).toBe('visibility');
});

test('a pass index past the end is refused rather than growing the arrays', () => {
  const timings = createPassTimings(2);
  recordPassSample(timings, 99, 1);
  recordPassLabel(timings, 99, 'nowhere');
  expect(timings.ms.length).toBe(2);
  expect(passMs(timings, 99)).toBe(null);
});
