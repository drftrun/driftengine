import { describe, expect, test } from 'vitest';

import { decodePngTexels } from './pngTexels';

/**
 * **What this file is for: a tile's texels exactly as its author wrote them, in any host.**
 *
 * The atlas was composed on a 2D canvas, which holds its pixels premultiplied in every browser. So
 * a partly transparent texel went in straight, was multiplied by its alpha, and came back out
 * divided and rounded, and the round trip differs between a texture upload and `getImageData`
 * (measured in Chrome, one level apart on 5% of pairs). These tiles are plain 8-bit PNGs, so they
 * are decoded here instead, with the platform's own inflate.
 *
 * Every expectation below is written by hand from the PNG specification's filter definitions,
 * with the working in a comment beside it.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const be32 = (value: number) => [
  value >>> 24,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

/** A chunk with its CRC left zero, which the decoder does not read — see its header. */
function chunk(type: string, data: Uint8Array): number[] {
  return [...be32(data.length), ...Array.from(type, (c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}

async function deflate(bytes: number[]): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A PNG from rows already filtered by hand, optionally with its data split across two IDATs. */
async function png(
  width: number,
  height: number,
  rows: number[],
  { colourType = 6, depth = 8, interlace = 0, split = false } = {},
): Promise<Uint8Array> {
  const header = new Uint8Array([
    ...be32(width),
    ...be32(height),
    depth,
    colourType,
    0,
    0,
    interlace,
  ]);
  const deflated = await deflate(rows);
  const half = split ? deflated.length >> 1 : deflated.length;
  const data = [chunk('IDAT', deflated.subarray(0, half))];
  if (split) data.push(chunk('IDAT', deflated.subarray(half)));
  return new Uint8Array([
    ...SIGNATURE,
    ...chunk('IHDR', header),
    ...data.flat(),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
}

const texels = async (bytes: Promise<Uint8Array>) =>
  Array.from((await decodePngTexels(await bytes)).rgba);

describe('a tile decoded to its own bytes', () => {
  test('A TRANSPARENT TEXEL KEEPS ITS COLOUR, and a partly transparent one its exact value', async () => {
    const decoded = await decodePngTexels(await png(2, 1, [0, 10, 20, 30, 0, 200, 100, 50, 7]));
    expect([decoded.width, decoded.height]).toEqual([2, 1]);
    /* A canvas would have held (0, 0, 0, 0) and, at alpha 7, a colour on a step of about 36. */
    expect(Array.from(decoded.rgba)).toEqual([10, 20, 30, 0, 200, 100, 50, 7]);
  });

  test('THREE CHANNELS GAIN AN OPAQUE FOURTH', async () => {
    expect(await texels(png(1, 1, [0, 10, 20, 30], { colourType: 2 }))).toEqual([10, 20, 30, 255]);
  });

  test('SUB ADDS THE TEXEL TO THE LEFT', async () => {
    /* (50, 60, 70, 80) is written as its difference from (10, 20, 30, 40): 40 in each channel. */
    expect(await texels(png(2, 1, [1, 10, 20, 30, 40, 40, 40, 40, 40]))).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80,
    ]);
  });

  test('UP ADDS THE TEXEL ABOVE, modulo 256', async () => {
    const rows = [0, 10, 20, 30, 40, 50, 60, 70, 80, 2, 5, 5, 5, 5, 50, 30, 10, 246];
    /* 70 below 80 is written as 70 − 80 = −10, which is 246 in a byte. */
    expect(await texels(png(2, 2, rows))).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80, 15, 25, 35, 45, 100, 90, 80, 70,
    ]);
  });

  test('AVERAGE ADDS THE FLOOR OF THE MEAN of left and above, and the first row has zero above', async () => {
    /*
     * The first row: nothing above, so the first texel is as written and the second is written
     * less half its left neighbour — 50 − 5, 60 − 10, 70 − 15, 80 − 20.
     *
     * The second row. First texel: nothing to the left, so half of what is above — 15 − 5,
     * 25 − 10, 35 − 15, 45 − 20. Second: ⌊(15 + 50) / 2⌋ = 32, so 100 − 32 = 68; ⌊85 / 2⌋ = 42, so
     * 90 − 42 = 48; ⌊105 / 2⌋ = 52, so 80 − 52 = 28; ⌊125 / 2⌋ = 62, so 70 − 62 = 8. The odd sums
     * are the point.
     */
    const rows = [3, 10, 20, 30, 40, 45, 50, 55, 60, 3, 10, 15, 20, 25, 68, 48, 28, 8];
    expect(await texels(png(2, 2, rows))).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80, 15, 25, 35, 45, 100, 90, 80, 70,
    ]);
  });

  test('PAETH PICKS LEFT, ABOVE OR ABOVE-LEFT, and a tie between the last two goes above', async () => {
    /*
     * Above: A (10, 200, 100, 255), B (20, 30, 60, 255), E (0, 20, 0, 255).
     * Below: C (30, 190, 150, 255), D (77, 35, 90, 255), F (80, 23, 5, 255). With left a, above b
     * and above-left c, p = a + b − c and the predictor is whichever is nearest p, ties to a then b.
     *
     * - C has nothing to its left, so it predicts from above: 30 − 10, 190 − 200, 150 − 100, 0.
     * - D.r: a 30, b 20, c 10 → p 40; distances 10, 20, 30 → left, 77 − 30 = 47.
     * - D.g: a 190, b 30, c 200 → p 20; 170, 10, 180 → above, 35 − 30 = 5.
     * - D.b: a 150, b 60, c 100 → p 110; 40, 50, 10 → above-left, 90 − 100 = −10.
     * - F.r: a 77, b 0, c 20 → p 57; 20, 57, 37 → left, 80 − 77 = 3.
     * - F.g: a 35, b 20, c 30 → p 25; 10, 5, 5 → **a tie**, which goes above: 23 − 20 = 3.
     * - F.b: a 90, b 0, c 60 → p 30; 60, 30, 30 → a tie again: 5 − 0 = 5.
     * - Every alpha is 255 under 255 beside 255: p 255, all three distances 0, so 0.
     */
    const rows = [
      0, 10, 200, 100, 255, 20, 30, 60, 255, 0, 20, 0, 255, 4, 20, 246, 50, 0, 47, 5, 246, 0, 3, 3,
      5, 0,
    ];
    expect(await texels(png(3, 2, rows, { split: true }))).toEqual([
      10, 200, 100, 255, 20, 30, 60, 255, 0, 20, 0, 255, 30, 190, 150, 255, 77, 35, 90, 255, 80, 23,
      5, 255,
    ]);
    /*
     * And a tie between left and above-left, which goes left. Above: X (20, 0, 0, 255),
     * Y (30, 0, 0, 255); below: Z (0, 0, 0, 255), W (7, 0, 0, 255). Z predicts from above,
     * 0 − 20 = −20. W.r: a 0, b 30, c 20 → p 10; distances 10, 20, 10 → left, 7 − 0 = 7.
     */
    const tie = [0, 20, 0, 0, 255, 30, 0, 0, 255, 4, 236, 0, 0, 0, 7, 0, 0, 0];
    expect(await texels(png(2, 2, tie))).toEqual([
      20, 0, 0, 255, 30, 0, 0, 255, 0, 0, 0, 255, 7, 0, 0, 255,
    ]);
  });

  test('WHAT IT DOES NOT DECODE, IT REFUSES BY NAME', async () => {
    const refused = async (bytes: Promise<Uint8Array>) => decodePngTexels(await bytes);
    await expect(refused(png(1, 1, [0, 1, 0], { depth: 16 }))).rejects.toThrow(/16-bit/);
    await expect(refused(png(1, 1, [0, 0], { colourType: 3 }))).rejects.toThrow(/colour type 3/);
    await expect(refused(png(1, 1, [0, 1, 2, 3, 4], { interlace: 1 }))).rejects.toThrow(
      /interlaced/,
    );
    await expect(decodePngTexels(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a PNG/);
    /* Two rows declared and the second a byte short: refused, rather than finished with a zero. */
    await expect(refused(png(1, 2, [0, 1, 2, 3, 4, 0, 5, 6, 7]))).rejects.toThrow(/ends early/);
  });
});
