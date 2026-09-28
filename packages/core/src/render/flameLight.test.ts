import { expect, test } from 'vitest';
import { createFlame, flameFrequencyHz, updateFlame } from './flameLight.ts';

/**
 * A flame's light and plume from one description, flickering at the rate a flame that size does.
 *
 * The rates are hand-derived from the puffing law the helper states, f = 1.5 / √D: a candle's
 * 1 cm flame at 15 Hz, a brazier's 40 cm bowl at 1.5 / 0.632 = 2.37 Hz.
 */

/** Brightness samples over `seconds` at 1 kHz, as the light's red over the colour's red. */
function brightness(diameterM: number, seconds: number, seed = 0): number[] {
  const flame = createFlame({ x: 0, y: 0, z: 0, diameterM, color: [2, 1, 0.5], radius: 6, seed });
  const out: number[] = [];
  for (let i = 0; i < seconds * 1000; i++) {
    updateFlame(flame, i / 1000);
    out.push(flame.light.r / 2);
  }
  return out;
}

/** Crossings of the mean going upward, which is one a cycle of the fundamental. */
function risingCrossings(samples: readonly number[]): number {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] as number) < mean && (samples[i] as number) >= mean) count++;
  }
  return count;
}

test('A LARGER FLAME FLICKERS SLOWER, at 1.5 / √D pulses a second', () => {
  expect(flameFrequencyHz(0.01)).toBeCloseTo(15, 6);
  expect(flameFrequencyHz(0.4)).toBeCloseTo(2.372, 3);
  /*
   * Counted off the light itself over ten seconds rather than read back from the helper's own
   * number. The harmonic adds crossings, so the count is a band: the fundamental is the floor.
   */
  const candle = risingCrossings(brightness(0.01, 10));
  const brazier = risingCrossings(brightness(0.4, 10));
  expect(brazier).toBeGreaterThanOrEqual(22);
  expect(brazier).toBeLessThan(60);
  expect(candle).toBeGreaterThanOrEqual(145);
  expect(candle / brazier, 'a candle pulses several times for each of a brazier').toBeGreaterThan(
    4,
  );
});

test('THE MEAN BRIGHTNESS IS THE COLOUR ASKED FOR, and the swing is the flicker asked for', () => {
  const samples = brightness(0.4, 20);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  expect(mean).toBeCloseTo(1, 2);
  /* The default flicker is 0.18, and the two terms' amplitudes sum to one of it. */
  expect(Math.max(...samples)).toBeLessThanOrEqual(1.18 + 1e-6);
  expect(Math.min(...samples)).toBeGreaterThanOrEqual(0.82 - 1e-6);
  expect(Math.max(...samples)).toBeGreaterThan(1.12);
});

test('the light stands a third of the way up the flame and sways a few per cent of its height', () => {
  /* A 40 cm bowl: a flame 2.5 × 0.4 = 1 m tall, a light 1/3 m up, a sway of at most 6 cm. */
  const flame = createFlame({ x: 3, y: 1, z: -2, diameterM: 0.4, color: [1, 1, 1], radius: 6 });
  expect(flame.plume).toEqual({ x: 3, y: 1, z: -2, width: 0.2, height: 1 });
  expect(flame.light.sourceRadius).toBeCloseTo(0.2, 6);
  let furthest = 0;
  for (let i = 0; i < 5000; i++) {
    updateFlame(flame, i / 500);
    const dx = flame.light.x - 3;
    const dy = flame.light.y - (1 + 1 / 3);
    const dz = flame.light.z + 2;
    furthest = Math.max(furthest, Math.hypot(dx, dy, dz));
  }
  expect(furthest).toBeGreaterThan(0.02);
  expect(furthest).toBeLessThanOrEqual(0.06 * Math.sqrt(3) + 1e-6);
  /* The selection's own flicker is off, or the light would flicker twice. */
  expect(flame.light.flicker).toBe(0);
});

test("A FLAME'S NEAR PLANE CLEARS WHAT IT BURNS FROM BY THE SAME MARGIN WHEREVER IT HAS WANDERED", () => {
  /*
   * A 40 cm bowl: the light stands 1/3 m over the coals, so a near plane of 0.4 m keeps everything
   * within 0.4 − 1/3 = 0.0667 m under the coals out of the shadow map when the flame is still. The
   * map is baked from wherever the light stood, so the sway carries the cut with it: 6 cm of rise
   * left 0.0067 m, and a bowl's rim inside that band went in and out of the map as the flame moved,
   * which drew its shadow on the floor under the brazier on some bakes and not on others.
   */
  const flame = createFlame({ x: 3, y: 1, z: -2, diameterM: 0.4, color: [1, 1, 1], radius: 6 });
  let closest = Infinity;
  let highest = 0;
  for (let i = 0; i < 5000; i++) {
    updateFlame(flame, i / 500);
    const aboveCoals = flame.light.y - 1;
    highest = Math.max(highest, aboveCoals);
    closest = Math.min(closest, (flame.light.shadowNear ?? 0) - aboveCoals);
  }
  expect(highest, 'the flame did rise to the top of its sway').toBeGreaterThan(1 / 3 + 0.059);
  expect(closest).toBeGreaterThanOrEqual(0.4 - 1 / 3 - 1e-9);
});

test('two flames of one size with different seeds are out of step', () => {
  const a = brightness(0.1, 1, 1);
  const b = brightness(0.1, 1, 2);
  let apart = 0;
  for (let i = 0; i < a.length; i++)
    apart = Math.max(apart, Math.abs((a[i] as number) - (b[i] as number)));
  expect(apart).toBeGreaterThan(0.1);
});
