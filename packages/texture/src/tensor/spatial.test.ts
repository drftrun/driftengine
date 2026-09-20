import { expect, test } from 'vitest';

import { attention } from './attention.ts';
import { resize } from './resize.ts';
import { conv2d, convTranspose2d, maxPool2d, patchEmbed } from './spatial.ts';

/**
 * The spatial operators, and attention, against numbers worked by hand.
 *
 * Images are channel-major, `[channels][height][width]`, one image at a time — the layout the
 * upstream frameworks call NCHW with a batch of one. Weights are in the upstream layout too, so a
 * converted checkpoint is read rather than rearranged.
 */

test('a convolution, and the same one strided and padded', () => {
  /* 1..9 in a 3 by 3, a 2 by 2 kernel of ones: each output sums a 2 by 2 window. */
  const image = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const ones = new Float32Array(4).fill(1);
  const out = new Float32Array(4);
  conv2d(out, image, 1, 3, 3, ones, null, 1, 2, 2, 1, 0);
  expect(Array.from(out)).toEqual([12, 16, 24, 28]);
  /*
   * Padding 1 and stride 2: the windows start at padded (0,0), (0,2), (2,0), (2,2), which cover
   * {1}, {2,3}, {4,7} and {5,6,8,9}.
   */
  conv2d(out, image, 1, 3, 3, ones, Float32Array.from([0]), 1, 2, 2, 2, 1);
  expect(Array.from(out)).toEqual([1, 5, 11, 28]);
});

test('A GROUPED CONVOLUTION READS ONLY ITS OWN GROUP OF CHANNELS, and a depthwise one only its own channel', () => {
  /*
   * Depthwise: two channels, 1..9 and 10..90, a kernel each — all ones for the first, only the
   * centre for the second — so the one output of each is 45 and 50, and neither sees the other.
   */
  const image = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  const kernels = Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
  const depthwise = new Float32Array(2);
  conv2d(depthwise, image, 2, 3, 3, kernels, null, 2, 3, 3, 1, 0, 2);
  expect(Array.from(depthwise)).toEqual([45, 50]);
  /*
   * Two groups over four 1×1 channels [1, 2, 3, 4]: the first output weighs channels 0 and 1 by
   * 1 and 1, 3; the second weighs channels 2 and 3 by 10 and 100, 430.
   */
  const grouped = new Float32Array(2);
  conv2d(
    grouped,
    Float32Array.from([1, 2, 3, 4]),
    4,
    1,
    1,
    Float32Array.from([1, 1, 10, 100]),
    null,
    2,
    1,
    1,
    1,
    0,
    2,
  );
  expect(Array.from(grouped)).toEqual([3, 430]);
});

test('a transposed convolution spreads each pixel over its stride', () => {
  /* Upstream layout: weight is [in][out][kh][kw]. A 2 by 2 of ones at stride 2 tiles each pixel. */
  const out = new Float32Array(16);
  convTranspose2d(
    out,
    Float32Array.from([1, 2, 3, 4]),
    1,
    2,
    2,
    new Float32Array(4).fill(1),
    null,
    1,
    2,
    2,
    2,
    0,
  );
  expect(Array.from(out)).toEqual([1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]);
});

test('a patch embedding is a strided convolution written token by token', () => {
  /* 0..15 in a 4 by 4, patches of 2, one output channel of ones: each token sums its patch. */
  const image = Float32Array.from({ length: 16 }, (_, i) => i);
  const out = new Float32Array(4);
  patchEmbed(out, image, 1, 4, 4, new Float32Array(4).fill(1), null, 1, 2);
  expect(Array.from(out)).toEqual([10, 18, 42, 50]);
});

test('BILINEAR RESIZE WITHOUT ALIGNED CORNERS IS THE UPSTREAM ONE, half-pixel and clamped below', () => {
  /*
   * [[0 1] [2 3]] to 4 by 4. A destination index i reads source (i + 0.5)/2 − 0.5: −0.25, 0.25, 0.75
   * and 1.25 — the first clamped to 0, the last reading the edge — so each axis weighs 0, 0.25, 0.75
   * and 1, and the picture is x + 2y at those points. The half-pixel convention is the resize bug
   * every port has.
   */
  const out = new Float32Array(16);
  resize(out, Float32Array.from([0, 1, 2, 3]), 1, 2, 2, 4, 4, 'bilinear', false);
  expect(Array.from(out)).toEqual([
    0, 0.25, 0.75, 1, 0.5, 0.75, 1.25, 1.5, 1.5, 1.75, 2.25, 2.5, 2, 2.25, 2.75, 3,
  ]);
});

