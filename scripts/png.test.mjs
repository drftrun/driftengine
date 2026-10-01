/**
 * The decoder, against every row filter a PNG may use.
 *
 * **This earns its place because a mis-decode is invisible.** The failure is not an exception, it
 * is pixel values that are wrong by a small amount in a pattern that looks exactly like a
 * rendering change, arriving in the one tool the repository uses to decide whether a rendering
 * change happened. Filter 4 in particular has three plausible wrong implementations, all of which
 * agree with the right one on the first row and the first column.
 *
 * The fixtures are built here rather than checked in, so the expectations are hand-written pixel
 * values rather than something produced by the code under test.
 */
import { crc32, deflateSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng, rgbaOf } from '../packages/core/scripts/png.mjs';

/** A PNG around already-filtered rows: `rows` is one `[filter, ...bytes]` per line. */
function buildPng(width, height, channels, rows) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    /* The CRC is not checked by the reader, so it is left zero rather than implemented. */
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows.map((row) => Buffer.from(row))))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('an unfiltered image decodes to the bytes it was given', () => {
  const png = buildPng(2, 1, 3, [[0, 10, 20, 30, 40, 50, 60]]);
  const image = decodePng(png);
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.equal(image.channels, 3);
  assert.deepEqual([...image.pixels], [10, 20, 30, 40, 50, 60]);
});

test('sub, up and average each predict from the neighbour they name', () => {
  /*
   * Row 0 is literal. Row 1 is Sub, so each sample adds the one a pixel to its left, and the
   * first pixel of the row adds nothing. Row 2 is Up, adding the sample above. Row 3 is Average,
   * adding the floor of the mean of left and above.
   *
   * Hand-derived:
   *   row 0:  10 20 30 | 40 50 60
   *   row 1:  Sub, residuals 1 2 3 | 4 5 6  ->  1 2 3 | 5 7 9
   *   row 2:  Up,  residuals 0 0 0 | 1 1 1  ->  1 2 3 | 6 8 10
   *   row 3:  Avg, residuals 0 0 0 | 0 0 0  ->  0 1 1 (floor of (0+1)/2 etc), then
   *           left is 0,1,1 and above is 6,8,10, so 3 4 5
   */
  const png = buildPng(2, 4, 3, [
    [0, 10, 20, 30, 40, 50, 60],
    [1, 1, 2, 3, 4, 5, 6],
    [2, 0, 0, 0, 1, 1, 1],
    [3, 0, 0, 0, 0, 0, 0],
  ]);
  const { pixels } = decodePng(png);
  assert.deepEqual([...pixels.subarray(0, 6)], [10, 20, 30, 40, 50, 60]);
  assert.deepEqual([...pixels.subarray(6, 12)], [1, 2, 3, 5, 7, 9]);
  assert.deepEqual([...pixels.subarray(12, 18)], [1, 2, 3, 6, 8, 10]);
  assert.deepEqual([...pixels.subarray(18, 24)], [0, 1, 1, 3, 4, 5]);
});

test('paeth picks the neighbour the gradient points at, including the corner', () => {
  /*
   * The case that separates a correct Paeth from the three that pass on simpler data: the second
   * pixel of the second row, where left, above and above-left all differ.
   *
   * Row 0 literal: 10 10 10 | 200 200 200
   * Row 1 Paeth, residuals all 0, so each sample is exactly the predictor.
   *   pixel 0: a = 0, b = 10, c = 0. p = 10, so pa = 10, pb = 0, pc = 10 -> b = 10.
   *   pixel 1: a = 10, b = 200, c = 10. p = 200, pa = 190, pb = 0, pc = 190 -> b = 200.
   */
  const png = buildPng(2, 2, 3, [
    [0, 10, 10, 10, 200, 200, 200],
    [4, 0, 0, 0, 0, 0, 0],
  ]);
  const { pixels } = decodePng(png);
  assert.deepEqual([...pixels.subarray(6, 12)], [10, 10, 10, 200, 200, 200]);
});

/*
 * **A bought model's single-channel maps are greyscale PNGs**, measured at 50 of 135 in one
 * photogrammetry-matched scene: roughness, metalness and height, each one channel. The reader
 * refused them, so the baker's texture cap carried every one at full size and the native host could
 * not draw them at all.
 */
test('A GREYSCALE PNG DECODES, and widens to RGBA as grey with an opaque alpha', () => {
  /* Two rows, the second predicting from its left neighbour one *byte* back, as a grey pixel is. */
  const png = buildPng(2, 2, 1, [
    [0, 0, 200],
    [1, 10, 20],
  ]);
  const decoded = decodePng(png);
  assert.equal(decoded.channels, 1);
  assert.deepEqual([...decoded.pixels], [0, 200, 10, 30]);
  assert.deepEqual(
    [...rgbaOf(decoded).rgba],
    [0, 0, 0, 255, 200, 200, 200, 255, 10, 10, 10, 255, 30, 30, 30, 255],
  );
});

