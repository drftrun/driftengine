/**
 * What an image is, from its own first bytes. One responsibility: identify, never decode.
 *
 * The baker embeds compressed images untouched, so it never decodes one — but the format
 * stores a codec and a size beside each payload, and both have to come from somewhere. They
 * come from here, by reading the few bytes every container puts at its front for exactly
 * this purpose.
 *
 * **Why the size is stored at all, when the decoder will report it anyway.** A loader that
 * has to decode before it can size anything cannot budget: it learns that a level carries
 * 400 MB of texture only after it has allocated it. Reading it here costs a dozen bytes per
 * texture and lets a consumer refuse, downscale or stream before committing.
 *
 * **The extension is not consulted.** A `.jpg` that is really a PNG is common enough to be
 * unremarkable, and every one of these formats identifies itself unambiguously in its first
 * bytes. Trusting the name over the content is how a file that would have loaded fine gets
 * refused, and how one that cannot be decoded gets embedded anyway.
 */

import { CODEC_JPEG, CODEC_PNG, CODEC_WEBP, DrftError } from '@driftengine/drft';

export interface ImageInfo {
  readonly codec: number;
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[at + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[at + i] ?? 0);
  return out;
}

/**
 * JPEG's size lives in a start-of-frame marker, and finding it means walking the segments.
 *
 * There is no fixed offset: a file carries any number of leading segments (EXIF, colour
 * profiles, comments), each length-prefixed, and the frame header sits after them. The
 * fifteen SOF markers differ in *compression*, not in the four bytes wanted here, so all of
 * them are accepted apart from the four that are not frames at all.
 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1] as number;
    /* Padding and the standalone markers carry no length to skip. */
    if (marker === 0xff || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    const length = view.getUint16(at + 2, false);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) break;
      return { height: view.getUint16(at + 5, false), width: view.getUint16(at + 7, false) };
    }
    /* A start-of-scan is followed by entropy-coded data, so the frame is behind us. */
    if (marker === 0xda) break;
    if (length < 2) break;
    at += 2 + length;
  }
  throw new DrftError('a JPEG carries no start-of-frame marker, so its size cannot be read');
}

/** WEBP is a RIFF container with three payload shapes, each storing its size differently. */
function webpSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = ascii(bytes, 12, 4);
  if (kind === 'VP8X' && bytes.length >= 30) {
    /* Canvas size, stored minus one across three little-endian bytes each. */
    const width =
      ((bytes[24] as number) | ((bytes[25] as number) << 8) | ((bytes[26] as number) << 16)) + 1;
    const height =
      ((bytes[27] as number) | ((bytes[28] as number) << 8) | ((bytes[29] as number) << 16)) + 1;
    return { width, height };
  }
  if (kind === 'VP8 ' && bytes.length >= 30) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (kind === 'VP8L' && bytes.length >= 25) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new DrftError(`a WEBP with a "${kind}" payload is not one this reader can size`);
}

/**
 * Identify an image and read its dimensions, or refuse by name.
 *
 * Refusing is the designed outcome for anything else. A tier 2 import that quietly dropped
 * an unrecognised texture would produce a model that is merely the wrong colour, which is
 * discovered late and blamed on the shading.
 */
export function describeImage(bytes: Uint8Array): ImageInfo {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    if (bytes.length < 24) throw new DrftError('a PNG ends before its header');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      codec: CODEC_PNG,
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
    };
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { codec: CODEC_JPEG, ...jpegSize(bytes) };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { codec: CODEC_WEBP, ...webpSize(bytes) };
  }
  const head = [...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  throw new DrftError(
    `an image starting ${head} is not PNG, JPEG or WEBP. Convert it to one of those and bake again.`,
  );
}
