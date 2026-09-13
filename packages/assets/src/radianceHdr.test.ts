import { describe, expect, it } from 'vitest';

import { readRadianceHdr } from './radianceHdr.ts';

/** Assemble a `.hdr` from a header and a body, which is the only way to get a known answer. */
function file(header: string, body: number[]): Uint8Array {
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

const HEADER = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n';

describe('the Radiance RGBE decoder', () => {
  /*
   * **The conversion is hand-derived rather than trusted**, because every RGBE decoder on the
   * internet writes the same two lines and one of them is a factor of two out depending on whether
   * it puts the mantissa at the top or the middle of its bucket.
   *
   * Radiance's own `colr_color` is `ldexp(mantissa + 0.5, exponent - (128 + 8))`, so a byte of 128
   * at exponent 128 is `(128 + 0.5) * 2^-8` = `128.5 / 256` = 0.501953125. The half is the part
   * people drop, and dropping it makes every image about 0.2% dark — invisible on its own and
   * exactly the sort of thing that never gets found.
   */
  it('converts a mantissa and exponent to linear radiance', () => {
    const image = readRadianceHdr(file(HEADER, [128, 128, 128, 128, 64, 32, 16, 128]));
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    expect(image.data[0]).toBeCloseTo(0.501953125, 9);
    expect(image.data[1]).toBeCloseTo(0.501953125, 9);
    expect(image.data[2]).toBeCloseTo(0.501953125, 9);
    /* Second texel: 64, 32, 16 at the same exponent. 64.5/256, 32.5/256, 16.5/256. */
    expect(image.data[3]).toBeCloseTo(64.5 / 256, 9);
    expect(image.data[4]).toBeCloseTo(32.5 / 256, 9);
    expect(image.data[5]).toBeCloseTo(16.5 / 256, 9);
  });

  /*
   * **An exponent of zero is exactly black, not a very small number.** Radiance reserves it, and a
   * decoder that runs it through the same `ldexp` gives `0.5 * 2^-136`, which is denormal, nonzero,
   * and turns every black pixel of a night sky into something a prefilter will happily average.
   */
  it('treats a zero exponent as black', () => {
    const image = readRadianceHdr(file(HEADER, [255, 255, 255, 0, 0, 0, 0, 0]));
    expect(image.data[0]).toBe(0);
    expect(image.data[1]).toBe(0);
    expect(image.data[2]).toBe(0);
  });

  /*
   * **The run-length path, which is the one that matters.** Every real `.hdr` above 8 pixels wide
   * is new-style RLE, so a decoder that only handles flat scanlines passes the two tests above and
   * fails on every file anybody actually has.
   *
   * **Eight wide because narrower is not legal**, which this test got wrong on its first writing
   * and the decoder got right: Radiance only uses the new encoding at widths of 8 or more, so a
   * four-wide "RLE" file is a flat file whose first pixel happens to start with two twos. That
   * ambiguity is exactly why the marker carries the width in its third and fourth bytes.
   *
   * A new-style scanline begins `2, 2, hi, lo` where `hi<<8 | lo` is the width, then stores the
   * four channels separately rather than interleaved — which is the whole reason it compresses.
   * A count above 128 means "repeat the next byte count-128 times"; 1..128 means "copy that many".
   *
   * Here R is a run of 8 at 64, G is eight literals 1..8, B is a run of 8 at 0, E is a run of 8 at
   * 128. So texel 0 is R 64.5/256, G 1.5/256, B exactly 0, and texel 2 has G 3.5/256.
   */
  it('decodes a run-length encoded scanline', () => {
    const rle = [2, 2, 0, 8, 128 + 8, 64, 8, 1, 2, 3, 4, 5, 6, 7, 8, 128 + 8, 0, 128 + 8, 128];
    const image = readRadianceHdr(file('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n', rle));
    expect(image.width).toBe(8);
    expect(image.data[0]).toBeCloseTo(64.5 / 256, 9);
    expect(image.data[1]).toBeCloseTo(1.5 / 256, 9);
    /*
     * **A zero mantissa is not black, and that catches people.** The exponent is shared across the
     * three channels, so a blue byte of 0 at exponent 128 is still `(0 + 0.5) * 2^-8` rather than
     * zero — only a zero *exponent* is exactly black, which the test above covers. Asserting zero
     * here was this test's second wrong expectation, and the decoder was right both times.
     */
    expect(image.data[2]).toBeCloseTo(0.5 / 256, 9);
    /* Third texel, so index 2 * 3: the literal run's third byte is 3. */
    expect(image.data[6]).toBeCloseTo(64.5 / 256, 9);
    expect(image.data[7]).toBeCloseTo(3.5 / 256, 9);
    /* And the last, so a run that ends exactly on the width is covered. */
    expect(image.data[7 * 3 + 1]).toBeCloseTo(8.5 / 256, 9);
  });

  /*
   * **A refusal in words rather than a guess.** `AGENTS.md` says fail fast and loud at init with an
   * actionable message; a loader that quietly returns a black image for an unrecognised header
   * hands a scene an environment of nothing, which looks exactly like a probe that has not baked.
   */
  it('refuses a file that is not Radiance', () => {
    expect(() => readRadianceHdr(new TextEncoder().encode('GIF89a'))).toThrow(/RADIANCE/);
  });

  it('refuses a format it cannot decode', () => {
    const xyz = '#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n';
    expect(() => readRadianceHdr(file(xyz, [128, 128, 128, 128]))).toThrow(/xyze/);
  });

  /*
   * Only the `-Y height +X width` orientation is accepted, and the others are refused by name.
   * Radiance allows eight, six of which nobody has produced since the 1990s, and a decoder that
   * silently treats `+Y` as `-Y` returns an image that is upside down — which in an environment map
   * puts the sky underfoot and is the single most confusing way this can fail.
   */
  it('refuses an orientation it does not handle, by name', () => {
    const flipped = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n+Y 1 +X 1\n';
    expect(() => readRadianceHdr(file(flipped, [128, 128, 128, 128]))).toThrow(/\+Y/);
  });
});
