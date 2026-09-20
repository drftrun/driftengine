import { expect, test } from 'vitest';

import { octInsetDir } from '../shaders/octahedral.ts';
import { PROBE_DIRECTIONS, convolveProbe, probeDirection } from './probeTrace.ts';

/**
 * What a probe asks the chain, and what it does with the answers.
 *
 * **The measurement a probe produces is an octahedral irradiance map**, because that is what
 * `gridIrradiance` already samples — `probeIrradiance(dir, layer)` in `shaders/flat/probeGrid.ts`.
 * So nothing downstream changes: only where the numbers in that map came from.
 */

const EDGE = 8;

function directions(frame: number): Float32Array {
  const out = new Float32Array(PROBE_DIRECTIONS * 3);
  const one = new Float32Array(3);
  for (let i = 0; i < PROBE_DIRECTIONS; i += 1) {
    probeDirection(i, frame, one);
    out.set(one, i * 3);
  }
  return out;
}

test('every direction is a unit vector, which the cosine weight assumes', () => {
  /*
   * **Six places, and the bound is the storage rather than the arithmetic.** A direction is
   * computed in double precision and written into a `Float32Array`, because that is what a device
   * is handed, so each component carries a single-precision rounding and the length carries three
   * of them. Asserting twelve places here would be asserting that a float holds a double.
   */
  const all = directions(0);
  for (let i = 0; i < PROBE_DIRECTIONS; i += 1) {
    const length = Math.hypot(
      all[i * 3] as number,
      all[i * 3 + 1] as number,
      all[i * 3 + 2] as number,
    );
    expect(length, `direction ${String(i)}`).toBeCloseTo(1, 6);
  }
});

test('THE DIRECTIONS COVER THE SPHERE EVENLY, which is what makes a few hundred of them enough', () => {
  /*
   * **A clumped set is a probe that has looked at part of its world and reports all of it.** Random
   * directions leave holes and pairs at this count; a spherical Fibonacci spiral does not. Binned
   * into octants, each must hold within a twentieth of an eighth.
   */
  const all = directions(0);
  const octants = new Array<number>(8).fill(0);
  for (let i = 0; i < PROBE_DIRECTIONS; i += 1) {
    const x = all[i * 3] as number;
    const y = all[i * 3 + 1] as number;
    const z = all[i * 3 + 2] as number;
    octants[(x < 0 ? 1 : 0) + (y < 0 ? 2 : 0) + (z < 0 ? 4 : 0)] += 1;
  }
  const even = PROBE_DIRECTIONS / 8;
  for (const count of octants) expect(Math.abs(count - even) / even).toBeLessThan(0.05);
  /* And their sum is near zero: a set whose mean points somewhere is a set that leans. */
  let sum = [0, 0, 0];
  for (let i = 0; i < PROBE_DIRECTIONS; i += 1) {
    sum = [
      sum[0] + (all[i * 3] as number),
      sum[1] + (all[i * 3 + 1] as number),
      sum[2] + (all[i * 3 + 2] as number),
    ];
  }
  expect(Math.hypot(...sum) / PROBE_DIRECTIONS).toBeLessThan(0.02);
});

test('consecutive frames ask different directions, so a probe converges rather than repeating', () => {
  const first = directions(0);
  const second = directions(1);
  let moved = 0;
  for (let i = 0; i < PROBE_DIRECTIONS; i += 1) {
    const d = Math.hypot(
      (first[i * 3] as number) - (second[i * 3] as number),
      (first[i * 3 + 1] as number) - (second[i * 3 + 1] as number),
      (first[i * 3 + 2] as number) - (second[i * 3 + 2] as number),
    );
    if (d > 1e-6) moved += 1;
  }
  expect(moved).toBe(PROBE_DIRECTIONS);
  /* The rotated set is still a sphere, so the second frame is as good a set as the first. */
  const second0 = Math.hypot(second[0] as number, second[1] as number, second[2] as number);
  expect(second0).toBeCloseTo(1, 6);
});

test('A CONSTANT RADIANCE CONVOLVES TO THAT CONSTANT, which is the white furnace', () => {
  /*
   * **The one test that catches a wrong normalisation.** A cosine convolution of a uniform white
   * sphere is that white, everywhere, in every texel of the map — and a factor of pi, or of two,
   * or a missing weight sum, is a room that gets brighter or darker every time the probes refresh.
   */
  const samples = new Float32Array(PROBE_DIRECTIONS * 3).fill(0.75);
  const out = new Float32Array(EDGE * EDGE * 3);
  convolveProbe(samples, directions(0), PROBE_DIRECTIONS, EDGE, out);
  for (let i = 0; i < out.length; i += 1) expect(out[i], `texel ${String(i)}`).toBeCloseTo(0.75, 4);
});

test('a single bright direction lands its lobe where it points, and nowhere opposite', () => {
  const dirs = directions(0);
  const samples = new Float32Array(PROBE_DIRECTIONS * 3);
  /* The sample nearest +y, made bright; everything else black. */
  let best = 0;
  for (let i = 1; i < PROBE_DIRECTIONS; i += 1) {
    if ((dirs[i * 3 + 1] as number) > (dirs[best * 3 + 1] as number)) best = i;
  }
  samples[best * 3] = 10;
  samples[best * 3 + 1] = 10;
  samples[best * 3 + 2] = 10;

  const out = new Float32Array(EDGE * EDGE * 3);
  convolveProbe(samples, dirs, PROBE_DIRECTIONS, EDGE, out);

  const at = (dir: readonly [number, number, number]): number => {
    let bestTexel = 0;
    let bestDot = -2;
    const decoded = new Float32Array(3);
    for (let v = 0; v < EDGE; v += 1) {
      for (let u = 0; u < EDGE; u += 1) {
        octInsetDir((u + 0.5) / EDGE, (v + 0.5) / EDGE, EDGE, decoded as unknown as Float32Array);
        const d =
          (decoded[0] as number) * dir[0] +
          (decoded[1] as number) * dir[1] +
          (decoded[2] as number) * dir[2];
        if (d > bestDot) {
          bestDot = d;
          bestTexel = v * EDGE + u;
        }
      }
    }
    return out[bestTexel * 3] as number;
  };

  expect(at([0, 1, 0])).toBeGreaterThan(at([0, -1, 0]));
  expect(at([0, -1, 0])).toBe(0);
});

test('a convolution never produces a negative channel, because radiance cannot be one', () => {
  const dirs = directions(3);
  const samples = new Float32Array(PROBE_DIRECTIONS * 3);
  for (let i = 0; i < samples.length; i += 1) samples[i] = (i % 7) * 0.1;
  const out = new Float32Array(EDGE * EDGE * 3);
  convolveProbe(samples, dirs, PROBE_DIRECTIONS, EDGE, out);
  for (const value of out) expect(value).toBeGreaterThanOrEqual(0);
});
