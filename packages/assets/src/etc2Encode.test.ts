import { describe, expect, it } from 'vitest';

import { decodeEtc2, encodeEtc2 } from './etc2Encode.ts';

/** A 64x64 image: a colour gradient each way, crossed by a sharper band, alpha a ramp. */
function picture(): Uint8Array {
  const size = 64;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      const band = Math.abs(y - 32) < 3 ? 60 : 0;
      rgba[at] = Math.min(255, x * 4 + band);
      rgba[at + 1] = Math.min(255, y * 4);
      rgba[at + 2] = 128 + Math.round(60 * Math.sin(x / 7));
      rgba[at + 3] = (x * 3 + y) & 255;
    }
  }
  return rgba;
}

/** The root-mean-square difference of one channel, and its worst. */
function difference(a: Uint8Array, b: Uint8Array, channel: number): { rms: number; worst: number } {
  let sum = 0;
  let worst = 0;
  let count = 0;
  for (let i = channel; i < a.length; i += 4) {
    const d = (a[i] as number) - (b[i] as number);
    sum += d * d;
    worst = Math.max(worst, Math.abs(d));
    count += 1;
  }
  return { rms: Math.sqrt(sum / count), worst };
}

describe('ETC2 and EAC encoding', () => {
  /*
   * The bounds are what this encoder measured, a little loosened: ETC1's modes on a gradient and a
   * band, and EAC on a ramp. An encoder that chose a worse table, split or base — or packed a texel's
   * steps into another's place — comes out well past them.
   */
  it('ENCODES COLOUR THAT DECODES WITHIN A FEW STEPS OF ITS SOURCE', () => {
    const source = picture();
    const blocks = encodeEtc2('etc2-rgb8', source, 64, 64);
    expect(blocks.length, 'eight bytes a 4x4 block').toBe(16 * 16 * 8);
    const back = decodeEtc2('etc2-rgb8', blocks, 64, 64);
    for (let c = 0; c < 3; c++) {
      const { rms } = difference(source, back, c);
      /* Measured at 4.8, 4.2 and 4.0. */
      expect(rms, `channel ${c}`).toBeLessThan(6);
    }
  });

  it('ENCODES ALPHA BESIDE COLOUR WITHIN A STEP OR TWO', () => {
    const source = picture();
    const blocks = encodeEtc2('etc2-rgba8', source, 64, 64);
    expect(blocks.length, 'sixteen bytes a block').toBe(16 * 16 * 16);
    const back = decodeEtc2('etc2-rgba8', blocks, 64, 64);
    const { rms, worst } = difference(source, back, 3);
    expect(rms).toBeLessThan(2);
    expect(worst).toBeLessThan(8);
    expect(difference(source, back, 1).rms, 'and the colour as before').toBeLessThan(6);
  });

  it('ENCODES ONE AND TWO CHANNELS OF DATA AT ELEVEN BITS', () => {
    const source = picture();
    const back = decodeEtc2('eac-rg11', encodeEtc2('eac-rg11', source, 64, 64), 64, 64);
    expect(difference(source, back, 0).rms).toBeLessThan(2);
    expect(difference(source, back, 1).rms).toBeLessThan(2);
    const red = decodeEtc2('eac-r11', encodeEtc2('eac-r11', source, 64, 64), 64, 64);
    expect(difference(source, red, 0).rms).toBeLessThan(2);
  });

  /* A value a block holds throughout comes back as it went, through EAC's table with a zero step. */
  it('STORES A BLOCK OF ONE VALUE EXACTLY', () => {
    const flat = new Uint8Array(16 * 4);
    for (let i = 0; i < 16; i++) flat.set([90, 140, 200, 77], i * 4);
    const back = decodeEtc2('eac-rg11', encodeEtc2('eac-rg11', flat, 4, 4), 4, 4);
    expect(Array.from(back.slice(0, 2))).toEqual([90, 140]);
    const alpha = decodeEtc2('etc2-rgba8', encodeEtc2('etc2-rgba8', flat, 4, 4), 4, 4);
    expect(alpha[3]).toBe(77);
  });

  /*
   * A 2x2 level is one block, its other twelve texels the edge repeated: so a level of two
   * brightnesses of one colour, which one half of a block can hold, comes back close.
   */
  it('MAKES A LEVEL SMALLER THAN A BLOCK ONE BLOCK, ITS EDGE REPEATED', () => {
    const tiny = new Uint8Array([
      200, 100, 50, 255, 210, 110, 60, 255, 190, 90, 40, 255, 200, 100, 50, 255,
    ]);
    const blocks = encodeEtc2('etc2-rgba8', tiny, 2, 2);
    expect(blocks.length).toBe(16);
    const back = decodeEtc2('etc2-rgba8', blocks, 2, 2);
    for (let c = 0; c < 3; c++) expect(difference(tiny, back, c).worst).toBeLessThan(12);
  });
});
