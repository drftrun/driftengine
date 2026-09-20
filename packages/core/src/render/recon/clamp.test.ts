import { expect, test } from 'vitest';

import { clipToNeighbourhood } from '../temporalAa.ts';
import { clipToBox, rgbToYCoCg, varianceBox, yCoCgToRgb } from './clamp.ts';

/**
 * History that disagrees with its neighbourhood is pulled in, without changing its hue.
 *
 * **Why a luminance-chrominance space, and why a variance box.** A min/max box in red, green and
 * blue is as wide as its most extreme sample, so one bright pixel in the neighbourhood lets a whole
 * ghost through; a box of the mean plus or minus a few standard deviations is as wide as the
 * neighbourhood actually varies. And luminance separated from chrominance lets the box be tight
 * where the eye is sensitive without being tight on hue.
 */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('the colour conversions round-trip, exactly for numbers a float holds', () => {
  const random = lcg(1);
  const ycocg = new Float64Array(3);
  const back = new Float64Array(3);
  for (let i = 0; i < 500; i += 1) {
    const rgb = [random() * 8, random() * 8, random() * 8] as const;
    rgbToYCoCg(ycocg, ...rgb);
    yCoCgToRgb(back, ycocg[0] as number, ycocg[1] as number, ycocg[2] as number);
    expect(back[0]).toBeCloseTo(rgb[0], 12);
    expect(back[1]).toBeCloseTo(rgb[1], 12);
    expect(back[2]).toBeCloseTo(rgb[2], 12);
  }
  /* White is all luminance, and pure red is the definition's quarter, half and minus quarter. */
  rgbToYCoCg(ycocg, 1, 1, 1);
  expect(Array.from(ycocg, (x) => x + 0)).toEqual([1, 0, 0]);
  rgbToYCoCg(ycocg, 1, 0, 0);
  expect(Array.from(ycocg)).toEqual([0.25, 0.5, -0.25]);
});

test('a history inside the box comes back unchanged', () => {
  const out = new Float64Array(3);
  clipToBox(out, [0.2, 0.1, -0.05], [0, 0, -0.1], [0.5, 0.2, 0.1]);
  expect(Array.from(out)).toEqual([0.2, 0.1, -0.05]);
});

test('A HISTORY OUTSIDE IS MOVED TO THE BOX’S BOUNDARY, and not past it', () => {
  const random = lcg(2);
  const out = new Float64Array(3);
  for (let i = 0; i < 300; i += 1) {
    const min = [random() - 1, random() - 1, random() - 1];
    const max = min.map((m) => m + 0.1 + random());
    const history = [random() * 6 - 3, random() * 6 - 3, random() * 6 - 3];
    clipToBox(out, history, min, max);
    let reach = 0;
    let outside = 0;
    for (let c = 0; c < 3; c += 1) {
      const centre = ((min[c] as number) + (max[c] as number)) / 2;
      const extent = ((max[c] as number) - (min[c] as number)) / 2;
      reach = Math.max(reach, Math.abs((out[c] as number) - centre) / extent);
      outside = Math.max(outside, Math.abs((history[c] as number) - centre) / extent);
    }
    if (outside > 1) expect(reach).toBeCloseTo(1, 12);
    else expect(reach).toBeCloseTo(outside, 12);
  }
});

test('a history on the boundary stays, and one a billionth past it is brought back', () => {
  const out = new Float64Array(3);
  clipToBox(out, [1, 0.5, 0.5], [0, 0, 0], [1, 1, 1]);
  expect(Array.from(out)).toEqual([1, 0.5, 0.5]);
  clipToBox(out, [1 + 1e-9, 0.5, 0.5], [0, 0, 0], [1, 1, 1]);
  expect(out[0]).toBeLessThanOrEqual(1 + 1e-15);
});