test('a grey-and-alpha PNG keeps its alpha when it widens', () => {
  const png = buildPng(1, 1, 2, [[0, 90, 40]]);
  assert.deepEqual([...rgbaOf(decodePng(png)).rgba], [90, 90, 90, 40]);
});

test('an RGB PNG still widens with its three channels in place', () => {
  const png = buildPng(1, 1, 3, [[0, 1, 2, 3]]);
  assert.deepEqual([...rgbaOf(decodePng(png)).rgba], [1, 2, 3, 255]);
});

/*
 * **A bought city's maps are a tenth palette PNGs**, measured at 219 of 2,447 in one source: colour
 * type 3 at eight bits and below, and greyscale masks at one, two and four. The reader refused every
 * one, and the baker turned each into a material with no colour map at all, drawn white.
 */

/** A PNG of any depth and colour type around already-filtered rows, with chunks before IDAT. */
function buildAny(width, height, depth, colorType, rows, chunks = []) {
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(body).copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...chunks.map(([type, body]) => chunk(type, body)),
    chunk('IDAT', deflateSync(Buffer.concat(rows.map((row) => Buffer.from(row))))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('A PALETTE PNG DECODES TO ITS COLOURS, with tRNS as alpha and opaque past its end', () => {
  /* Entry 0 red at alpha 128, entry 1 blue with no tRNS entry, so opaque. Pixels: 1, then 0. */
  const png = buildAny(
    2,
    1,
    8,
    3,
    [[0, 1, 0]],
    [
      ['PLTE', [255, 0, 0, 0, 0, 255]],
      ['tRNS', [128]],
    ],
  );
  const decoded = decodePng(png);
  assert.equal(decoded.channels, 4);
  assert.deepEqual([...decoded.pixels], [0, 0, 255, 255, 255, 0, 0, 128]);
});

test('a two-bit palette is un-filtered as packed bytes, then unpacked high bits first', () => {
  /*
   * Width 3 at two bits is one byte a row, two bits of it padding.
   *   row 0 indices 3 0 2 -> 11 00 10 00 = 0xC8, literal.
   *   row 1 indices 1 2 3 -> 01 10 11 00 = 0x6C, written as Up: 0x6C - 0xC8 = 0xA4 (mod 256).
   * A reader that unpacked before un-filtering would add index to index and read nonsense.
   */
  const png = buildAny(
    3,
    2,
    2,
    3,
    [
      [0, 0xc8],
      [2, 0xa4],
    ],
    [['PLTE', [0, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90]]],
  );
  const decoded = decodePng(png);
  assert.equal(decoded.channels, 3);
  assert.deepEqual(
    [...decoded.pixels],
    [70, 80, 90, 0, 0, 0, 40, 50, 60, 10, 20, 30, 40, 50, 60, 70, 80, 90],
  );
});

test('one-bit grey widens each bit to black or white, across a byte boundary', () => {
  /* Bits 1011000011 over two bytes: 0b10110000, 0b11000000. */
  const decoded = decodePng(buildAny(10, 1, 1, 0, [[0, 0xb0, 0xc0]]));
  assert.equal(decoded.channels, 1);
  assert.deepEqual([...decoded.pixels], [255, 0, 255, 255, 0, 0, 0, 0, 255, 255]);
});

test('sixteen-bit RGB keeps the high byte, and a filter steps a whole six-byte pixel', () => {
  /*
   * Pixel 0 literal: 0x1234 0xABCD 0xFF00. Pixel 1 is Sub with every residual 1, so each of its
   * bytes is the byte six back plus one: 0x1335 0xACCE 0x0001 — and 0xFF + 1 wraps to 0x00.
   */
  const png = buildAny(2, 1, 16, 2, [[1, 0x12, 0x34, 0xab, 0xcd, 0xff, 0x00, 1, 1, 1, 1, 1, 1]]);
  const decoded = decodePng(png);
  assert.equal(decoded.channels, 3);
  assert.deepEqual([...decoded.pixels], [0x12, 0xab, 0xff, 0x13, 0xac, 0x00]);
});

test('a grey PNG with a tRNS key turns that one grey transparent and keeps the rest opaque', () => {
  const decoded = decodePng(buildAny(2, 1, 8, 0, [[0, 200, 100]], [['tRNS', [0, 200]]]));
  assert.equal(decoded.channels, 2);
  assert.deepEqual([...decoded.pixels], [200, 0, 100, 255]);
});

test('a palette index past the end of PLTE is named, not read from beyond it', () => {
  const png = buildAny(1, 1, 8, 3, [[0, 5]], [['PLTE', [1, 2, 3]]]);
  assert.throws(() => decodePng(png), /index 5/);
});

test('interlacing is still refused by name', () => {
  const png = buildAny(1, 1, 8, 2, [[0, 1, 2, 3]]);
  png[16 + 12] = 1;
  assert.throws(() => decodePng(png), /interlaced/);
});

test('what it cannot read, it names rather than guesses', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
  const bad = buildPng(1, 1, 3, [[9, 0, 0, 0]]);
  assert.throws(() => decodePng(bad), /filter 9/);
});

/*
 * The encoder, which exists because the baker had no way to write one.
 *
 * A block-compressed DDS is decoded so its maps survive the bake, and the result was embedded as
 * `CODEC_RAW` because nothing on the Node side wrote a PNG — 21 textures of one shipped car went
 * from 3.6 MB of source to 11.6 MB in the container. Both ends are lossless, so the test that
 * matters is that the pixels come back identical; the size is the reason to do it and is asserted
 * separately.
 *
 * **The CRC is asserted here even though `decodePng` never reads one.** A round trip through this
 * file's own reader would pass with every CRC left at zero, and a browser would refuse the same
 * bytes at `createImageBitmap` — so the reader that this repository controls is exactly the wrong
 * oracle for the half of the format that a browser enforces and it does not.
 */

test('a PNG this encodes decodes back to the same pixels, byte for byte', () => {
  const width = 23;
  const height = 17;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    /* Deliberately not a gradient: values that defeat a filter as often as they suit one. */
    rgba[i * 4] = (i * 37) & 0xff;
    rgba[i * 4 + 1] = (i * 11 + 3) & 0xff;
    rgba[i * 4 + 2] = 255 - ((i * 5) & 0xff);
    rgba[i * 4 + 3] = i % 7 === 0 ? 0 : 255;
  }
  const png = encodePng(width, height, rgba);
  const back = decodePng(png);
  assert.equal(back.width, width);
  assert.equal(back.height, height);
  assert.equal(back.channels, 4);
  assert.deepEqual([...back.pixels], [...rgba]);
});

