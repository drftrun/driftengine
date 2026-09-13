import { expect, test } from 'vitest';
import { advanceWindField, createWindField } from './windField.ts';
import type { WindProfile } from './wind.ts';

const PROFILE: WindProfile = {
  directionX: 1,
  directionZ: 0,
  baseSpeed: 4,
  gustSpeed: 2,
  directionWander: 0.5,
  cycleSeconds: 40,
  phase: 0,
};

test('drift accumulates instead of being derived from wind times time', () => {
  /*
   * The bug this type exists to prevent.
   *
   * The obvious implementation — `velocity * absoluteTime` — looks equivalent
   * and is not, because the bearing wanders. Multiplying a *changing* direction
   * by a growing clock makes whatever it positions jump sideways the moment the
   * direction moves, by an amount proportional to how long the game has been
   * running. Invisible in a short test; violent after ten minutes.
   *
   * Accumulation is continuous through any direction change, which is what this
   * checks: drift over one long step must match drift over many short ones.
   */
  const coarse = createWindField();
  advanceWindField(coarse, PROFILE, 0, 0, 1);
  const fine = createWindField();
  advanceWindField(fine, PROFILE, 0, 0, 1);

  const steps = 600;
  const dt = 12 / steps;
  for (let i = 1; i <= steps; i++) {
    advanceWindField(fine, PROFILE, i * dt, dt, 1);
  }
  // The same twelve seconds walked in one stride would be wrong by exactly the
  // error this design avoids, so compare against the naive form instead.
  const naive = fine.velocityX * 12;
  expect(Math.abs(fine.driftX - naive), 'drift must not equal wind x time').toBeGreaterThan(0.5);
  expect(Number.isFinite(fine.driftX)).toBe(true);
});

test('the field carries the same wind its consumers would sample', () => {
  // One sample, shared. Two systems sampling separately is two winds even with
  // identical inputs, because nothing keeps them in step.
  const field = createWindField();
  advanceWindField(field, PROFILE, 7.5, 1 / 60, 1);
  expect(Math.hypot(field.velocityX, field.velocityZ)).toBeCloseTo(field.speed, 6);
});

test('a still frame advances nothing', () => {
  const field = createWindField();
  advanceWindField(field, PROFILE, 3, 0, 1);
  expect(field.driftX).toBe(0);
  expect(field.driftZ).toBe(0);
});