test('CLIPPING KEEPS THE HISTORY’S DIRECTION, where a clamp a channel at a time turns it', () => {
  /*
   * Brighter than its surroundings in one channel by a lot and in another by a little. A clamp
   * pins the first and leaves the second, which is a different hue — coloured fringing on every
   * moving edge. The clip shortens the whole offset by one ratio.
   */
  const min = [0, 0, 0];
  const max = [1, 1, 1];
  const history = [3, 0.9, 0.5];
  const clipped = new Float64Array(3);
  clipToBox(clipped, history, min, max);
  const clamped = history.map((h, c) => Math.min(Math.max(h, min[c] as number), max[c] as number));
  const direction = (v: ArrayLike<number>): number[] => {
    const d = [0, 1, 2].map((c) => (v[c] as number) - 0.5);
    const length = Math.hypot(...d);
    return d.map((x) => x / length);
  };
  const wanted = direction(history);
  const kept = direction(clipped);
  const turned = direction(clamped);
  for (let c = 0; c < 3; c += 1) expect(kept[c]).toBeCloseTo(wanted[c] as number, 12);
  const cosine = turned.reduce((sum, x, c) => sum + x * (wanted[c] as number), 0);
  expect(cosine).toBeLessThan(0.99);
});

test('the clip is the temporal resolve’s own, so the two pipelines of history agree', () => {
  const random = lcg(3);
  const out = new Float64Array(3);
  for (let i = 0; i < 300; i += 1) {
    const min: [number, number, number] = [random(), random(), random()];
    const max: [number, number, number] = [
      min[0] + random(),
      min[1] + random() * 0.01,
      min[2] + random(),
    ];
    const history: [number, number, number] = [random() * 3, random() * 3, random() * 3];
    clipToBox(out, history, min, max);
    const reference = clipToNeighbourhood([0, 0, 0], history, min, max);
    for (let c = 0; c < 3; c += 1) expect(out[c]).toBeCloseTo(reference[c], 12);
  }
});

test('a box with no extent returns its centre, which is the current colour, and never divides by zero', () => {
  const samples = Float64Array.from({ length: 27 }, (_, i) => [0.3, -0.1, 0.05][i % 3] as number);
  const min = new Float64Array(3);
  const max = new Float64Array(3);
  varianceBox(samples, 9, 1.25, min, max);
  expect(Array.from(min)).toEqual(Array.from(max));
  const out = new Float64Array(3);
  clipToBox(out, [9, 9, 9], min, max);
  expect(Array.from(out)).toEqual([0.3, -0.1, 0.05]);
  /* And a history already on the centre stays. */
  clipToBox(out, [0.3, -0.1, 0.05], min, max);
  expect(Array.from(out)).toEqual([0.3, -0.1, 0.05]);
  /* A flat channel beside a varied one still bounds the flat one. */
  clipToBox(out, [0.3, 5, 0.05], [0.3, -1, 0], [0.3, 1, 0.1]);
  expect(out[0]).toBe(0.3);
});

test('the variance box is the mean plus or minus gamma standard deviations', () => {
  /* Four samples of luminance 0, 1, 2, 3: mean 1.5 and standard deviation √1.25. */
  const samples = Float64Array.of(0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0);
  const min = new Float64Array(3);
  const max = new Float64Array(3);
  varianceBox(samples, 4, 1, min, max);
  expect(min[0]).toBeCloseTo(1.5 - Math.sqrt(1.25), 12);
  expect(max[0]).toBeCloseTo(1.5 + Math.sqrt(1.25), 12);
  expect(min[1]).toBe(0);
  expect(max[1]).toBe(0);
});

test('a wider gamma gives a wider box, monotonically, and never narrower than the mean', () => {
  const random = lcg(4);
  const samples = Float64Array.from({ length: 27 }, () => random() * 2 - 1);
  const min = new Float64Array(3);
  const max = new Float64Array(3);
  let previous = -1;
  for (let gamma = 0; gamma <= 3; gamma += 0.25) {
    varianceBox(samples, 9, gamma, min, max);
    const width = (max[0] as number) - (min[0] as number);
    expect(width).toBeGreaterThan(previous);
    expect(width).toBeGreaterThanOrEqual(0);
    previous = width;
  }
  varianceBox(samples, 9, 0, min, max);
  expect(Array.from(min)).toEqual(Array.from(max));
});

test('a variance box is narrower than the min and max box when one sample stands out', () => {
  /* Eight dark samples and one bright one: a min/max box lets anything up to the bright one through. */
  const samples = new Float64Array(27);
  for (let i = 0; i < 8; i += 1) samples[i * 3] = 0.1 + i * 0.001;
  samples[24] = 5;
  const min = new Float64Array(3);
  const max = new Float64Array(3);
  varianceBox(samples, 9, 1, min, max);
  expect(max[0]).toBeLessThan(5);
  expect(max[0]).toBeGreaterThan(0.1);
});
