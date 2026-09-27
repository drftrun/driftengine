import { expect, test } from 'vitest';
import { cappedSize, downscaleRgba } from './downscale.ts';

test('A SIZE OVER THE CAP IS HALVED UNTIL IT FITS, keeping its aspect', () => {
  expect(cappedSize(4096, 2048, 1024)).toEqual({ width: 1024, height: 512 });
  expect(cappedSize(1024, 1024, 1024)).toEqual({ width: 1024, height: 1024 });
  expect(cappedSize(3000, 1000, 1024)).toEqual({ width: 750, height: 250 });
  /* Never below one texel on the short side. */
  expect(cappedSize(4096, 1, 1024)).toEqual({ width: 1024, height: 1 });
});

test('a 2x2 box averages its four texels, alpha included', () => {
  // prettier-ignore
  const rgba = new Uint8Array([
    0, 0, 0, 0,         100, 100, 100, 100,
    200, 200, 200, 200, 255, 255, 255, 255,
  ]);
  /* (0 + 100 + 200 + 255) / 4 = 138.75, which rounds to 139. */
  expect([...downscaleRgba(rgba, 2, 2, 1, 1)]).toEqual([139, 139, 139, 139]);
});

test('each output texel averages only the source texels it covers', () => {
  /* A 4x2 image, left half 0 and right half 200, down to 2x1: 0 and 200, nothing across. */
  // prettier-ignore
  const rgba = new Uint8Array([
    0, 0, 0, 255,  0, 0, 0, 255,  200, 200, 200, 255,  200, 200, 200, 255,
    0, 0, 0, 255,  0, 0, 0, 255,  200, 200, 200, 255,  200, 200, 200, 255,
  ]);
  expect([...downscaleRgba(rgba, 4, 2, 2, 1)]).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);
});
