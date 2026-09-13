import { expect, test } from 'vitest';
import { classifyRightGesture } from './rightGesture.ts';
import type { RightGestureOptions } from './rightGesture.ts';

const OPTIONS: RightGestureOptions = {
  gestureMovePx: 12,
  swipeMaxMs: 160,
  swipeDominance: 2.4,
};

const at = (dx: number, dy: number, ms: number): string =>
  classifyRightGesture(dx, dy, ms, OPTIONS);

test('a drag is nothing until it has actually travelled', () => {
  expect(at(2, 3, 40)).toBe('pending');
});

test('looking down is a look, not a swallowed flick', () => {
  /*
   * The reported bug: the camera turned left and right but often not up and
   * down. Any quick downward drag was classified as the secondary flick, so
   * looking at the ground moved the camera nowhere. Horizontal look was never
   * affected, because nothing competes for it — which is exactly the shape of
   * the symptom.
   */
  expect(at(0, 40, 300), 'a deliberate look down').toBe('look');
  expect(at(30, 46, 90), 'a diagonal glance down').toBe('look');
  expect(at(0, -50, 60), 'looking up is never a flick').toBe('look');
});

test('a steep, fast, downward flick is still the secondary action', () => {
  // It has to remain reachable, or the gesture is gone rather than fixed.
  expect(at(3, 60, 80)).toBe('secondary');
});

test('when in doubt it is a look', () => {
  /*
   * The two failure modes are not equal. A missed flick costs one slide; a look
   * wrongly eaten costs the camera for the whole gesture, and is felt as the
   * controls being broken rather than as a missed input.
   */
  expect(at(20, 34, 100), 'ambiguous angle').toBe('look');
  expect(at(0, 40, 400), 'slow and vertical').toBe('look');
});
