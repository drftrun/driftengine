import { expect, test } from 'vitest';

import { paddedRow, unpad } from './readback.ts';

/*
 * **A copy out of a texture pads every row to 256 bytes**, and a frame read without undoing it is
 * sheared: each row starts a little further along than the last. The stage at a 1280 by 720 capture
 * is 1280 wide, which happens to need no padding — so the arithmetic is pinned at a width that does.
 */
test('ROWS ARE COPIED AT A STRIDE OF 256 BYTES, and packed again before the frame is used', () => {
  expect(paddedRow(1280)).toBe(5120);
  expect(paddedRow(3)).toBe(256);
  expect(paddedRow(65)).toBe(512);
  const width = 3;
  const padded = new Uint8Array(256 * 2);
  padded.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 0);
  padded.set([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], 256);
  expect(Array.from(unpad(padded, width, 2))).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  ]);
});
