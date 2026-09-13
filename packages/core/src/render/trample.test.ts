import { expect, test } from 'vitest';
import { TRAMPLE_SLOTS, TrampleField } from './trample.ts';

const RADIUS = 1;

test('a press flattens what is under it and nothing across the field', () => {
  const field = new TrampleField();
  field.press(10, 0, 10);

  expect(field.strengthAt(10, 0, 10, RADIUS), 'under the foot').toBeGreaterThan(0.9);
  expect(field.strengthAt(10.5, 0, 10, RADIUS), 'half a metre away').toBeGreaterThan(0);
  expect(field.strengthAt(14, 0, 10, RADIUS), 'four metres away').toBe(0);
});

test('height counts, so a character on a bridge does not comb the grass below', () => {
  /*
   * The reason the field is 3D rather than a ground plane. A canal has a towpath
   * with a bridge over it and foliage on both, and a press that ignored height would
   * flatten the grass beside the water every time somebody crossed above it.
   */
  const field = new TrampleField();
  field.press(0, 6, 0);
  expect(field.strengthAt(0, 0, 0, RADIUS)).toBe(0);
});

test('grass comes back up, and takes about as long as it was given', () => {
  // Pressed foliage fades back to its original position after a few seconds.
  const field = new TrampleField(1);
  field.press(0, 0, 0);
  for (let i = 0; i < 30; i++) field.update(1 / 60);

  const half = field.strengthAt(0, 0, 0, RADIUS);
  expect(half, 'half way back after half the recovery').toBeGreaterThan(0.3);
  expect(half).toBeLessThan(0.7);

  for (let i = 0; i < 40; i++) field.update(1 / 60);
  expect(field.strengthAt(0, 0, 0, RADIUS), 'still flat after the recovery').toBe(0);
});

test('standing still spends one slot, so a trail survives it', () => {
  /*
   * The failure this prevents: a character who stops in a field would claim a new slot
   * every frame and wipe the eight-press trail behind them within a fifth of a
   * second. Nearby presses merge instead, which is also the honest model — standing
   * in one place presses that place harder, not eight places once.
   */
  const field = new TrampleField();
  const trail: number[] = [];
  for (let i = 0; i < TRAMPLE_SLOTS; i++) {
    // A metre apart: further than the merge radius, so each is its own press.
    field.press(i * 1.2, 0, 0);
    trail.push(i * 1.2);
  }
  // Then stand still for a second, well past the number of slots in frames.
  for (let i = 0; i < 60; i++) {
    field.press(0, 0, 0);
    field.update(1 / 60);
  }

  const stillPressed = trail.filter((x) => field.strengthAt(x, 0, 0, RADIUS) > 0.05);
  expect(stillPressed.length, `only ${stillPressed.length} of the trail survived`).toBeGreaterThan(
    TRAMPLE_SLOTS / 2,
  );
});

test('a running trail keeps its most recent steps when it runs out of slots', () => {
  // More presses than slots, which is what a character crossing a field is. The oldest
  // go; the last few — the ones a player is looking at — stay.
  const field = new TrampleField();
  for (let i = 0; i < TRAMPLE_SLOTS * 3; i++) field.press(i * 1.5, 0, 0);

  const last = (TRAMPLE_SLOTS * 3 - 1) * 1.5;
  expect(field.strengthAt(last, 0, 0, RADIUS), 'the newest step').toBeGreaterThan(0.9);
  expect(field.strengthAt(0, 0, 0, RADIUS), 'the first step, long gone').toBe(0);
});
