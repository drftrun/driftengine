/**
 * Enough of a PNG reader to compare two frames, with no dependency.
 *
 * A screenshot arrives as 8-bit RGBA, filter method 0, not interlaced, which is what every
 * browser produces and is exactly what this handles. Anything else is refused by name rather
 * than guessed at, because a reader that quietly mis-decodes produces pixel differences that
 * look like a rendering change.
 *
 * `zlib` is Node's own, so this costs nothing to have.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const SIGNATURE = 0x89504e47;

/** `{ width, height, channels, pixels }`, pixels being row-major 8-bit samples. */
export function decodePng(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== SIGNATURE) throw new Error('not a PNG');

  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];

  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (depth !== 8) throw new Error(`bit depth ${depth}, only 8 is handled`);
      if (interlace !== 0) throw new Error('interlaced PNG, not handled');
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (channels === 0) throw new Error(`colour type ${colorType}, only 2 and 6 are handled`);
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    /* length, type, body, CRC. */
    at += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('no IHDR');

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);

  /*
   * Un-filtering, which is the whole of the format that is not zlib. Each row states one of five
   * predictors and the residual against it; `a` is the sample one pixel left, `b` the one above,
   * `c` the one above and left, and all three are zero outside the image rather than wrapped.
   */
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    for (let i = 0; i < stride; i++) {
      const value = raw[from + i];
      const a = i >= channels ? pixels[to + i - channels] : 0;
      const b = y > 0 ? pixels[to - stride + i] : 0;
      const c = i >= channels && y > 0 ? pixels[to - stride + i - channels] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + a;
      else if (filter === 2) restored = value + b;
      else if (filter === 3) restored = value + ((a + b) >> 1);
      else if (filter === 4) restored = value + paeth(a, b, c);
      else throw new Error(`row ${y} states filter ${filter}, which is not a PNG filter`);
      pixels[to + i] = restored & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

/** The Paeth predictor: whichever of the three neighbours the gradient points closest to. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function readPng(path) {
  return decodePng(readFileSync(path));
}

/**
 * Write 8-bit RGBA as a PNG. The other half of this file, and it arrived nine months later.
 *
 * **Why the baker needs it.** A block-compressed DDS is decoded so a bought model's maps survive
 * the bake, and the decoded surface was then embedded as `CODEC_RAW`, because nothing on the Node
 * side could write an image back. Measured on one shipped car's level of detail B: 21 textures,
 * 3.6 MB of source, 11.6 MB of RGBA in a 22.8 MB container. Both ends are lossless, so this is a
 * smaller file and not a worse one.
 *
 * **`node:zlib` is the whole dependency**, which is what makes this affordable — it runs offline,
 * in a tool, once per bake, and a game never links it.
 *
 * Colour type 6 only, because the one caller decodes to RGBA and a second colour type is a second
 * set of filter arithmetic to get wrong for no measured gain.
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const expected = stride * height;
  if (rgba.length !== expected) {
    throw new Error(`${width}x${height} RGBA is ${expected} bytes, got ${rgba.length}`);
  }
  const pixels = Buffer.isBuffer(rgba)
    ? rgba
    : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);

  /*
   * One filter chosen per row by the sum of absolute residuals, which is the heuristic the format's
   * own specification suggests and every encoder uses. It is a heuristic and not an optimum: it
   * assumes the deflate that follows is cheapest on the bytes nearest zero, which is true often
   * enough to be worth the five passes and is not a claim about any particular image.
   */
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    const out = y * (stride + 1);
    let bestFilter = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? pixels[row + i - 4] : 0;
        const b = y > 0 ? pixels[prev + i] : 0;
        const c = i >= 4 && y > 0 ? pixels[prev + i - 4] : 0;
        const residual = (pixels[row + i] - predict(filter, a, b, c)) & 0xff;
        /* Distance from zero in both directions: 255 is a residual of one, not of 255. */
        score += residual < 128 ? residual : 256 - residual;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
      }
    }
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? pixels[row + i - 4] : 0;
      const b = y > 0 ? pixels[prev + i] : 0;
      const c = i >= 4 && y > 0 ? pixels[prev + i - 4] : 0;
      candidate[i] = (pixels[row + i] - predict(bestFilter, a, b, c)) & 0xff;
    }
    raw[out] = bestFilter;
    candidate.copy(raw, out + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The predictor a filter subtracts, with `predict(4, …)` being Paeth and `predict(0, …)` nothing. */
function predict(filter, a, b, c) {
  if (filter === 0) return 0;
  if (filter === 1) return a;
  if (filter === 2) return b;
  if (filter === 3) return (a + b) >> 1;
  return paeth(a, b, c);
}

/**
 * Length, type, body, CRC.
 *
 * **The CRC covers the type and the body and not the length**, and it is the one part of this that
 * `decodePng` above cannot check the work of, because it does not read one. A browser does, at
 * `createImageBitmap`, and refuses the file — so an encoder verified only against this file's own
 * reader would pass every test and produce images nothing else would open.
 */
function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** A decoded PNG as four bytes a pixel, whether it was written with three channels or four. */
export function rgbaOf(decoded) {
  const count = decoded.width * decoded.height;
  if (decoded.channels === 4)
    return { width: decoded.width, height: decoded.height, rgba: decoded.pixels };
  const rgba = new Uint8Array(count * 4);
  for (let at = 0; at < count; at += 1) {
    rgba[at * 4] = decoded.pixels[at * decoded.channels];
    rgba[at * 4 + 1] = decoded.pixels[at * decoded.channels + 1];
    rgba[at * 4 + 2] = decoded.pixels[at * decoded.channels + 2];
    rgba[at * 4 + 3] = 255;
  }
  return { width: decoded.width, height: decoded.height, rgba };
}

/** A rectangle of a four-byte-a-pixel image, as a new image. */
export function crop(image, rect) {
  const rgba = new Uint8Array(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.y + y) * image.width + rect.x) * 4;
    rgba.set(image.rgba.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return { width: rect.width, height: rect.height, rgba };
}
