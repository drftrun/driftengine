import { expect, test } from 'vitest';

import { blitSource, encodesOnWrite } from './present.ts';

/*
 * **The one decision the present makes, which a wrong answer shows as every picture paler or
 * darker than the browser's.** Dawn's window renderer hands back an sRGB swap chain, which encodes
 * on write; the engine's frame is already encoded, so the blit decodes first. Into a plain swap
 * chain it copies the bytes as they are.
 */
test('AN SRGB SWAP CHAIN IS WRITTEN LINEAR, so the engine’s bytes are not encoded a second time', () => {
  expect(encodesOnWrite('bgra8unorm-srgb')).toBe(true);
  expect(encodesOnWrite('rgba8unorm-srgb')).toBe(true);
  expect(encodesOnWrite('bgra8unorm')).toBe(false);
  expect(blitSource('bgra8unorm-srgb')).toContain('return vec4f(toLinear(texel.rgb), 1.0);');
  expect(blitSource('bgra8unorm')).toContain('return vec4f(texel.rgb, 1.0);');
  expect(blitSource('bgra8unorm')).not.toContain('DECODE');
});
