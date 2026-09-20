import { expect, test } from 'vitest';

import {
  DEPTH_PIXEL_MEAN,
  DEPTH_PIXEL_STD,
  prepareDepthFrame,
  prepareOwlv2Frame,
  prepareSam2Frame,
  prepareSamFrame,
} from './prepare.ts';

/** The statistics each preparation normalises by: SAM's in 0–255, CLIP's in 0–1. */
const MEAN_255 = [123.675, 116.28, 103.53] as const;
const STD_255 = [58.395, 57.12, 57.375] as const;
const MEAN_1 = [0.48145466, 0.4578275, 0.40821073] as const;
const STD_1 = [0.26862954, 0.26130258, 0.27577711] as const;

/**
 * **A frame as Depth Anything 3's own `InputProcessor` prepares it**: the longest side to 504, each
 * side then rounded to the nearest whole patch of 14, the bytes divided by 255 and normalised.
 * The real frames are held to the upstream's prepared ones by
 * `tools/capture-weights/reference/prepare_parity.ts`; these are the rules around them.
 */

/** A frame of one colour, which the resizes leave alone and the normalisation acts on. */
function flat(width: number, height: number, red: number, green: number, blue: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let at = 0; at < width * height; at += 1) {
    rgba.set([red, green, blue, 255], at * 4);
  }
  return rgba;
}

test('THE LONGEST SIDE COMES TO THE MODEL’S SIZE AND EACH SIDE TO WHOLE PATCHES', () => {
  /* 1208 × 680 scales by 504/1208 to 504 × 284, and 284 is nearer 280 than 294. */
  const wide = prepareDepthFrame(flat(1208, 680, 10, 20, 30), 1208, 680);
  expect([wide.width, wide.height]).toEqual([504, 280]);
  expect(wide.pixels.length).toBe(3 * 504 * 280);
  /* A square frame is 504 × 504, which is already 36 patches each way. */
  const square = prepareDepthFrame(flat(700, 700, 0, 0, 0), 700, 700);
  expect([square.width, square.height]).toEqual([504, 504]);
  /*
   * 1008 × 377 halves to 504 × 188.5, and a size rounds as Python's `round` does — to the even
   * side, 188, which is nearer 182 than 196. Taken away from zero it would be 189, which is nearer
   * 196, and the frame would be refused instead of prepared.
   */
  const half = prepareDepthFrame(flat(1008, 377, 0, 0, 0), 1008, 377);
  expect([half.width, half.height]).toEqual([504, 182]);
  /* And the same frame stood up: a width rounds by the same rule as a height. */
  const portrait = prepareDepthFrame(flat(377, 1008, 0, 0, 0), 377, 1008);
  expect([portrait.width, portrait.height]).toEqual([182, 504]);
});

test('a side that would round up to a whole patch is refused, since that resize is not written', () => {
  /* 1176 × 672 scales to 504 × 288, and 288 is nearer 294 than 280 — an upscale. */
  expect(() => prepareDepthFrame(flat(1176, 672, 0, 0, 0), 1176, 672)).toThrow(/cubic resize/);
  /* And a frame already smaller than the model's size would have to grow to reach it. */
  expect(() => prepareDepthFrame(flat(400, 300, 0, 0, 0), 400, 300)).toThrow(
    /smaller than the model's 504/,
  );
});

test('the bytes are divided by 255 and normalised by ImageNet’s mean and deviation', () => {
  const grey = prepareDepthFrame(flat(1208, 680, 128, 64, 255), 1208, 680);
  const cells = 504 * 280;
  const expected = [128, 64, 255].map((value, channel) =>
    Math.fround(
      (Math.fround(value / 255) - (DEPTH_PIXEL_MEAN[channel] as number)) /
        (DEPTH_PIXEL_STD[channel] as number),
    ),
  );
  /* One colour everywhere, so every cell of a channel is that channel's value. */
  for (let channel = 0; channel < 3; channel += 1) {
    expect(grey.pixels[channel * cells]).toBe(expected[channel]);
    expect(grey.pixels[channel * cells + cells - 1]).toBe(expected[channel]);
  }
  /* 128/255 is above the mean and 64/255 below it, so the first is positive and the second not. */
  expect(grey.pixels[0]).toBeGreaterThan(0);
  expect(grey.pixels[cells]).toBeLessThan(0);
});

