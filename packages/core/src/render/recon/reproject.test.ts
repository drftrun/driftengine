import { expect, test } from 'vitest';

import {
  catmullRomWeights,
  reprojectPixel,
  sampleBilinear,
  sampleHistoryBicubic,
  sampleHistoryBicubic5,
} from './reproject.ts';

/**
 * The history sampled where the surface was.
 *
 * Images here are rows from `v = 0` upward, as the rest of the reconstruction's references are;
 * texel centres sit at whole texel coordinates.
 */

function field(
  width: number,
  height: number,
  channels: number,
  at: (x: number, y: number, c: number) => number,
): Float32Array {
  const out = new Float32Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) out[(y * width + x) * channels + c] = at(x, y, c);
    }
  }
  return out;
}

test('a zero motion vector reprojects a pixel onto its own centre', () => {
  const out = new Float32Array(2);
  expect(reprojectPixel(7, 3, Float32Array.of(0, 0), 16, 9, out)).toBe(true);
  expect(Array.from(out)).toEqual([7, 3]);
});

test('a motion vector moves the pixel by its length in pixels of this target', () => {
  const out = new Float32Array(2);
  /* A tenth of the width left and a third of the height up, on a 20 by 12 target. */
  expect(reprojectPixel(10, 4, Float32Array.of(-0.1, 1 / 3), 20, 12, out)).toBe(true);
  expect(out[0]).toBeCloseTo(8, 5);
  expect(out[1]).toBeCloseTo(8, 5);
});

test('A PIXEL THAT WAS OFF THE EDGE REPORTS IT rather than clamping, which would smear the border inward', () => {
  const out = new Float32Array(2);
  expect(reprojectPixel(0, 5, Float32Array.of(-0.05, 0), 16, 9, out)).toBe(false);
  expect(reprojectPixel(15, 5, Float32Array.of(0.05, 0), 16, 9, out)).toBe(false);
  expect(reprojectPixel(5, 0, Float32Array.of(0, -0.1), 16, 9, out)).toBe(false);
  expect(reprojectPixel(5, 8, Float32Array.of(0, 0.1), 16, 9, out)).toBe(false);
  /* Half a pixel past the last centre is still on the picture, and a hair past its edge is not. */
  expect(reprojectPixel(15, 5, Float32Array.of(0.5 / 16, 0), 16, 9, out)).toBe(true);
  expect(reprojectPixel(15, 5, Float32Array.of(0.5 / 16 + 1e-6, 0), 16, 9, out)).toBe(false);
  expect(reprojectPixel(5, 5, Float32Array.of(Number.NaN, 0), 16, 9, out)).toBe(false);
});

test('THE BICUBIC WEIGHTS SUM TO ONE, so an accumulation neither brightens nor darkens the picture', () => {
  /*
   * **The defect that takes a scene slowly and uniformly grey over a hundred frames**: a filter
   * whose weights sum to 0.99 dims the history by a percent a frame, and a percent a frame is
   * invisible in any one of them.
   */
  const w = new Float64Array(4);
  for (let i = 0; i <= 100; i += 1) {
    catmullRomWeights(i / 100, w);
    expect((w[0] as number) + (w[1] as number) + (w[2] as number) + (w[3] as number)).toBeCloseTo(
      1,
      14,
    );
  }
  catmullRomWeights(0, w);
  /* `+ 0` because a weight that is zero by multiplication can be minus zero, which is still zero. */
  expect(Array.from(w, (x) => x + 0)).toEqual([0, 1, 0, 0]);
  catmullRomWeights(0.5, w);
  expect(Array.from(w)).toEqual([-0.0625, 0.5625, 0.5625, -0.0625]);
});