test('a one-pixel image round trips, which is the fallback texture the baker writes', () => {
  const png = encodePng(1, 1, Buffer.from([255, 255, 255, 255]));
  const back = decodePng(png);
  assert.deepEqual([...back.pixels], [255, 255, 255, 255]);
});

test('every chunk carries the CRC a browser will check, over its type and its body', () => {
  const png = encodePng(4, 4, Buffer.alloc(64, 200));
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.deepEqual([...png.subarray(4, 8)], [0x0d, 0x0a, 0x1a, 0x0a]);

  let at = 8;
  const seen = [];
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    seen.push(type);
    /* The CRC covers the type and the body and not the length, which is the usual mistake. */
    const covered = png.subarray(at + 4, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), crc32(covered), `${type} CRC`);
    at += 12 + length;
    if (type === 'IEND') break;
  }
  assert.deepEqual(seen, ['IHDR', 'IDAT', 'IEND']);
  assert.equal(at, png.length, 'no bytes past IEND');
});

test('the header states 8-bit RGBA, filter method 0 and no interlacing', () => {
  const png = encodePng(3, 2, Buffer.alloc(24, 1));
  const ihdr = png.subarray(16, 16 + 13);
  assert.equal(ihdr.readUInt32BE(0), 3);
  assert.equal(ihdr.readUInt32BE(4), 2);
  assert.equal(ihdr[8], 8, 'bit depth');
  assert.equal(ihdr[9], 6, 'colour type: RGBA');
  assert.equal(ihdr[10], 0, 'compression method');
  assert.equal(ihdr[11], 0, 'filter method');
  assert.equal(ihdr[12], 0, 'interlace');
});

test('an image that compresses is written far smaller than its raw bytes', () => {
  /* A smooth gradient, which is what a normal or an occlusion map mostly is. */
  const width = 256;
  const height = 256;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      rgba[at] = x;
      rgba[at + 1] = y;
      rgba[at + 2] = (x + y) >> 1;
      rgba[at + 3] = 255;
    }
  }
  const png = encodePng(width, height, rgba);
  assert.ok(
    png.length < rgba.length / 10,
    `a gradient should compress by more than 10x, got ${rgba.length} to ${png.length}`,
  );
  assert.deepEqual([...decodePng(png).pixels], [...rgba], 'and still lossless');
});

test('it refuses a buffer that is not the size the dimensions state', () => {
  assert.throws(() => encodePng(2, 2, Buffer.alloc(15)), /16 bytes/);
});
