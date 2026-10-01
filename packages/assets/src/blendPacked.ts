/**
 * Undoing the compression a `.blend` was saved with, through a decompressor the host supplies.
 *
 * **Blender has saved compressed files two ways.** Before 3.0 the whole file was one gzip stream.
 * From 3.0 it is zstd in the *seekable* layout: the file cut into independent frames, and a table
 * at the end in a skippable frame saying how long each one is. This module reads that table and
 * hands each frame to the host's decoder, because a decoder asked for the whole file may stop at
 * the end of the first frame and say nothing: Node 22's `zstdDecompressSync` returned 67 KB of a
 * three-frame, 330 KB fixture, which then read as a file that ends before its `ENDB`.
 *
 * **The decoder is the host's, not this module's.** Node has both; a browser has gzip in
 * `DecompressionStream` and, depending on the browser, no zstd at all. Shipping a zstd decoder
 * here would be owning a correctness risk the platform already carries, which is the argument
 * `fbxInflate.ts` makes for deflate. A host without one is told the name of what to pass.
 *
 * What it gives up: a zstd file with no seek table — one no Blender writes — is handed to the
 * decoder whole, and a decoder that stops after one frame then truncates it. The truncation is
 * caught downstream, by the missing `ENDB`, rather than here.
 */

import { DrftError } from '@driftengine/drft';
import { blendCompression } from './blendFile.ts';

/** Decompress one gzip stream or one zstd frame. Supplied by the host. */
export type BlendDecompress = (
  compressed: Uint8Array,
  codec: 'gzip' | 'zstd',
) => Uint8Array | Promise<Uint8Array>;

const SEEKABLE_MAGIC = 0x8f92eab1;
const SKIPPABLE_MAGIC = 0x184d2a5e;

/** Each frame's compressed and decompressed length, from the seek table, or null where there is none. */
export function zstdFrames(bytes: Uint8Array): { packed: number; plain: number }[] | null {
  if (bytes.length < 17) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footer = bytes.length - 9;
  if (view.getUint32(footer + 5, true) !== SEEKABLE_MAGIC) return null;
  const frames = view.getUint32(footer, true);
  const descriptor = bytes[footer + 4] ?? 0;
  const entry = descriptor & 0x80 ? 12 : 8;
  const table = footer - frames * entry;
  const header = table - 8;
  if (header < 0 || view.getUint32(header, true) !== SKIPPABLE_MAGIC) return null;
  const sizes: { packed: number; plain: number }[] = [];
  let total = 0;
  for (let i = 0; i < frames; i++) {
    const packed = view.getUint32(table + i * entry, true);
    sizes.push({ packed, plain: view.getUint32(table + i * entry + 4, true) });
    total += packed;
  }
  return total === header ? sizes : null;
}

/**
 * The plain bytes of a `.blend`, decompressing first where the file says it is compressed.
 *
 * **Allocated once, from the seek table.** The table states every frame's decompressed length, so
 * the output is sized before the first frame is decoded and each frame is copied into place and
 * dropped. Collecting the frames and joining them afterwards held the file twice at its peak, which
 * is 14 GB for a 7 GB city and was the difference between reading it and not.
 */
export async function unpackBlend(
  bytes: Uint8Array,
  decompress: BlendDecompress | undefined,
): Promise<Uint8Array> {
  const codec = blendCompression(bytes);
  if (codec === null) return bytes;
  if (decompress === undefined) {
    throw new DrftError(
      `.blend saved with ${codec} compression needs a "decompress" to be read. Bake it with ` +
        '`npm run bake`, which supplies one, or pass decompress to readModel.',
    );
  }
  if (codec === 'gzip') return decompress(bytes, 'gzip');
  const frames = zstdFrames(bytes);
  if (frames === null) return decompress(bytes, 'zstd');
  const out = new Uint8Array(frames.reduce((n, frame) => n + frame.plain, 0));
  let from = 0;
  let to = 0;
  for (const frame of frames) {
    const part = await decompress(bytes.subarray(from, from + frame.packed), 'zstd');
    if (part.length !== frame.plain) {
      throw new DrftError(
        `blend: a zstd frame decoded to ${part.length} bytes where the seek table says ${frame.plain}`,
      );
    }
    out.set(part, to);
    from += frame.packed;
    to += part.length;
  }
  return out;
}