test('bilinear resize with aligned corners puts the corners on the corners', () => {
  const out = new Float32Array(3);
  resize(out, Float32Array.from([0, 4]), 1, 1, 2, 1, 3, 'bilinear', true);
  expect(Array.from(out)).toEqual([0, 2, 4]);
});

test('BICUBIC RESIZE USES THE UPSTREAM KERNEL, a = −0.75, and clamps its taps to the border', () => {
  /*
   * [0 1 0] to five with aligned corners reads source 0, 0.5, 1, 1.5, 2. At a half the four taps
   * weigh −0.09375, 0.59375, 0.59375, −0.09375 for a = −0.75, so the peak's neighbours are 0.59375;
   * the taps below 0 and above 2 read the border.
   */
  const out = new Float32Array(5);
  resize(out, Float32Array.from([0, 1, 0]), 1, 1, 3, 1, 5, 'bicubic', true);
  expect(out[0]).toBe(0);
  expect(out[1]).toBeCloseTo(0.59375, 7);
  expect(out[2]).toBe(1);
  expect(out[3]).toBeCloseTo(0.59375, 7);
  expect(out[4]).toBe(0);
});

test('A RESIZE GIVEN ITS STEP SAMPLES WHERE THE STEP SAYS, not where the two sizes would', () => {
  /*
   * PyTorch's interpolate, handed a scale factor, samples at (i + ½)/factor − ½ — not at the ratio
   * of the sizes — and DINOv2's positional embeddings are resized that way, by (grid + 0.1)/37. On a
   * ramp 0..7 kept at eight wide, a step of ½ puts output 4 at 4.5·½ − ½ = 1.75: taps 0 to 3, a
   * quarter of the way past 1. At a = −0.75 their weights are a·t(1−t)², the near cubic at t and at
   * 1 − t, and a·t²(1−t) with t = ¾ — −0.03515625, 0.26171875, 0.87890625 and −0.10546875 — so the
   * ramp reads 1.703125, not 1.75: this cubic does not reproduce a line, only a = −0.5 does. Output
   * 6 reads the same taps one further along, 2.703125. Without a step both sit on a tap, at 4 and 6.
   */
  const ramp = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const stepped = new Float32Array(8);
  resize(stepped, ramp, 1, 1, 8, 1, 8, 'bicubic', false, [1, 0.5]);
  expect(stepped[4]).toBeCloseTo(1.703125, 6);
  expect(stepped[6]).toBeCloseTo(2.703125, 6);
  const sized = new Float32Array(8);
  resize(sized, ramp, 1, 1, 8, 1, 8, 'bicubic', false);
  expect(sized[4]).toBeCloseTo(4, 6);
});

test('ATTENTION WEIGHS A MATCHING KEY BY ITS SOFTMAX SHARE, each head on its own channels', () => {
  /*
   * Two tokens, two channels, two heads of one channel each. Head 0 compares channel 0: token 0's
   * query 1 against keys 1 and 0 scores [1, 0], a logistic σ = 0.7310585786300049, so it reads
   * 2σ + 4(1 − σ) = 4 − 2σ of channel 0's values; token 1's query 0 scores [0, 0] and reads their
   * mean, 3. Head 1 is the mirror on channel 1: 6 for token 0, and 5 + 2σ for token 1.
   */
  const q = Float32Array.from([1, 0, 0, 1]);
  const k = Float32Array.from([1, 0, 0, 1]);
  const v = Float32Array.from([2, 5, 4, 7]);
  const out = new Float32Array(4);
  attention(out, q, k, v, 2, 2, 2, 2, new Float32Array(4));
  const s = 0.7310585786300049;
  expect(out[0]).toBeCloseTo(4 - 2 * s, 6);
  expect(out[1]).toBeCloseTo(6, 6);
  expect(out[2]).toBeCloseTo(3, 6);
  expect(out[3]).toBeCloseTo(5 + 2 * s, 6);
});

