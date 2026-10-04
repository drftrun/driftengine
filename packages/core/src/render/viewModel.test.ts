import { expect, test } from 'vitest';
import { VIEW_MODEL_DEPTH_SHARE, viewModelDepthRange } from './viewModel.ts';

/*
 * The near end of the range, whichever end that is. Reversed, the near plane stores 1, so the view
 * model takes the top of the range; conventional, it stores 0 and takes the bottom.
 */
test('the slice is the near end of the range under either convention', () => {
  const out: [number, number] = [0, 0];
  viewModelDepthRange(true, 0.01, out);
  expect(out[0]).toBeCloseTo(0.99, 12);
  expect(out[1]).toBe(1);
  viewModelDepthRange(false, 0.01, out);
  expect(out).toEqual([0, 0.01]);
});

test('a share outside what is meaningful is clamped, and a nonsense one is the default', () => {
  const out: [number, number] = [0, 0];
  viewModelDepthRange(true, 2, out);
  expect(out).toEqual([0, 1]);
  viewModelDepthRange(false, 0, out);
  expect(out).toEqual([0, 1e-4]);
  viewModelDepthRange(false, Number.NaN, out);
  expect(out).toEqual([0, VIEW_MODEL_DEPTH_SHARE]);
});
