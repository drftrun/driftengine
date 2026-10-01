/**
 * The city's weather: rain by the hour, as its scripts schedule it, and how wet the streets are.
 *
 * **Rain between the schedule's keys**, linear, and round midnight from the last key to the first:
 * wet nights, dry afternoons — 0.85 at midnight, nothing from noon to four, 0.9 at eleven.
 *
 * **Wetness rises at 0.32 and dries at 0.09 an hour of the city's day**, in full rain; half the rain
 * wets half as fast. The scripts give the two rates and not their unit. An hour keeps a night's rain
 * on the ground through the morning and dries the streets by late afternoon, which is what the
 * schedule reads as describing; a second would dry a soaked street in eleven. **What would make it
 * wrong** is a capture of the reference drying faster than that.
 */

/** The scripts' `WeatherKey`s: an hour, and how hard it rains then. */
const SCHEDULE: readonly (readonly [number, number])[] = [
  [0, 0.85],
  [3, 0.55],
  [6, 0.3],
  [9, 0.08],
  [12, 0],
  [16, 0],
  [19, 0.25],
  [21, 0.6],
  [23, 0.9],
];
const WET_UP = 0.32;
const DRY = 0.09;

/** How hard it rains at an hour, 0 to 1. */
export function rainAt(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < SCHEDULE.length; i++) {
    const [h0, r0] = SCHEDULE[i] as readonly [number, number];
    const [h1, r1] =
      i + 1 < SCHEDULE.length
        ? (SCHEDULE[i + 1] as readonly [number, number])
        : [24, (SCHEDULE[0] as readonly [number, number])[1]];
    if (h >= h0 && h <= h1) return r0 + ((r1 - r0) * (h - h0)) / (h1 - h0);
  }
  return 0;
}

export class Wetness {
  constructor(public value = 0) {}

  /** `hours` of the city's day at `rain`. */
  step(rain: number, hours: number): void {
    this.value =
      rain > 0
        ? Math.min(1, this.value + WET_UP * rain * hours)
        : Math.max(0, this.value - DRY * hours);
  }
}