test('HEADS ARE CONTIGUOUS RUNS OF CHANNELS, NOT INTERLEAVED', () => {
  /*
   * Four channels, two heads of two. Only channel 0 carries a query and a key, of 2^¼ each, so head
   * 0 — channels 0 and 1 — scores token 0 against the keys as [√2/√2, 0] = [1, 0] and weighs its
   * values by σ and 1 − σ; head 1 — channels 2 and 3 — scores nothing and reads the values' mean.
   * Interleaved heads would put channel 2 with channel 0 and weigh it by σ as well: 11 − 6σ where
   * the mean is 8. With one channel per head the two orders are the same channels, which is why the
   * case above could not tell them apart.
   */
  const a = 2 ** 0.25;
  const q = Float32Array.from([a, 0, 0, 0, 0, 0, 0, 0]);
  const k = Float32Array.from([a, 0, 0, 0, 0, 0, 0, 0]);
  const v = Float32Array.from([2, 3, 5, 7, 4, 9, 11, 13]);
  const out = new Float32Array(8);
  attention(out, q, k, v, 2, 2, 4, 2, new Float32Array(4));
  const s = 0.7310585786300049;
  const expected = [4 - 2 * s, 9 - 6 * s, 8, 10, 3, 6, 8, 10];
  for (let i = 0; i < 8; i += 1) expect(out[i]).toBeCloseTo(expected[i] as number, 5);
});

test('A BIAS PICKS EACH HEAD AND QUERY ITS OWN KEYS, over more keys than queries and a batch kept apart', () => {
  /*
   * Queries and keys all zero, so every score is its bias: zero for the one key a head and query
   * picks and −10³⁰ for the rest, whose weights are then exactly zero. Head 0 — channel 0 — picks
   * key 0 for query 0 and key 1 for query 1; head 1 — channel 1 — picks key 2, then key 0. Each of
   * the two windows reads its own values, [1, 2 | 3, 4 | 5, 6] and ten times those.
   */
  const M = -1e30;
  const bias = Float32Array.from([0, M, M, M, 0, M, M, M, 0, 0, M, M]);
  const v = Float32Array.from([1, 2, 3, 4, 5, 6, 10, 20, 30, 40, 50, 60]);
  const out = new Float32Array(8);
  attention(
    out,
    new Float32Array(8),
    new Float32Array(12),
    v,
    2,
    3,
    2,
    2,
    new Float32Array(6),
    bias,
    2,
  );
  expect(Array.from(out)).toEqual([1, 6, 3, 2, 10, 60, 30, 20]);
});

test('each window of a batch scores its queries against its own keys', () => {
  /*
   * One query of 1 in each window; window 0's keys are [1, 0] and window 1's [0, 1], so the weights
   * are σ(1) and 1 − σ(1) in one order and then the other, over values [0, 1] in both.
   */
  const s = 0.7310585786300049;
  const out = new Float32Array(2);
  attention(
    out,
    Float32Array.from([1, 1]),
    Float32Array.from([1, 0, 0, 1]),
    Float32Array.from([0, 1, 0, 1]),
    1,
    2,
    1,
    1,
    new Float32Array(2),
    null,
    2,
  );
  expect(out[0]).toBeCloseTo(1 - s, 6);
  expect(out[1]).toBeCloseTo(s, 6);
});

test('A MAX POOL KEEPS THE LARGEST OF EACH WINDOW, and a ragged edge is dropped as the upstream drops it', () => {
  /* 1..15 over 3 rows of 5, pooled 2×2 at stride 2: the windows are {1,2,6,7} and {3,4,8,9}; the
     third row and fifth column make no whole window and are dropped. A second channel, negated,
     keeps its largest — the least negative. */
  const image = Float32Array.from({ length: 30 }, (_, i) => (i < 15 ? i + 1 : -(i - 14)));
  const out = new Float32Array(4);
  maxPool2d(out, image, 2, 3, 5, 2, 2);
  expect(Array.from(out)).toEqual([7, 9, -1, -3]);
});

test('a nearest resize reads the source pixel under each destination, doubling by repeats', () => {
  /* 1..4 as 2×2, doubled: each source pixel becomes a 2×2 block. */
  const doubled = new Float32Array(16);
  resize(doubled, Float32Array.from([1, 2, 3, 4]), 1, 2, 2, 4, 4, 'nearest', false);
  expect(Array.from(doubled)).toEqual([1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]);
  /* 1..5 to 3: the scale is 5/3, so destinations 0, 1, 2 read floor(0), floor(1.67), floor(3.33). */
  const shrunk = new Float32Array(3);
  resize(shrunk, Float32Array.from([1, 2, 3, 4, 5]), 1, 1, 5, 1, 3, 'nearest', false);
  expect(Array.from(shrunk)).toEqual([1, 2, 4]);
});
