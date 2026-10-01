import { describe, expect, it } from 'vitest';

import { CityClock, nightAt } from './clock';
import { Wetness, rainAt } from './weather';

const round = (x: number): number => Math.round(x * 1e4) / 1e4 + 0;

describe("the city's day and weather", () => {
  it('AN HOUR IS FIFTY SECONDS FROM SIX IN THE MORNING, AND T SKIPS ONE, ROUND MIDNIGHT', () => {
    const clock = new CityClock();
    expect(clock.hour).toBe(6);
    /* Fifty seconds of sixtieths is an hour. */
    for (let i = 0; i < 3000; i++) clock.tick(1 / 60);
    expect(round(clock.hour)).toBe(7);
    const late = new CityClock(23.5);
    late.skip();
    expect(late.hour).toBe(0.5);
    late.tick(25);
    expect(round(late.hour)).toBe(1);
  });

  it('NIGHT FALLS OVER THE DUSK RAMP AND LIFTS OVER THE DAWN ONE', () => {
    /* Dusk from 17.6 to 19.2, dawn from 5.4 to 7.0: halfway through either, half night. */
    expect([nightAt(12), nightAt(0), nightAt(18.4), nightAt(6.2)].map(round)).toEqual([
      0, 1, 0.5, 0.5,
    ]);
    expect([nightAt(17.6), nightAt(19.2), nightAt(5.4), nightAt(7)].map(round)).toEqual([
      0, 1, 1, 0,
    ]);
    /* A quarter into either ramp: dusk a quarter dark, dawn three quarters still dark. */
    expect([nightAt(18), nightAt(5.8)].map(round)).toEqual([0.25, 0.75]);
  });

  it('RAIN FOLLOWS THE HOURLY SCHEDULE BETWEEN ITS KEYS, ROUND MIDNIGHT TOO', () => {
    /* 0.85 at midnight to 0.55 at three; 0.9 at eleven to 0.85 at midnight; dry from noon to four. */
    expect([rainAt(0), rainAt(1.5), rainAt(23.5), rainAt(14), rainAt(20)].map(round)).toEqual([
      0.85, 0.7, 0.875, 0, 0.425,
    ]);
  });

  it('THE STREETS WET AT 0.32 AN HOUR IN FULL RAIN AND DRY AT 0.09 AN HOUR WITHOUT IT', () => {
    const wet = new Wetness();
    for (let i = 0; i < 60; i++) wet.step(1, 1 / 60);
    expect(round(wet.value)).toBe(0.32);
    /* In half rain, half as fast. */
    const half = new Wetness();
    for (let i = 0; i < 60; i++) half.step(0.5, 1 / 60);
    expect(round(half.value)).toBe(0.16);
    /* Two dry hours from half wet. */
    const drying = new Wetness(0.5);
    for (let i = 0; i < 120; i++) drying.step(0, 1 / 60);
    expect(round(drying.value)).toBe(0.32);
    /* Never past soaked, never past dry. */
    const soaked = new Wetness(0.99);
    soaked.step(1, 1);
    const dry = new Wetness(0.01);
    dry.step(0, 1);
    expect([soaked.value, dry.value]).toEqual([1, 0]);
  });
});
