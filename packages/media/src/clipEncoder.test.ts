import { expect, test } from 'vitest';
import { frameTimestampUs } from './clipEncoder.ts';

/**
 * The arithmetic the whole offline pipeline rests on.
 *
 * Not much code, and the reason it earns a test is what it replaces: a real-time
 * recorder stamps a frame with when it arrived, so the file's cadence measures how busy
 * the machine was. This derives each stamp from its own index, which cannot drift — and
 * "cannot drift" is a property worth one test.
 */

test('frame timestamps are exact microseconds derived from the index', () => {
  /*
   * Hand-derived. One 60 fps frame is 16666.666... µs, so the nearest integer is 16667 —
   * a third of a microsecond long. Accumulating that constant is 20 ms of drift over a
   * minute, which is more than a frame by the end of a clip; rounding the *product*
   * keeps every stamp within half a microsecond of the truth forever.
   */
  expect(frameTimestampUs(0, 60)).toBe(0);
  expect(frameTimestampUs(1, 60)).toBe(16667);
  expect(frameTimestampUs(60, 60)).toBe(1_000_000);
  expect(frameTimestampUs(100, 60)).toBe(1_666_667);
  expect(frameTimestampUs(1000, 60)).toBe(16_666_667);
  // A minute of 60 fps: 3600 x 16666.666... is 60,000,000 exactly.
  expect(frameTimestampUs(3600, 60)).toBe(60_000_000);
  expect(frameTimestampUs(30, 30)).toBe(1_000_000);
});

test('no accumulated drift, at any length', () => {
  /*
   * Stated as the property rather than as more examples: every stamp is within half a
   * microsecond of the ideal, which a naive `index * 16667` fails at frame 60 and misses
   * by 20 ms at frame 3600.
   */
  for (const index of [1, 7, 59, 601, 3599, 36_000]) {
    const ideal = (index * 1_000_000) / 60;
    expect(Math.abs(frameTimestampUs(index, 60) - ideal), `frame ${index}`).toBeLessThanOrEqual(
      0.5,
    );
  }
});
