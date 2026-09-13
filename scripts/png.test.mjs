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
import { decodePng, encodePng } from '../packages/core/scripts/png.mjs';

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
  ihdr[9] = channels === 4 ? 6 : 2;
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
