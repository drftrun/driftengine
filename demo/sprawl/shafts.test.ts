import { expect, test } from 'vitest';

import { segmentDistance, shaftStrength } from './shafts.ts';

test('A SHAFT FADES OUT BETWEEN ITS FAR DISTANCES AND IN NEAR THE EYE, by the night', () => {
  /* Halfway through a 40–95 m fade the smooth step is a half: at full night, 0.5; at half night, 0.25. */
  expect(shaftStrength(1, 67.5, 40, 95, 2.5, 0, 0, 0)).toBeCloseTo(0.5, 12);
  expect(shaftStrength(0.5, 67.5, 40, 95, 2.5, 0, 0, 0)).toBeCloseTo(0.25, 12);
  /* Inside its near fade, a fifth of the way: 3(0.2)² - 2(0.2)³ = 0.104. */
  expect(shaftStrength(1, 0.5, 40, 95, 2.5, 0, 0, 0)).toBeCloseTo(0.104, 12);
  /* Past its far fade, nothing; with no fade of its own, all of the night. */
  expect(shaftStrength(1, 95, 40, 95, 2.5, 0, 0, 0)).toBe(0);
  expect(shaftStrength(0.8, 300, 0, 0, 0, 0, 0, 0)).toBeCloseTo(0.8, 12);
});

test('A PULSING SHAFT DIMS BY ITS DEPTH AT THE TOP OF ITS PULSE', () => {
  /* At 0.5 Hz a quarter period is half a second, where the sine is 1: 1 - 0.35. At the start, a
     half of the depth. */
  expect(shaftStrength(1, 10, 0, 0, 0, 0.5, 0.35, 0.5)).toBeCloseTo(0.65, 12);
  expect(shaftStrength(1, 10, 0, 0, 0, 0.5, 0.35, 0)).toBeCloseTo(0.825, 12);
});

test('THE DISTANCE TO A SHAFT IS TO ITS LIGHT, not to its apex', () => {
  /* Light from 1 to 9 m below an apex at (0, 10, 0): an eye at (3, 5, 0) is 3 m beside it; one at
     (0, 12, 0) is 3 m above where it starts; one at (0, -2, 0) 3 m below where it ends. */
  expect(segmentDistance(3, 5, 0, 0, 10, 0, 0, -1, 0, 1, 9)).toBeCloseTo(3, 12);
  expect(segmentDistance(0, 12, 0, 0, 10, 0, 0, -1, 0, 1, 9)).toBeCloseTo(3, 12);
  expect(segmentDistance(0, -2, 0, 0, 10, 0, 0, -1, 0, 1, 9)).toBeCloseTo(3, 12);
});
