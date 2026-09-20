import { expect, test } from 'vitest';

import { ADDRESS_MODE, DECODE_OP } from '@driftengine/texture';

import { averageLevel, halfLevel, linearImage, srgbImage } from './imageProgram';

/**
 * **The two ways a picture becomes a program here**, and the chains under them. The sRGB chain's
 * two tests were the atlas's and moved with the function when the city's facade needed it too.
 */

test('A COARSER LEVEL AVERAGES LIGHT RATHER THAN BYTES', () => {
  /*
   * Two greys in a checker, 200 and 40, are 149 in sRGB once their light is averaged. The bytes
   * average to 120; decoding with no curve and re-encoding with one gives 182. **Greys and not black
   * and white**, because both ends of the curve are fixed points of it: a checker of 0 and 255
   * comes out at 188 whether or not the texels were ever decoded, and a test of that passed with
   * the decode removed.
   */
  const checker = Uint8Array.from([
    200, 200, 200, 255, 40, 40, 40, 255, 40, 40, 40, 255, 200, 200, 200, 255,
  ]);
  expect([...halfLevel(checker, 2)]).toEqual([149, 149, 149, 255]);
});

test('AND A TRANSPARENT TEXEL LENDS IT NO COLOUR, only its absence', () => {
  /*
   * A leaf tile is half holes, and a canvas hands a hole back as black. Averaged as it is, every
   * leaf darkens toward its edges the further away it is; weighted by coverage it keeps its colour
   * and only its coverage falls.
   */
  const leaf = Uint8Array.from([200, 40, 30, 255, 0, 0, 0, 0, 200, 40, 30, 255, 0, 0, 0, 0]);
  expect([...halfLevel(leaf, 2)]).toEqual([200, 40, 30, 128]);
});

test('A QUANTITY IS AVERAGED AS IT IS, because its bytes are the value', () => {
  /* An emissive mask of full and none is half, where the sRGB chain would say 188. */
  const mask = Uint8Array.from([
    255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
  ]);
  expect([...averageLevel(mask, 2)]).toEqual([128, 128, 128, 255]);
  expect([...halfLevel(mask, 2)]).not.toEqual([128, 128, 128, 255]);
});

test('BOTH CARRY EVERY LEVEL TO ONE TEXEL, and the address mode they were asked for', () => {
  const edge = 16;
  const level0 = new Uint8Array(edge * edge * 4).fill(200);
  for (const [program, nodes] of [
    [srgbImage(level0, edge, ADDRESS_MODE.CENTRE_WRAP), 4],
    [linearImage(level0, edge, ADDRESS_MODE.CENTRE_WRAP), 1],
  ] as const) {
    const levels = program.blocks?.[0]?.levels ?? [];
    expect(levels.length).toBe(5);
    expect(levels[4]?.length).toBe(4);
    expect(program.graph.addressMode).toBe(ADDRESS_MODE.CENTRE_WRAP);
    expect(program.graph.count).toBe(nodes);
    expect(program.graph.nodes[0]).toBe(DECODE_OP.SAMPLE_BLOCK);
  }
  expect(srgbImage(level0, edge, ADDRESS_MODE.CENTRE_CLAMP).graph.addressMode).toBe(
    ADDRESS_MODE.CENTRE_CLAMP,
  );
});

test('an image that is not a power-of-two square of RGBA is refused, by what it was', () => {
  expect(() => linearImage(new Uint8Array(12 * 12 * 4), 12, ADDRESS_MODE.CENTRE_WRAP)).toThrow(
    /power-of-two square/,
  );
  expect(() => srgbImage(new Uint8Array(15), 16, ADDRESS_MODE.CENTRE_WRAP)).toThrow(/15 bytes/);
});
