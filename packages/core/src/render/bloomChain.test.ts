import { describe, expect, it } from 'vitest';

import {
  BLOOM_LEVELS,
  BLOOM_RESPONSE_FLOATS,
  defaultBloomResponse,
  resolveBloomResponse,
} from './bloomChain.ts';

describe('the bloom response', () => {
  /* Every frame before 4.8.6 subtracted the threshold and added every octave in white. */
  it('IS THE SUBTRACTION AND WHITE WHEN NOTHING IS ASKED, SO NO FRAME MOVES', () => {
    const out = defaultBloomResponse();
    expect(out).toHaveLength(1 + BLOOM_LEVELS * 3);
    expect(Array.from(out)).toEqual([0, ...Array.from({ length: BLOOM_LEVELS * 3 }, () => 1)]);
  });

  it('carries a ramp, and a tint a level finest first, white past the last one named', () => {
    const out = new Float32Array(BLOOM_RESPONSE_FLOATS);
    resolveBloomResponse({ ramp: 2, tints: [0.5, 0.25, 0, 2, 2, 2] }, out);
    expect(out[0]).toBe(2);
    expect(Array.from(out.subarray(1, 7))).toEqual([0.5, 0.25, 0, 2, 2, 2]);
    expect(Array.from(out.subarray(7))).toEqual(Array.from({ length: 12 }, () => 1));
  });

  it('reads a ramp that is not a positive number as the subtraction, and a bad channel as none', () => {
    const out = new Float32Array(BLOOM_RESPONSE_FLOATS);
    resolveBloomResponse({ ramp: -1, tints: [Number.NaN, -3, 1] }, out);
    expect(out[0]).toBe(0);
    expect(Array.from(out.subarray(1, 4))).toEqual([0, 0, 1]);
  });

  it('refuses tints that are not whole colours, or more levels than the pyramid has', () => {
    const out = new Float32Array(BLOOM_RESPONSE_FLOATS);
    expect(() => resolveBloomResponse({ tints: [1, 1] }, out)).toThrow(/whole colours/);
    expect(() =>
      resolveBloomResponse({ tints: new Array((BLOOM_LEVELS + 1) * 3).fill(1) }, out),
    ).toThrow(/whole colours/);
  });

  it('goes back to the subtraction and white on null', () => {
    const out = new Float32Array(BLOOM_RESPONSE_FLOATS);
    resolveBloomResponse({ ramp: 3, tints: [0, 0, 0] }, out);
    resolveBloomResponse(null, out);
    expect(Array.from(out)).toEqual(Array.from(defaultBloomResponse()));
  });
});
