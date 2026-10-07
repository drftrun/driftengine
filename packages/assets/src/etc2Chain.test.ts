import { describe, expect, it } from 'vitest';

import { encodeEtc2Chain, etc2FormatFor, halve } from './etc2Chain.ts';

describe('a BC texture as an ETC2 chain', () => {
  it('KEEPS DATA AT ELEVEN BITS A CHANNEL, AND TAKES ALPHA ONLY WHERE A TEXEL IS LESS THAN OPAQUE', () => {
    const opaque = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(etc2FormatFor('bc4', opaque)).toBe('eac-r11');
    expect(etc2FormatFor('bc5', opaque)).toBe('eac-rg11');
    expect(etc2FormatFor('bc7', opaque)).toBe('etc2-rgb8');
    expect(etc2FormatFor('bc1', opaque)).toBe('etc2-rgb8');
    const nearly = new Uint8Array([10, 20, 30, 254, 40, 50, 60, 255]);
    expect(etc2FormatFor('bc7', nearly), 'an opaque image a BC7 encoder put at 254').toBe(
      'etc2-rgb8',
    );
    const one = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 253]);
    expect(etc2FormatFor('bc7', one), 'one texel short of that').toBe('etc2-rgba8');
    expect(etc2FormatFor('bc3', one)).toBe('etc2-rgba8');
  });

  /*
   * Two black and two white texels. As stored they average to 128; in light they average to half,
   * which is sRGB 188 (0.5029 of full light, against 187's 0.4969). Alpha is not colour and
   * averages as stored either way.
   */
  it('AVERAGES COLOUR IN LIGHT WHERE THE TEXTURE IS COLOUR, AND ALPHA AND DATA AS STORED', () => {
    const block = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
    expect(Array.from(halve(block, 2, 2, true))).toEqual([188, 188, 188, 128]);
    expect(Array.from(halve(block, 2, 2, false))).toEqual([128, 128, 128, 128]);
  });

  /* An 8x4 level is two blocks; then 4x2, 2x1 and 1x1, each one block of eight bytes. */
  it('ENCODES EVERY LEVEL DOWN TO ONE TEXEL', () => {
    const rgba = new Uint8Array(8 * 4 * 4).fill(200);
    expect(encodeEtc2Chain('etc2-rgb8', rgba, 8, 4, true).map((level) => level.length)).toEqual([
      16, 8, 8, 8,
    ]);
    expect(encodeEtc2Chain('eac-rg11', rgba, 8, 4, false).map((level) => level.length)).toEqual([
      32, 16, 16, 16,
    ]);
  });
});
