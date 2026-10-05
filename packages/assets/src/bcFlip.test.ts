import { expect, it } from 'vitest';

import { decodeBc } from './bcDecode.ts';
import { flipBc5Green } from './bcFlip.ts';

/** One BC5 block: a red half that must come through untouched, then the green half given. */
function block(green: readonly number[]): Uint8Array {
  return new Uint8Array([90, 30, 0x24, 0x92, 0x49, 0x24, 0x92, 0x49, ...green]);
}

/** Green of texels 0, 1, 2 and 8 — the last from the second run of indices — decoded. */
function greens(bytes: Uint8Array): number[] {
  const rgba = decodeBc('bc5', 4, 4, bytes);
  return [rgba[1], rgba[5], rgba[9], rgba[33]] as number[];
}

/*
 * **Turned over in the blocks, exactly, so a DirectX normal map stays compressed.** 255 − g of a
 * BC4 half is its endpoints swapped and turned over, and its indices renumbered to match — which
 * keeps the endpoint order, and so the mode. Texels 0, 1 and 2 take indices 0, 1 and 2, the first
 * index byte 0 | 1 << 3 | 2 << 6 = 0x88; texel 8, the first of the second run, takes 2 as well.
 *
 * Six values (200 > 40): 200, 40 and (6·200 + 40)/7 = 177.1 → 177, which turn over to 55, 215, 78.
 */
it('A BC5 NORMAL MAP’S GREEN IS TURNED OVER IN THE BLOCKS, EVERY TEXEL TO 255 − g', () => {
  const six = block([200, 40, 0x88, 0, 0, 2, 0, 0]);
  expect(greens(six)).toEqual([200, 40, 177, 177]);
  expect(greens(flipBc5Green(six))).toEqual([55, 215, 78, 78]);
});

/*
 * Four values (40 ≤ 200) keep their hard 0 and 255, which swap. Texels 0, 1 and 2 take 6 (0), 7 (255)
 * and 2, which is (4·40 + 200)/5 = 72; turned over, 255, 0 and 183. First byte 6 | 7 << 3 | 2 << 6.
 * Texel 8 takes index 0, the endpoint 40, which turns over to 215.
 */
it('a four-value half keeps its mode, and its hard 0 and 255 swap', () => {
  const four = block([40, 200, 0xbe, 0, 0, 0, 0, 0]);
  expect(greens(four)).toEqual([0, 255, 72, 40]);
  expect(greens(flipBc5Green(four))).toEqual([255, 0, 183, 215]);
});

/* Red is the other half of the normal and must not move; and turning over twice is no change. */
it('leaves red alone, and turning over twice gives back the bytes it was given', () => {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 151 + 7) & 0xff;
  const once = flipBc5Green(bytes);
  for (let b = 0; b < 4; b++) {
    expect(Array.from(once.subarray(b * 16, b * 16 + 8))).toEqual(
      Array.from(bytes.subarray(b * 16, b * 16 + 8)),
    );
  }
  expect(Array.from(flipBc5Green(once))).toEqual(Array.from(bytes));
});
