/**
 * A `.blend` file's container: its header, its blocks, and the catalogue of structures the file
 * carries to describe its own layout.
 *
 * **The catalogue is what makes this readable at all.** Every `.blend` ends with a `DNA1` block
 * listing each C struct the writing Blender knew — its fields, their types, their sizes — so a
 * reader learns the layout *from the file* rather than hard-coding one Blender release. A mesh
 * written by 2.79 and one written by 5.2 differ in nearly every struct, and both are read by the
 * same code because neither is assumed.
 *
 * **Three container shapes are read, and anything else is refused by name.** The twelve-byte
 * header every release before 5.0 wrote, with four- or eight-byte pointers and either byte order,
 * and the seventeen-byte header 5.0 introduced, whose block headers carry 64-bit lengths. A file
 * compressed with gzip (before 3.0) or zstd (3.0 on) is reported as such, and `readBlendFile`
 * takes the decompressed bytes: decompressing is the host's capability, not this module's.
 *
 * What this gives up: a block whose pointer is not the start of a block is found by search, which
 * is a binary search over every block. That is the cost of not assuming how Blender allocates.
 */

import { DrftError } from '@driftengine/drft';

/** What the first bytes say, before any block is read. */
export interface BlendHeader {
  readonly pointerSize: 4 | 8;
  readonly littleEndian: boolean;
  /** The writing Blender's version, as the header spells it: 279, 405, 500. */
  readonly version: number;
  /** Bytes of header before the first block. */
  readonly headerSize: number;
  /** Bytes in each block header: 20, 24, or 32 for the 64-bit form 5.0 writes. */
  readonly blockHeaderSize: number;
}

/** One block: a run of `count` structs of catalogue type `sdna`, at `offset` in the file. */
export interface BlendBlock {
  readonly code: string;
  readonly sdna: number;
  /** The address the struct had in the writing process, which every pointer to it names. */
  readonly address: bigint;
  readonly length: number;
  readonly count: number;
  readonly offset: number;
}

/** One field of a catalogued struct, with its offset already summed. */
export interface DnaField {
  /** The bare name: `*next` and `co[3]` are `next` and `co`. */
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly pointer: boolean;
  /** Array dimensions, outermost first; empty for a scalar. */
  readonly dims: readonly number[];
}

export interface DnaStruct {
  readonly index: number;
  readonly type: string;
  readonly size: number;
  readonly fields: ReadonlyMap<string, DnaField>;
}

/** Which compression, if any, a file's first bytes declare. */
export type BlendCompression = 'gzip' | 'zstd' | null;

/** The compression a `.blend` was saved with, by its magic, or null for a plain file. */
export function blendCompression(bytes: Uint8Array): BlendCompression {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f) {
    return bytes[3] === 0xfd ? 'zstd' : null;
  }
  return null;
}

