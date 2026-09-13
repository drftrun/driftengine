import { expect, test } from 'vitest';
import { distanceGain, stereoPan } from './positional.ts';

test('a source fades to exactly nothing at its radius', () => {
  /*
   * The end of the curve is the load-bearing part. Physical falloff never
   * reaches zero, so every emitter in a level keeps contributing forever and a
   * route's worth of them sums into a hiss the player cannot identify or escape.
   */
  expect(distanceGain(0, 20)).toBe(1);
  expect(distanceGain(20, 20)).toBe(0);
  expect(distanceGain(1000, 20)).toBe(0);

  let previous = 2;
  for (let d = 0; d <= 25; d += 0.5) {
    const gain = distanceGain(d, 20);
    expect(gain, `distance ${d}`).toBeLessThanOrEqual(previous);
    previous = gain;
  }
});

test('a zero radius is silent rather than infinite', () => {
  // Reachable whenever a radius comes from data — a divide here would put NaN
  // into an AudioParam, which fails as silence with no error anywhere.
  expect(distanceGain(5, 0)).toBe(0);
  expect(Number.isFinite(distanceGain(5, 0))).toBe(true);
});

test('pan follows where the listener is facing, not where the world is', () => {
  /*
   * The bug this catches is a pan computed in world space: it sounds correct
   * until the player turns around, and then every source is on the wrong side
   * — which reads as the audio being broken rather than as a maths error, and
   * only shows up when someone thinks to look behind them.
   *
   * Yaw 0 faces −Z, so a source at +X starts on the right and must swap sides
   * after a half turn.
   */
  expect(stereoPan(10, 0, 0)).toBeCloseTo(1, 5);
  expect(stereoPan(10, 0, Math.PI)).toBeCloseTo(-1, 5);
  expect(stereoPan(-10, 0, 0)).toBeCloseTo(-1, 5);
});

test('a source dead ahead or dead behind is centred', () => {
  // Stereo cannot tell front from back, and pretending otherwise by biasing one
  // of them would make a source appear to slide sideways as a player walks past
  // it in a straight line.
  expect(stereoPan(0, -10, 0)).toBeCloseTo(0, 5);
  expect(stereoPan(0, 10, 0)).toBeCloseTo(0, 5);
});

test('a source at the listener does not produce a divide by zero', () => {
  expect(stereoPan(0, 0, 1.2)).toBe(0);
});
