import { expect, test } from 'vitest';
import { ProbeGrid } from '../probeGrid.ts';
import { cascadesForGrid, probesTheFieldReaches } from './fieldReach.ts';

/**
 * Whether the traced field reaches the probes it is meant to light.
 *
 * The field is composed around the camera, a cascade of half-extent `radius` and each one out twice
 * as wide, and it fades out over a tenth of the outermost cascade's width at each face. So the part
 * a probe can trust is 0.8 of the outermost half-extent, and every expectation below is that
 * arithmetic done by hand.
 */

function grid(counts: [number, number, number], spacing: [number, number, number]): ProbeGrid {
  return new ProbeGrid({ origin: [0, 0, 0], spacing, counts });
}

test('A GRID LONGER THAN THE FIELD GETS THE CASCADES THAT REACH ALL OF IT, from anywhere inside it', () => {
  /*
   * Eight probes 2.6 m apart across 18.2 m, the widest step 5.8 m: the outermost cascade must hold
   * 18.2 + 5.8 = 24 m within its trusted 0.8, so a half-extent of 30 m. From a 4 m inner cascade
   * that is 4, 8, 16, 32: four cascades, where three reached 16 m and left the far end untraced.
   */
  expect(cascadesForGrid(grid([8, 2, 4], [2.6, 5.8, 3.2]), 4, 3, 6)).toBe(4);
  /*
   * And the two parts of that sum each decide a case: three probes 5 m apart need (10 + 5) / 0.8 =
   * 18.75 m, so four. Without the fading faces 15 m fits in 16, and without the step 12.5 m does.
   */
  expect(cascadesForGrid(grid([3, 1, 1], [5, 1, 1]), 4, 3, 6)).toBe(4);
});

test('a small room keeps the cascades it had, and a huge grid stops at the most allowed', () => {
  /* 2.4 m of probes and a 1.2 m step need 3.6 / 0.8 = 4.5 m: two cascades, so the three kept. */
  expect(cascadesForGrid(grid([3, 2, 3], [1.2, 1.2, 1.2]), 4, 3, 6)).toBe(3);
  /* 60 m and a 20 m step need (60 + 20) / 0.8 = 100 m, over 64 and within 4 · 2^5 = 128: six. */
  expect(cascadesForGrid(grid([4, 1, 1], [20, 1, 1]), 4, 3, 6)).toBe(6);
  /* 200 m and a 40 m step need 300 m, which would be eight; six is the most, so six. */
  expect(cascadesForGrid(grid([6, 1, 1], [40, 1, 1]), 4, 3, 6)).toBe(6);
});

test('A PROBE THE FIELD DOES NOT REACH IS NOT TRACED, rather than told the world is sky', () => {
  /*
   * Probes at x = 0, 7 and 14 against an outermost cascade from -16 to 16: the band is a tenth of
   * 32 m, so the field is trusted to 12.8 m, and the probe at 14 m, inside the cascade but in its
   * fading face, is dropped from the schedule.
   */
  const probes = grid([3, 1, 1], [7, 1, 1]);
  const scheduled = Int32Array.from([0, 1, 2]);
  const bounds = [-16, -16, -16, 16, 16, 16];
  expect(probesTheFieldReaches(probes, scheduled, 3, bounds)).toBe(2);
  expect(Array.from(scheduled.subarray(0, 2))).toEqual([0, 1]);
});