/** Whether these bytes are an uncompressed `.blend`. */
export function isBlend(bytes: Uint8Array): boolean {
  const magic = 'BLENDER';
  if (bytes.length < 12) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** Parse the header, refusing any shape this module has not been taught. */
export function readBlendHeader(bytes: Uint8Array): BlendHeader {
  if (!isBlend(bytes)) {
    const packed = blendCompression(bytes);
    throw new DrftError(
      packed === null
        ? 'blend: not a .blend file (no BLENDER magic)'
        : `blend: this file is ${packed}-compressed and must be decompressed before it is read`,
    );
  }
  const seventh = String.fromCharCode(bytes[7] ?? 0);
  if (seventh === '-' || seventh === '_') {
    const endian = String.fromCharCode(bytes[8] ?? 0);
    if (endian !== 'v' && endian !== 'V') throw new DrftError(`blend: byte order "${endian}"`);
    const pointerSize = seventh === '-' ? 8 : 4;
    return {
      pointerSize,
      littleEndian: endian === 'v',
      version: Number(ascii(bytes, 9, 3)),
      headerSize: 12,
      blockHeaderSize: pointerSize === 8 ? 24 : 20,
    };
  }
  /* 5.0 on: `BLENDER` + header size + `-` + file format version + byte order + four digits. */
  const headerSize = Number(ascii(bytes, 7, 2));
  const format = Number(ascii(bytes, 10, 2));
  const endian = String.fromCharCode(bytes[12] ?? 0);
  if (
    headerSize !== 17 ||
    bytes[9] !== 0x2d ||
    format !== 1 ||
    (endian !== 'v' && endian !== 'V')
  ) {
    throw new DrftError(
      `blend: header "${ascii(bytes, 0, 17)}" is a container layout this reader does not know`,
    );
  }
  return {
    pointerSize: 8,
    littleEndian: endian === 'v',
    version: Number(ascii(bytes, 13, 4)),
    headerSize,
    blockHeaderSize: 32,
  };
}

/** Walk every block header up to `ENDB`. */
export function readBlendBlocks(bytes: Uint8Array, header: BlendHeader): BlendBlock[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = header.littleEndian;
  const blocks: BlendBlock[] = [];
  let at = header.headerSize;
  while (at + header.blockHeaderSize <= bytes.length) {
    const code = ascii(bytes, at, 4).replace(/\0+$/, '');
    let length: number;
    let address: bigint;
    let sdna: number;
    let count: number;
    if (header.blockHeaderSize === 32) {
      sdna = view.getInt32(at + 4, le);
      address = view.getBigUint64(at + 8, le);
      length = Number(view.getBigInt64(at + 16, le));
      count = Number(view.getBigInt64(at + 24, le));
    } else {
      length = view.getInt32(at + 4, le);
      address =
        header.pointerSize === 8
          ? view.getBigUint64(at + 8, le)
          : BigInt(view.getUint32(at + 8, le));
      const rest = at + 8 + header.pointerSize;
      sdna = view.getInt32(rest, le);
      count = view.getInt32(rest + 4, le);
    }
    if (code === 'ENDB') return blocks;
    const offset = at + header.blockHeaderSize;
    if (length < 0 || offset + length > bytes.length) {
      throw new DrftError(`blend: block "${code}" at ${at} runs past the end of the file`);
    }
    blocks.push({ code, sdna, address, length, count, offset });
    at = offset + length;
  }
  throw new DrftError('blend: the file ends before its ENDB block, so it was not saved completely');
}

/** Parse the `DNA1` block into structs with every field's offset summed. */
export function readDna(bytes: Uint8Array, block: BlendBlock, header: BlendHeader): DnaStruct[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = header.littleEndian;
  let at = block.offset;
  const end = block.offset + block.length;
  const expect = (tag: string): void => {
    at = block.offset + Math.ceil((at - block.offset) / 4) * 4;
    if (ascii(bytes, at, 4) !== tag) throw new DrftError(`blend: DNA1 has no ${tag} section`);
    at += 4;
  };
  const strings = (): string[] => {
    const count = view.getInt32(at, le);
    at += 4;
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const stop = bytes.indexOf(0, at);
      if (stop < 0 || stop >= end) throw new DrftError('blend: DNA1 string table is truncated');
      out.push(ascii(bytes, at, stop - at));
      at = stop + 1;
    }
    return out;
  };

  expect('SDNA');
  expect('NAME');
  const names = strings();
  expect('TYPE');
  const types = strings();
  expect('TLEN');
  const lengths: number[] = [];
  for (let i = 0; i < types.length; i++) lengths.push(view.getInt16(at + i * 2, le));
  at += types.length * 2;
  expect('STRC');
  const count = view.getInt32(at, le);
  at += 4;

  const structs: DnaStruct[] = [];
  for (let s = 0; s < count; s++) {
    const typeIndex = view.getInt16(at, le);
    const fieldCount = view.getInt16(at + 2, le);
    at += 4;
    const fields = new Map<string, DnaField>();
    let offset = 0;
    for (let f = 0; f < fieldCount; f++) {
      const typeOf = view.getInt16(at, le);
      const type = types[typeOf] ?? '';
      const raw = names[view.getInt16(at + 2, le)] ?? '';
      at += 4;
      const pointer = raw.startsWith('*') || raw.startsWith('(*');
      const dims = [...raw.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      const element = pointer ? header.pointerSize : (lengths[typeOf] ?? 0);
      const size = dims.reduce((n, d) => n * d, element);
      const name = raw.replace(/^[(*]+/, '').replace(/[)[].*$/, '');
      fields.set(name, { name, type, offset, size, pointer, dims });
      offset += size;
    }
    const type = types[typeIndex] ?? '';
    structs.push({ index: s, type, size: lengths[typeIndex] ?? offset, fields });
  }
  return structs;
}
