/**
 * Where and when the Sponza day is: the real courtyard's site, one midsummer date, and a loop that
 * spends its time on the hours worth watching.
 *
 * **A real place and a real day, so the sun is not tuned.** Dubrovnik, 42.64° N, 18.11° E, on
 * 27 June 2026. That is two days before a full moon, which stands 25° up at 23:00 and gives the
 * night a light to read by. The sun climbs to 68° at noon, is at 8° by 19:30 and sets about 20:22,
 * and blue hour is roughly 20:40 to 21:20. Measured through the engine's own `celestialStateAt`,
 * not taken from an almanac.
 *
 * **North points along +x**, so the noon sun comes from the −x end, down the courtyard's length,
 * and lands on the floor; the evening sun comes low from −z, across the short axis, and lights the
 * +z gallery. This is a choice about the model, not a fact about the building. With north along +z
 * the floor had no sun at noon at all: a 68° sun across an 8 m opening 19 m deep shadows all of it,
 * which is the real courtyard's geometry and not the day this scene exists to show.
 *
 * **The loop is not uniform in time.** A day at one speed would spend a fifth of its length on the
 * dull middle of the morning and blink through the minutes at dusk, which are why the scene exists.
 * The table spends a sixth of the loop on the day, a quarter on the long fall to sunset, a sixth on
 * blue hour, a quarter on the night, and the rest on dawn.
 */
import type { CelestialSite } from '../../packages/core/src/index';

export const SITE: CelestialSite = { latitudeDeg: 42.64, longitudeDeg: 18.11, utcOffsetHours: 2 };
/** Midnight UTC at the start of 27 June 2026. */
const DAY_UTC_MS = Date.UTC(2026, 5, 27);
/** Where the world's north points, from +x toward +z, as `celestialStateAt` takes it: +x. */
export const NORTH = 0;
export const LOOP_SEC = 120;

/** Seconds into the loop and the local hour at that moment. The last entry wraps to the first. */
const HOURS: readonly (readonly [number, number])[] = [
  [0, 10],
  [20, 15.5],
  [50, 20.3],
  [70, 21.4],
  [100, 28],
  [120, 34],
];

/** The local hour at `loopSec` seconds into the loop. Past 24 it is the next morning. */
export function hourAtLoop(loopSec: number): number {
  const t = ((loopSec % LOOP_SEC) + LOOP_SEC) % LOOP_SEC;
  for (let i = 1; i < HOURS.length; i++) {
    const [s1, h1] = HOURS[i] as readonly [number, number];
    if (t <= s1) {
      const [s0, h0] = HOURS[i - 1] as readonly [number, number];
      return h0 + ((h1 - h0) * (t - s0)) / (s1 - s0);
    }
  }
  return (HOURS[0] as readonly [number, number])[1];
}

/** The loop time that shows `hour`, for a held hour's camera. Hours before 10 are the next dawn. */
export function loopAtHour(hour: number): number {
  const h = hour < 10 ? hour + 24 : hour;
  for (let i = 1; i < HOURS.length; i++) {
    const [s0, h0] = HOURS[i - 1] as readonly [number, number];
    const [s1, h1] = HOURS[i] as readonly [number, number];
    if (h >= h0 && h <= h1) return s0 + ((s1 - s0) * (h - h0)) / (h1 - h0);
  }
  return 0;
}

/** The UTC instant of a local hour on the scene's day, which is what a stated zone asks for. */
export function instantOf(hour: number): number {
  return DAY_UTC_MS + (hour - (SITE.utcOffsetHours ?? 0)) * 3_600_000;
}

/** `hh:mm`, for the readout. */
export function clockText(hour: number): string {
  const wrapped = ((hour % 24) + 24) % 24;
  const h = Math.floor(wrapped);
  const m = Math.floor((wrapped - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
