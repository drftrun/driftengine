/**
 * Reading a zip container. One responsibility: name a file inside an archive, get its bytes.
 *
 * Shared by `.usdz` and `.3mf`, which is why it exists as its own module rather than inside
 * either: both are zip archives of a documented layout, and a reader written twice is a
 * reader that disagrees with itself once.
 *
 * **The central directory is read, not the local headers.** A zip can be scanned from the
 * front by walking local file headers, and almost every naive reader does. It is wrong: a
 * local header may declare a size of zero and defer the real figures to a data descriptor
 * *after* the payload, which cannot be found without already knowing where the payload ends.
 * The central directory at the back of the file is the authority, always carries the sizes,
 * and is what the specification says to use.
 *
 * **Inflate is injected**, for the same reason as in `fbx.ts`: this module is part of an
 * engine that runs in a browser and must not reach for Node's `zlib`. `.usdz` never needs it,
 * because the format *requires* its entries to be stored uncompressed so they can be memory
 * mapped, and that is why a USDZ can be read with no decompressor at all. `.3mf` is ordinary
 * deflate and needs one.
 */

import { DrftError } from '@driftengine/drft';
import type { Inflate } from './fbx.ts';

/** One file in the archive. `bytes` is decompressed and ready to read. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Signature of a central directory record, little-endian: `PK`. */
const CENTRAL_SIGNATURE = 0x02014b50;
/** Signature of the end-of-central-directory record: `PK`. */
const END_SIGNATURE = 0x06054b50;
/** The two compression methods that appear in practice. Anything else is refused by number. */
const STORED = 0;
const DEFLATED = 8;

/**
 * Find the end-of-central-directory record, which is the only fixed point in a zip.
 *
 * It sits at the very back, except that it carries a trailing comment of arbitrary length, so
 * it has to be searched for backwards. The comment is at most 65535 bytes by definition, so
 * the search is bounded rather than a scan of the whole file.
 */
function findEnd(view: DataView, length: number): number {
  const earliest = Math.max(0, length - 22 - 0xffff);
  for (let at = length - 22; at >= earliest; at--) {
    if (view.getUint32(at, true) === END_SIGNATURE) return at;
  }
  throw new DrftError('zip: no end-of-central-directory record, so this is not a zip archive');
}

/**
 * Every file in an archive, decompressed.
 *
 * Directory entries are skipped: they are zero-length records whose names end in a slash, and
 * a caller asking for files does not want them.
 */
export function readZip(buffer: ArrayBuffer, inflate: Inflate | null = null): ZipEntry[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (buffer.byteLength < 22) throw new DrftError('zip: shorter than an empty archive');

  const end = findEnd(view, buffer.byteLength);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);

  const out: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new DrftError(`zip: the central directory entry ${i} is malformed at byte ${at}`);
    }
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    /* A directory, which carries no payload and is not a file anybody asked for. */
    if (name.endsWith('/')) continue;

    /*
     * The local header's *own* name and extra lengths, which differ from the central
     * directory's. Reusing the central figures here is the classic zip bug: the extra field
     * is routinely a different length in the two places, so the payload starts somewhere
     * else and the entry decompresses to noise.
     */
    if (localAt + 30 > buffer.byteLength || view.getUint32(localAt, true) !== 0x04034b50) {
      throw new DrftError(`zip: "${name}" points at byte ${localAt}, which is not a local header`);
    }
    const localNameLength = view.getUint16(localAt + 26, true);
    const localExtraLength = view.getUint16(localAt + 28, true);
    const from = localAt + 30 + localNameLength + localExtraLength;
    if (from + compressedSize > buffer.byteLength) {
      throw new DrftError(
        `zip: "${name}" claims ${compressedSize} bytes and runs past the archive`,
      );
    }
    const payload = bytes.subarray(from, from + compressedSize);

    if (method === STORED) {
      out.push({ name, bytes: payload });
      continue;
    }
    if (method === DEFLATED) {
      if (inflate === null) {
        throw new DrftError(
          `zip: "${name}" is deflate-compressed and this reader was given no decompressor`,
        );
      }
      out.push({ name, bytes: inflate(payload, uncompressedSize) });
      continue;
    }
    throw new DrftError(
      `zip: "${name}" uses compression method ${method}, and only stored and deflate are read`,
    );
  }
  return out;
}

/** The first entry whose name matches, or null. Case-insensitive, since archives disagree. */
export function findEntry(entries: readonly ZipEntry[], match: RegExp): ZipEntry | null {
  return entries.find((entry) => match.test(entry.name)) ?? null;
}
