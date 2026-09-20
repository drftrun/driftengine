import { expect, test } from 'vitest';

import { FOV_Y_DEG } from './constants';
import { MOON_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS } from './sky';

/** Pixels a disc of this angular radius spans at the middle of a frame 720 pixels tall. */
function spanOf(radius: number): number {
  const perRadian = 360 / Math.tan((FOV_Y_DEG * Math.PI) / 360);
  return 2 * radius * perRadian;
}

test('THE SUN AND THE MOON READ AS DISCS RATHER THAN SPECKS, at the sandbox’s own field of view', () => {
  /*
   * The real sun is half a degree across, which at 70 degrees is five pixels of a 720-pixel frame:
   * a star rather than a sun, and a moon whose phase nobody can see. A player noticed. The sky of
   * a block world is drawn at the size a player reads it, not the size an almanac gives.
   */
  expect(spanOf(SUN_ANGULAR_RADIUS)).toBeGreaterThanOrEqual(30);
  expect(spanOf(MOON_ANGULAR_RADIUS)).toBeGreaterThanOrEqual(30);
});

test('and the moon stays within a tenth of the sun’s size, as it is in the sky', () => {
  expect(Math.abs(MOON_ANGULAR_RADIUS / SUN_ANGULAR_RADIUS - 1)).toBeLessThanOrEqual(0.1);
});
