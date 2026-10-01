/**
 * The city's day: twenty minutes long, starting at six in the morning, as its scripts set it
 * (`dayLength 1200`, `startHour 6`), and T skipping an hour.
 *
 * **Night by the hour, not by the sun**: the scripts ramp every night light over a dusk from 17.6
 * to 19.2 and a dawn from 5.4 to 7.0, and the lamps and windows follow that ramp whatever the sky
 * is doing — which is what a city's lighting timetable is. `nightAt` is that ramp, linear, as the
 * scripts' own offsets place each light along it.
 *
 * Advanced by the fixed step and never by a clock, so a held frame holds its hour.
 */

/** Seconds an hour of the city's day lasts. */
export const HOUR_SEC = 50;
export const START_HOUR = 6;
const DUSK: readonly [number, number] = [17.6, 19.2];
const DAWN: readonly [number, number] = [5.4, 7.0];

export class CityClock {
  constructor(public hour = START_HOUR) {}

  /** Advance `dt` seconds of the city's time. */
  tick(dt: number): void {
    this.hour = wrap(this.hour + dt / HOUR_SEC);
  }

  /** An hour on. */
  skip(): void {
    this.hour = wrap(this.hour + 1);
  }
}

/** How far into night an hour is: 0 by day, 1 by night, ramped across dusk and dawn. */
export function nightAt(hour: number): number {
  const h = wrap(hour);
  if (h >= DUSK[1] || h <= DAWN[0]) return 1;
  if (h >= DAWN[1] && h <= DUSK[0]) return 0;
  if (h > DUSK[0]) return (h - DUSK[0]) / (DUSK[1] - DUSK[0]);
  return 1 - (h - DAWN[0]) / (DAWN[1] - DAWN[0]);
}

const wrap = (hour: number): number => ((hour % 24) + 24) % 24;
