import { expect, test } from 'vitest';

import { areaResize } from './resample.ts';

/**
 * **The resize a model's own preparation does**, which is OpenCV's `INTER_AREA` for Depth Anything
 * 3: each output pixel is the average of the source rectangle it covers, the part-covered pixels at
 * either end weighted by how much of them is inside.
 *
 * Every number below is worked by hand from that rule; the real frames are held to OpenCV's own
 * answer by `tools/capture-weights/reference/prepare_parity.py`.
 */

const grey = (values: readonly number[]): Uint8Array => Uint8Array.from(values);

test('AN AREA RESIZE IS THE AVERAGE OF THE SOURCE RECTANGLE EACH PIXEL COVERS', () => {
  /* 4 → 2 is a plain pair-average: (10+20)/2 and (30+40)/2. */
  const halved = new Uint8Array(2);
  areaResize(grey([10, 20, 30, 40]), 4, 1, 1, halved, 2, 1);
  expect(Array.from(halved)).toEqual([15, 35]);

  /*
   * 3 → 2 covers one and a half pixels each: (2·30 + 60)/3 = 40, and (60 + 2·90)/3 = 80 — the
   * middle pixel split between them.
   */
  const stretched = new Uint8Array(2);
  areaResize(grey([30, 60, 90]), 3, 1, 1, stretched, 2, 1);
  expect(Array.from(stretched)).toEqual([40, 80]);
});

test('it averages over both axes, and takes a half to the even side as OpenCV does', () => {
  /* A 2×2 to one pixel: (10 + 20 + 30 + 41)/4 = 25.25 → 25. */
  const one = new Uint8Array(1);
  areaResize(grey([10, 20, 30, 41]), 2, 2, 1, one, 1, 1);
  expect(one[0]).toBe(25);
  /* 25.5 → 26 and 24.5 → 24: each half goes to the even side, not away from zero. */
  areaResize(grey([10, 20, 30, 42]), 2, 2, 1, one, 1, 1);
  expect(one[0]).toBe(26);
  areaResize(grey([10, 20, 30, 38]), 2, 2, 1, one, 1, 1);
  expect(one[0]).toBe(24);
});

test('every channel is resized apart, and a size it already is comes through unchanged', () => {
  /* Two channels: the first averages 10 and 30, the second 20 and 40. */
  const two = new Uint8Array(2);
  areaResize(grey([10, 20, 30, 40]), 2, 1, 2, two, 1, 1);
  expect(Array.from(two)).toEqual([20, 30]);
  const same = new Uint8Array(6);
  areaResize(grey([1, 2, 3, 4, 5, 6]), 3, 1, 2, same, 3, 1);
  expect(Array.from(same)).toEqual([1, 2, 3, 4, 5, 6]);
});