test('a constant history stays that constant through a hundred reprojections by fractions of a pixel', () => {
  const width = 12;
  const height = 8;
  let image = field(width, height, 3, (_x, _y, c) => [0.25, 1.5, 7][c] as number);
  const out = new Float32Array(3);
  for (let frame = 0; frame < 100; frame += 1) {
    const next = new Float32Array(image.length);
    const dx = ((frame * 0.37) % 1) - 0.5;
    const dy = ((frame * 0.61) % 1) - 0.5;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        sampleHistoryBicubic(image, x + dx, y + dy, width, height, 3, out);
        next.set(out, (y * width + x) * 3);
      }
    }
    image = next;
  }
  for (let i = 0; i < image.length; i += 3) {
    expect(image[i]).toBeCloseTo(0.25, 5);
    expect(image[i + 1]).toBeCloseTo(1.5, 5);
    expect(image[i + 2]).toBeCloseTo(7, 4);
  }
});

test('the bicubic sample at a texel centre is that texel, and between two it interpolates', () => {
  const width = 6;
  const height = 5;
  const image = field(width, height, 1, (x, y) => (x * 7 + y * 13) % 5);
  const out = new Float32Array(1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      sampleHistoryBicubic(image, x, y, width, height, 1, out);
      expect(out[0], `${String(x)},${String(y)}`).toBe(image[y * width + x]);
      sampleHistoryBicubic5(image, x, y, width, height, 1, out);
      expect(out[0]).toBeCloseTo(image[y * width + x] as number, 6);
    }
  }
  /* A linear ramp is reproduced exactly between centres, away from the clamped border. */
  const ramp = field(width, height, 1, (x) => x * 2);
  sampleHistoryBicubic(ramp, 2.3, 2, width, height, 1, out);
  expect(out[0]).toBeCloseTo(4.6, 5);
});

test('a history sample never comes back negative, because a colour cannot be', () => {
  /* Catmull-Rom's negative lobes undershoot next to a bright edge. */
  const width = 8;
  const image = field(width, 1, 1, (x) => (x === 4 ? 100 : 0));
  const out = new Float32Array(1);
  for (let x = 0; x <= 70; x += 1) {
    sampleHistoryBicubic(image, x / 10, 0, width, 1, 1, out);
    expect(out[0]).toBeGreaterThanOrEqual(0);
    sampleHistoryBicubic5(image, x / 10, 0, width, 1, 1, out);
    expect(out[0]).toBeGreaterThanOrEqual(0);
  }
});

test('THE FIVE-TAP FORM AGREES WITH THE SIXTEEN, which is why the shader may use it', () => {
  /*
   * Five bilinear taps stand for the sixteen texels by folding the middle pair of each axis into
   * one tap and dropping the corners, then renormalising. On a smooth history — which is what an
   * accumulated picture is — the corners carry almost nothing.
   */
  const width = 40;
  const height = 30;
  const image = field(
    width,
    height,
    1,
    (x, y) => 0.5 + 0.4 * Math.sin(x * 0.3) * Math.cos(y * 0.23),
  );
  const full = new Float32Array(1);
  const five = new Float32Array(1);
  let worst = 0;
  for (let i = 0; i < 400; i += 1) {
    const x = 2 + ((i * 0.618) % 1) * (width - 5);
    const y = 2 + ((i * 0.414) % 1) * (height - 5);
    sampleHistoryBicubic(image, x, y, width, height, 1, full);
    sampleHistoryBicubic5(image, x, y, width, height, 1, five);
    worst = Math.max(worst, Math.abs((full[0] as number) - (five[0] as number)));
  }
  /* 0.0009 measured on 2026-09-17, against a range of 0.8; held at 0.0012. */
  expect(worst).toBeLessThan(0.0012);
  expect(worst).toBeGreaterThan(0);
});

test('a bilinear sample clamps at the border and reads between centres', () => {
  const image = Float32Array.of(0, 10, 20, 30);
  const out = new Float32Array(1);
  sampleBilinear(image, 0.25, 0, 2, 2, 1, out);
  expect(out[0]).toBeCloseTo(2.5, 6);
  sampleBilinear(image, 0.5, 0.5, 2, 2, 1, out);
  expect(out[0]).toBeCloseTo(15, 6);
  sampleBilinear(image, -3, 5, 2, 2, 1, out);
  expect(out[0]).toBe(20);
});
