import { expect, test } from 'vitest';

import { AXIS_INDEX, BUTTON_INDEX, DEFAULT_DEADZONE, applyDeadzone } from './gamepadMapping.ts';

/**
 * The positions, against the specification's table rather than against a pad.
 *
 * Hand-derived literals: these are the W3C Standard Gamepad indices, and writing them out is the
 * whole point — deriving them from the thing under test would assert nothing.
 */
test('the layout is the standard one, by position', () => {
  expect(BUTTON_INDEX.faceDown, 'bottom of the right cluster').toBe(0);
  expect(BUTTON_INDEX.faceRight).toBe(1);
  expect(BUTTON_INDEX.faceLeft).toBe(2);
  expect(BUTTON_INDEX.faceUp).toBe(3);
  expect(BUTTON_INDEX.l1).toBe(4);
  expect(BUTTON_INDEX.r1).toBe(5);
  expect(BUTTON_INDEX.l2).toBe(6);
  expect(BUTTON_INDEX.r2).toBe(7);
  expect(BUTTON_INDEX.select).toBe(8);
  expect(BUTTON_INDEX.start).toBe(9);
  expect(BUTTON_INDEX.l3).toBe(10);
  expect(BUTTON_INDEX.r3).toBe(11);
  expect(BUTTON_INDEX.dpadUp).toBe(12);
  expect(BUTTON_INDEX.dpadDown).toBe(13);
  expect(BUTTON_INDEX.dpadLeft).toBe(14);
  expect(BUTTON_INDEX.dpadRight).toBe(15);
  expect(BUTTON_INDEX.guide).toBe(16);

  expect(AXIS_INDEX.leftX).toBe(0);
  expect(AXIS_INDEX.leftY).toBe(1);
  expect(AXIS_INDEX.rightX).toBe(2);
  expect(AXIS_INDEX.rightY).toBe(3);
});

/**
 * Radial, not per-axis, and rescaled from the edge.
 *
 * A per-axis deadzone leaves a square dead region, so a stick pushed diagonally clears it at a
 * smaller displacement than one pushed straight — the diagonal snaps. And without the rescale the
 * value jumps from 0 to the deadzone the instant it is crossed, which reads as a stick that starts
 * moving fast.
 */
test('the deadzone is radial and ramps from its edge', () => {
  const out = { x: 0, y: 0 };

  applyDeadzone(0.1, 0, 0.25, out);
  expect(out.x, 'inside the circle is nothing at all').toBe(0);
  expect(out.y).toBe(0);

  /* Straight and diagonal at the same displacement clear together, which a square region breaks. */
  const straight = { x: 0, y: 0 };
  const diagonal = { x: 0, y: 0 };
  applyDeadzone(0.3, 0, 0.25, straight);
  applyDeadzone(0.3 * Math.SQRT1_2, 0.3 * Math.SQRT1_2, 0.25, diagonal);
  expect(Math.hypot(straight.x, straight.y)).toBeCloseTo(Math.hypot(diagonal.x, diagonal.y), 10);

  /* Just past the edge is near zero, not near the deadzone. */
  applyDeadzone(0.2501, 0, 0.25, out);
  expect(out.x).toBeLessThan(0.01);

  /* And the rim is still 1. */
  applyDeadzone(1, 0, 0.25, out);
  expect(out.x).toBeCloseTo(1, 10);
});

test('the default deadzone is a number a stick can actually leave', () => {
  expect(DEFAULT_DEADZONE).toBeGreaterThan(0);
  expect(DEFAULT_DEADZONE).toBeLessThan(0.5);
});
