/**
 * The district's source: one `.blend`, read frame by frame from disk into one buffer.
 *
 * **Why not `openBlend`.** The engine's opener takes the file's bytes whole, which for this source
 * is 4.5 GB compressed held beside 6.85 GB plain. Blender saves zstd in the seekable layout, a
 * table at the end giving every frame's length, so the frames can be read and decoded one at a
 * time into a buffer sized from the table: the peak is the plain file and one frame.
 *
 * The source is not committed: it is a bought asset and not the engine's to redistribute. It is
 * looked for where `--source` says, or at `models/district/district.blend`.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

import { BlendData, blendCompression, isBlend } from '@driftengine/assets';

export const DEFAULT_SOURCE = 'models/district/district.blend';

/** The seek table's frames, read from the file's tail without reading the rest. */
function frames(fd: number, size: number): { packed: number; plain: number }[] | null {
  const tail = Buffer.alloc(Math.min(size, 9));
  readSync(fd, tail, 0, tail.length, size - tail.length);
  if (tail.readUInt32LE(5) !== 0x8f92eab1) return null;
  const count = tail.readUInt32LE(0);
  const entry = (tail[4] ?? 0) & 0x80 ? 12 : 8;
  const table = Buffer.alloc(count * entry);
  readSync(fd, table, 0, table.length, size - 9 - table.length);
  const out: { packed: number; plain: number }[] = [];
  for (let i = 0; i < count; i++)
    out.push({ packed: table.readUInt32LE(i * entry), plain: table.readUInt32LE(i * entry + 4) });
  return out;
}

/** Open the source, decompressing as it reads. */
export function openSource(path: string, log: (line: string) => void = () => undefined): BlendData {
  if (!existsSync(path)) {
    throw new Error(
      `${path}: no such file. The district's source is not committed; pass --source <file.blend>.`,
    );
  }
  const started = performance.now();
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 16));
    readSync(fd, head, 0, head.length, 0);
    const codec = blendCompression(head);
    let bytes: Uint8Array;
    if (codec === null) {
      if (!isBlend(head)) throw new Error(`${path}: not a .blend file`);
      bytes = new Uint8Array(size);
      readSync(fd, bytes, 0, size, 0);
    } else if (codec === 'gzip') {
      const packed = Buffer.alloc(size);
      readSync(fd, packed, 0, size, 0);
      bytes = new Uint8Array(gunzipSync(packed));
    } else {
      const table = frames(fd, size);
      if (table === null)
        throw new Error(`${path}: zstd with no seek table, which no Blender writes`);
      bytes = new Uint8Array(table.reduce((n, f) => n + f.plain, 0));
      let from = 0;
      let to = 0;
      for (const frame of table) {
        const packed = Buffer.alloc(frame.packed);
        readSync(fd, packed, 0, frame.packed, from);
        const plain = zstdDecompressSync(packed);
        bytes.set(plain, to);
        from += frame.packed;
        to += plain.length;
      }
    }
    const blend = new BlendData(bytes);
    log(
      `source: ${(bytes.length / 1e9).toFixed(2)} GB, Blender ${blend.header.version}, ${blend.blocks.length} blocks, ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
    return blend;
  } finally {
    closeSync(fd);
  }
}