test('MOBILESAM TAKES THE LONGEST SIDE TO ITS SQUARE AND PADS THE REST WITH ZEROS', () => {
  /* 1208 × 680 scales by 1024/1208 to 1024 × 576, rounded up at a half rather than to the even. */
  const prepared = prepareSamFrame(flat(1208, 680, 200, 100, 50), 1208, 680, MEAN_255, STD_255);
  expect([prepared.width, prepared.height]).toEqual([1024, 576]);
  expect(prepared.pixels.length).toBe(3 * 1024 * 1024);
  const inside = Math.fround((200 - (MEAN_255[0] as number)) / (STD_255[0] as number));
  expect(prepared.pixels[0]).toBe(inside);
  /* 1208 × 690 scales to 584.9 high, which rounds up: a side is rounded, not truncated. */
  const rounded = prepareSamFrame(flat(1208, 690, 10, 10, 10), 1208, 690, MEAN_255, STD_255);
  expect([rounded.width, rounded.height]).toEqual([1024, 585]);
  /* Its last row is inside and the row after it is the padding, which is a zero and not a colour. */
  expect(prepared.pixels[575 * 1024]).toBe(inside);
  expect(prepared.pixels[576 * 1024]).toBe(0);
  /* And the padding is to the right of the last column too. */
  expect(prepared.pixels[1023]).toBe(inside);
});

test('SAM 2.1 takes a frame to its square whatever its shape, each axis by its own factor', () => {
  const prepared = prepareSam2Frame(flat(1208, 680, 30, 60, 90), 1208, 680);
  expect([prepared.width, prepared.height]).toEqual([1024, 1024]);
  /* Every pixel is the one colour, so the resize leaves it and the normalisation is the whole sum. */
  const expected = Math.fround(
    (Math.fround(30 / 255) - (DEPTH_PIXEL_MEAN[0] as number)) / (DEPTH_PIXEL_STD[0] as number),
  );
  expect(prepared.pixels[0]).toBeCloseTo(expected, 6);
  expect(prepared.pixels[1024 * 1024 - 1]).toBeCloseTo(expected, 6);
});

test('OWLv2 blurs by as much as the reduction asks, which is what stops a thin line vanishing', () => {
  /*
   * One white column in a black frame, at 604. Prepared at 120 the frame shrinks tenfold, and the
   * bilinear that follows samples about ten source columns apart — 608.5 at output column 60 —
   * so the line falls between samples and an unblurred resize loses it entirely. The blur is the
   * antialiasing: its deviation is (10.07 − 1)/2, four and a half source columns, which carries the
   * line to the sample that would have missed it.
   */
  const line = new Uint8Array(1208 * 680 * 4);
  for (let y = 0; y < 680; y += 1) {
    for (let x = 0; x < 1208; x += 1) {
      const value = x === 604 ? 255 : 0;
      line.set([value, value, value, 255], (y * 1208 + x) * 4);
    }
  }
  const black = Math.fround((0 - (MEAN_1[0] as number)) / (STD_1[0] as number));
  const small = prepareOwlv2Frame(line, 1208, 680, MEAN_1, STD_1, 120);
  expect(small.pixels[12 * 120 + 60]).toBeGreaterThan(black + 0.05);
});

test('OWLv2 pads to a square before it resizes, so what is past the frame is a zero blurred in', () => {
  const prepared = prepareOwlv2Frame(flat(1208, 680, 255, 255, 255), 1208, 680, MEAN_1, STD_1);
  expect([prepared.width, prepared.height]).toEqual([960, 960]);
  /* White inside: (1 − mean)/deviation. */
  const white = Math.fround((1 - (MEAN_1[0] as number)) / (STD_1[0] as number));
  expect(prepared.pixels[0]).toBeCloseTo(white, 5);
  /* The padding is a zero before it is normalised, so it lands well below the white. */
  const black = Math.fround((0 - (MEAN_1[0] as number)) / (STD_1[0] as number));
  expect(prepared.pixels[959 * 960]).toBeCloseTo(black, 5);
  /* 680 of 1208 rows are the frame, so the boundary sits at 960 · 680/1208 ≈ 540. */
  expect(prepared.pixels[530 * 960 + 10]).toBeCloseTo(white, 4);
  expect(prepared.pixels[545 * 960 + 10]).toBeCloseTo(black, 4);
});
