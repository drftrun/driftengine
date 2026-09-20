/**
 * The entries of a zip archive, as `torch.save` writes one: stored, never compressed.
 *
 * **Read from the central directory, not by walking local headers**, because the directory is the
 * archive's own index and a local header's sizes may be deferred to a trailer. Zip64's records are
 * followed where a size or an offset overflows 32 bits, which a checkpoint past four gigabytes
 * needs. A compressed entry is refused by name: torch never writes one, so meeting one means the
 * file is not what it says it is, and inflating it would be a second format to trust.
 */

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const OVERFLOW = 0xffffffff;

export function zipEntries(file: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let end = -1;
  for (let at = file.byteLength - 22; at >= Math.max(0, file.byteLength - 22 - 65535); at -= 1) {
    if (view.getUint32(at, true) === END) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('no end of central directory: this is not a zip archive');
  let count = view.getUint16(end + 10, true);
  let directory = view.getUint32(end + 16, true);
  if (directory === OVERFLOW || count === 0xffff) {
    const locator = end - 20;
    if (locator < 0 || view.getUint32(locator, true) !== END64_LOCATOR) {
      throw new Error('a zip64 archive without its zip64 locator');
    }
    const end64 = Number(view.getBigUint64(locator + 8, true));
    if (view.getUint32(end64, true) !== END64) throw new Error('no zip64 end of central directory');
    count = Number(view.getBigUint64(end64 + 32, true));
    directory = Number(view.getBigUint64(end64 + 48, true));
  }

  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  let at = directory;
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error(`no central record at ${at}`);
    const method = view.getUint16(at + 10, true);
    let size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let local = view.getUint32(at + 42, true);
    const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength));
    /* Zip64's extra field holds, in this order, whichever of the three overflowed. */
    const uncompressed = view.getUint32(at + 24, true);
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressed === OVERFLOW) field += 8;
        if (size === OVERFLOW) {
          size = Number(view.getBigUint64(field, true));
          field += 8;
        }
        if (local === OVERFLOW) local = Number(view.getBigUint64(field, true));
      }
      extra += 4 + length;
    }
    if (method !== 0) {
      throw new Error(`entry "${name}" is compressed (method ${method}), which torch never writes`);
    }
    if (view.getUint32(local, true) !== LOCAL) throw new Error(`no local header for "${name}"`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > file.byteLength) throw new Error(`entry "${name}" runs past the file`);
    entries.set(name, file.subarray(start, start + size));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
