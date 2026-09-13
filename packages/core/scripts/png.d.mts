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
