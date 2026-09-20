/** What a decoded PNG is: row-major 8-bit samples, three or four to a pixel. */
export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Buffer;
}

export function decodePng(bytes: Buffer): DecodedPng;
export function readPng(path: string): DecodedPng;

/**
 * Write 8-bit RGBA as a PNG. `rgba` must be exactly `width * height * 4` bytes.
 *
 * Node-side only — `node:zlib` is the whole of it, and nothing a browser loads links this.
 */
export function encodePng(width: number, height: number, rgba: Buffer | Uint8Array): Buffer;

/** An image as four bytes a pixel, row-major. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** A decoded PNG as four bytes a pixel, whether it was written with three channels or four. */
export function rgbaOf(decoded: DecodedPng): RgbaImage;

/** A rectangle of a four-byte-a-pixel image, as a new image. */
export function crop(
  image: RgbaImage,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): RgbaImage;
