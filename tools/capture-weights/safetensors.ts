/**
 * A safetensors file, read: an eight-byte little-endian header length, a JSON header naming each
 * tensor's type, shape and byte range, and the bytes.
 *
 * **Every range is checked against the file and against its own shape** before anything is
 * handed on, so a truncated download or a header that lies is refused naming the tensor, rather
 * than read as a network of whatever bytes happen to be there. Nothing is copied: each tensor is
 * a view into the file, and its offset may be anything, because a header may be any length.
 */
import { ELEMENT_BYTES, elementCount, type StoredTensor } from './checkpoint.ts';

interface HeaderEntry {
  readonly dtype: string;
  readonly shape: readonly number[];
  readonly data_offsets: readonly [number, number];
}

export function readSafetensors(file: Uint8Array): Map<string, StoredTensor> {
  if (file.byteLength < 8) throw new Error('a safetensors file begins with its header length');
  const length = Number(
    new DataView(file.buffer, file.byteOffset, file.byteLength).getBigUint64(0, true),
  );
  if (8 + length > file.byteLength) {
    throw new Error(`the header claims ${length} bytes and the file holds ${file.byteLength - 8}`);
  }
  const header = JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + length))) as Record<
    string,
    HeaderEntry
  >;
  const data = file.subarray(8 + length);
  const tensors = new Map<string, StoredTensor>();
  for (const [name, entry] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const width = ELEMENT_BYTES[entry.dtype];
    if (width === undefined) {
      throw new Error(`tensor "${name}" is of ${entry.dtype}, a type this reader does not know`);
    }
    const [begin, end] = entry.data_offsets;
    if (!(begin >= 0 && begin <= end && end <= data.byteLength)) {
      throw new Error(`tensor "${name}" lies at ${begin} to ${end}, outside the file's data`);
    }
    const wanted = elementCount(entry.shape) * width;
    if (end - begin !== wanted) {
      throw new Error(
        `tensor "${name}" holds ${end - begin} bytes and its shape [${entry.shape.join(', ')}] ` +
          `of ${entry.dtype} needs ${wanted}`,
      );
    }
    tensors.set(name, { dtype: entry.dtype, shape: entry.shape, bytes: data.subarray(begin, end) });
  }
  return tensors;
}
