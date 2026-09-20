/**
 * A PNG's texels exactly as written: straight alpha, no colour management, no canvas.
 *
 * **Why the atlas does not use a canvas.** A 2D canvas holds its pixels premultiplied in every
 * browser, so a partly transparent texel drawn into one comes back out divided and rounded, and
 * the two ways out round differently: a texture upload and `getImageData` disagreed on 5% of
 * (colour, alpha) pairs, measured in Chrome. The forward pipeline samples the first and the
 * GPU-driven one decodes the second, so one tile drew two ways. Decoded here, both read the bytes
 * the tile's author wrote, and so does a host with no canvas at all.
 *
 * **What it gives up: everything but the tiles' own shape.** 8-bit RGB or RGBA, not interlaced —
 * what all 85 tiles are. A palette, a grey image, 16 bits a channel or Adam7 is refused by name
 * rather than half decoded, and so is data that ends before its rows do. Chunk checksums are not
 * read: a damaged stream fails the inflate or the length check. The inflate is the platform's
 * `DecompressionStream`, so nothing here is a dependency; it is not a general decoder and should
 * not grow into one.
 */

export interface PngTexels {
  readonly width: number;
  readonly height: number;
  /** Four bytes a texel, top row first, straight alpha. */
  readonly rgba: Uint8ClampedArray;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The predictor the PNG specification names after Alan Paeth: whichever neighbour is nearest. */
function paeth(left: number, above: number, aboveLeft: number): number {
  const estimate = left + above - aboveLeft;
  const toLeft = Math.abs(estimate - left);
  const toAbove = Math.abs(estimate - above);
  const toAboveLeft = Math.abs(estimate - aboveLeft);
  if (toLeft <= toAbove && toLeft <= toAboveLeft) return left;
  return toAbove <= toAboveLeft ? above : aboveLeft;
}

/** Undo each row's filter in place: `raw` is the inflated stream, a filter byte before each row. */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? (out[row + x - bpp] as number) : 0;
      const above = y > 0 ? (out[row - stride + x] as number) : 0;
      const aboveLeft = x >= bpp && y > 0 ? (out[row - stride + x - bpp] as number) : 0;
      const value = raw[from + x] as number;
      let predicted: number;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = above;
      else if (filter === 3) predicted = (left + above) >> 1;
      else if (filter === 4) predicted = paeth(left, above, aboveLeft);
      else
        throw new Error(
          `[driftengine] PNG row ${y} names filter ${String(filter)}, which is none of the five`,
        );
      /* A byte array keeps the sum modulo 256, which is the arithmetic the specification states. */
      out[row + x] = value + predicted;
    }
  }
  return out;
}

export async function decodePngTexels(bytes: Uint8Array): Promise<PngTexels> {
  if (bytes.length < 8 || SIGNATURE.some((byte, at) => bytes[at] !== byte)) {
    throw new Error('[driftengine] not a PNG: the first eight bytes are not its signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, colourType, , , interlace] = body.subarray(8, 13);
      if (depth !== 8)
        throw new Error(`[driftengine] a ${String(depth)}-bit PNG is not decoded here; 8-bit only`);
      if (colourType !== 2 && colourType !== 6) {
        throw new Error(
          `[driftengine] PNG colour type ${String(colourType)} is not decoded here; RGB or RGBA only`,
        );
      }
      if (interlace !== 0) throw new Error('[driftengine] an interlaced PNG is not decoded here');
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (channels === 0) throw new Error('[driftengine] a PNG with no header');

  const joined = new Uint8Array(data.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of data) {
    joined.set(part, offset);
    offset += part.length;
  }
  const inflated = await inflate(joined);
  if (inflated.length < height * (width * channels + 1)) {
    throw new Error(
      `[driftengine] a ${width}x${height} PNG whose data ends early: ${inflated.length} bytes of rows`,
    );
  }
  const texels = unfilter(inflated, height, width * channels, channels);
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (channels === 4) {
    rgba.set(texels);
  } else {
    for (let at = 0; at < width * height; at += 1) {
      rgba[at * 4] = texels[at * 3] as number;
      rgba[at * 4 + 1] = texels[at * 3 + 1] as number;
      rgba[at * 4 + 2] = texels[at * 3 + 2] as number;
      rgba[at * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}
