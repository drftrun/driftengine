/**
 * Reading a `.blend`'s structs by field name, and following its pointers between blocks.
 *
 * `blendFile.ts` says where every block is and what every struct looks like; this is what turns
 * those two tables into `mesh.int('totvert')` and `object.deref('data')`. Every accessor names a
 * field rather than an offset, so a field that moved between Blender releases is found where the
 * file says it is, and a field that does not exist in this file answers `has` false rather than
 * reading whatever sits at an offset some other release used.
 *
 * **A missing field is a question, not an error.** Most of the reading above this module is
 * "the new name if this file has it, the old one otherwise", so `has` is cheap and every typed
 * accessor throws only when asked for a field the struct does not carry — which is a reader bug,
 * and is said with the struct's name and the Blender version beside it.
 */

import { DrftError } from '@driftengine/drft';
import type { BlendBlock, BlendHeader, DnaField, DnaStruct } from './blendFile.ts';
import { readBlendBlocks, readBlendHeader, readDna } from './blendFile.ts';

/** A parsed file: its blocks, its catalogue, and the maps from an address to a block. */
export class BlendData {
  readonly header: BlendHeader;
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly blocks: readonly BlendBlock[];
  readonly structs: readonly DnaStruct[];
  private readonly byType = new Map<string, DnaStruct>();
  /**
   * Which datablock each block's data belongs to: the most recent block that is not `DATA`.
   *
   * **Addresses are only unique inside one datablock, and 5.0 relies on it.** Blender's own reader
   * keeps one map for datablocks and a second, per datablock, for the data blocks that follow it,
   * and 5.0 writes placeholder addresses that repeat between datablocks: measured on a 5.0 file,
   * one address named eight different meshes' attribute arrays. A file-wide map answered every
   * mesh with the last mesh's positions.
   */
  private readonly owner: Int32Array;
  private readonly ids = new Map<bigint, number>();
  private readonly scoped = new Map<number, Map<bigint, number>>();
  private readonly sorted = new Map<number, number[]>();
  /** Before 5.0 every address was a real one, so a data pointer may be resolved file-wide. */
  private readonly fileWide: Map<bigint, number> | null;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.header = readBlendHeader(bytes);
    this.blocks = readBlendBlocks(bytes, this.header);
    const dna = this.blocks.find((block) => block.code === 'DNA1');
    if (dna === undefined) throw new DrftError('blend: the file carries no DNA1 catalogue');
    this.structs = readDna(bytes, dna, this.header);
    for (const struct of this.structs) this.byType.set(struct.type, struct);

    this.owner = new Int32Array(this.blocks.length);
    this.fileWide = this.header.version < 500 ? new Map() : null;
    let scope = -1;
    this.blocks.forEach((block, i) => {
      if (block.code !== 'DATA') {
        scope = i;
        if (block.address !== 0n) this.ids.set(block.address, i);
      } else if (block.address !== 0n) {
        let map = this.scoped.get(scope);
        if (map === undefined) this.scoped.set(scope, (map = new Map()));
        map.set(block.address, i);
        let list = this.sorted.get(scope);
        if (list === undefined) this.sorted.set(scope, (list = []));
        list.push(i);
      }
      this.owner[i] = block.code === 'DATA' ? scope : i;
      if (this.fileWide !== null && block.address !== 0n) this.fileWide.set(block.address, i);
    });
    for (const list of this.sorted.values()) {
      list.sort((a, b) => {
        const x = (this.blocks[a] as BlendBlock).address;
        const y = (this.blocks[b] as BlendBlock).address;
        return x < y ? -1 : x > y ? 1 : 0;
      });
    }
  }

  /** The catalogue entry for a struct type, or undefined where this file's Blender had none. */
  struct(type: string): DnaStruct | undefined {
    return this.byType.get(type);
  }

  /** The datablock a block's data belongs to, which is what scopes every pointer inside it. */
  scopeOf(block: number): number {
    return this.owner[block] ?? -1;
  }

  /**
   * The block an address falls in, and how far into it, as seen from inside datablock `scope`.
   *
   * The datablock's own data first, then the datablocks themselves, which is the order Blender's
   * reader resolves in. Null for an address nothing holds.
   */
  find(address: bigint, scope: number): { block: number; offset: number } | null {
    if (address === 0n) return null;
    const own = this.scoped.get(scope)?.get(address) ?? this.ids.get(address);
    if (own !== undefined) return { block: own, offset: 0 };
    const list = this.sorted.get(scope);
    if (list !== undefined) {
      let lo = 0;
      let hi = list.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const index = list[mid] as number;
        const block = this.blocks[index] as BlendBlock;
        if (block.address > address) hi = mid - 1;
        else if (block.address + BigInt(block.length) <= address) lo = mid + 1;
        else return { block: index, offset: Number(address - block.address) };
      }
    }
    const anywhere = this.fileWide?.get(address);
    return anywhere === undefined ? null : { block: anywhere, offset: 0 };
  }

  /** Every datablock of a two-letter code — `OB`, `ME`, `MA` — as views of their own struct. */
  idsOf(code: string): BlendStruct[] {
    const out: BlendStruct[] = [];
    this.blocks.forEach((block, i) => {
      if (block.code !== code) return;
      const struct = this.structs[block.sdna];
      if (struct !== undefined) out.push(new BlendStruct(this, struct, block.offset, i));
    });
    return out;
  }

  /** A view of the struct at an address, typed by the block that holds it or by `type`. */
  at(address: bigint, scope: number, type?: string): BlendStruct | null {
    const found = this.find(address, scope);
    if (found === null) return null;
    const block = this.blocks[found.block] as BlendBlock;
    const struct = type === undefined ? this.structs[block.sdna] : this.byType.get(type);
    if (struct === undefined) return null;
    return new BlendStruct(this, struct, block.offset + found.offset, this.scopeOf(found.block));
  }

  /**
   * The structs of an array a pointer names, indexed *inside* its block.
   *
   * **Never by adding to the address.** From 5.0 an address is a placeholder rather than a
   * location, so `base + 24` is not the second element and can be exactly the address of some
   * unrelated block.
   */
  array(address: bigint, scope: number, type: string, count?: number): BlendStruct[] {
    const found = this.find(address, scope);
    const struct = this.byType.get(type);
    if (found === null || struct === undefined) return [];
    const block = this.blocks[found.block] as BlendBlock;
    const start = block.offset + found.offset;
    const room = Math.floor((block.offset + block.length - start) / struct.size);
    const n = Math.min(count ?? room, room);
    const owner = this.scopeOf(found.block);
    const out: BlendStruct[] = [];
    for (let i = 0; i < n; i++)
      out.push(new BlendStruct(this, struct, start + i * struct.size, owner));
    return out;
  }

  /** The raw bytes a pointer names, through the end of its block. */
  raw(address: bigint, scope: number): Uint8Array | null {
    const found = this.find(address, scope);
    if (found === null) return null;
    const block = this.blocks[found.block] as BlendBlock;
    return this.bytes.subarray(block.offset + found.offset, block.offset + block.length);
  }

  /** A zero-terminated string a `char *` names. */
  text(address: bigint, scope: number): string {
    const raw = this.raw(address, scope);
    if (raw === null) return '';
    const stop = raw.indexOf(0);
    return new TextDecoder().decode(stop < 0 ? raw : raw.subarray(0, stop));
  }

  /** The block a pointer names, for its count and its catalogue type. */
  blockOf(address: bigint, scope: number): BlendBlock | null {
    const found = this.find(address, scope);
    return found === null ? null : (this.blocks[found.block] ?? null);
  }

  pointer(at: number): bigint {
    const le = this.header.littleEndian;
    return this.header.pointerSize === 8
      ? this.view.getBigUint64(at, le)
      : BigInt(this.view.getUint32(at, le));
  }
}

/** One struct in the file, read by field name. */
export class BlendStruct {
  constructor(
    readonly file: BlendData,
    readonly struct: DnaStruct,
    readonly offset: number,
    /** The datablock this struct's data belongs to, which every pointer in it is resolved inside. */
    readonly scope: number,
  ) {}

  get type(): string {
    return this.struct.type;
  }

  has(name: string): boolean {
    return this.struct.fields.has(name);
  }

  field(name: string): DnaField {
    const field = this.struct.fields.get(name);
    if (field === undefined) {
      throw new DrftError(
        `blend: ${this.struct.type} has no field "${name}" in a file from Blender ` +
          `${this.file.header.version}, which is a reader bug rather than a bad file`,
      );
    }
    return field;
  }

  /** An integer field of any width, signed as its type is. */
  int(name: string, index = 0): number {
    const field = this.field(name);
    return readInt(this.file, field.type, this.offset + field.offset + index * elementSize(field));
  }

  float(name: string, index = 0): number {
    const field = this.field(name);
    const at = this.offset + field.offset + index * elementSize(field);
    const le = this.file.header.littleEndian;
    return field.type === 'double'
      ? this.file.view.getFloat64(at, le)
      : this.file.view.getFloat32(at, le);
  }

  /** Every element of a float array field, flattened: `co[3]` is three, `mat[4][4]` sixteen. */
  floats(name: string): number[] {
    const field = this.field(name);
    const count = field.dims.reduce((n, d) => n * d, 1);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.float(name, i));
    return out;
  }

  ints(name: string): number[] {
    const field = this.field(name);
    const count = field.dims.reduce((n, d) => n * d, 1);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.int(name, i));
    return out;
  }

  /** A `char[]` field as text, up to its first zero. */
  string(name: string): string {
    const field = this.field(name);
    const start = this.offset + field.offset;
    const bytes = this.file.bytes.subarray(start, start + field.size);
    const stop = bytes.indexOf(0);
    return new TextDecoder().decode(stop < 0 ? bytes : bytes.subarray(0, stop));
  }

  /** An ID's name without its two-letter code: `OBCube` is `Cube`. */
  idName(): string {
    return this.sub('id').string('name').slice(2);
  }

  ptr(name: string, index = 0): bigint {
    const field = this.field(name);
    if (!field.pointer) throw new DrftError(`blend: ${this.struct.type}.${name} is not a pointer`);
    return this.file.pointer(this.offset + field.offset + index * this.file.header.pointerSize);
  }

  /** Follow a pointer field, typed by the block it lands in or by `type` where that is known. */
  deref(name: string, type?: string): BlendStruct | null {
    return this.file.at(this.ptr(name), this.scope, type);
  }

  /** An array a pointer field names, `count` long or as long as its block. */
  array(name: string, type: string, count?: number): BlendStruct[] {
    return this.file.array(this.ptr(name), this.scope, type, count);
  }

  /** The bytes a pointer field names, through the end of their block. */
  raw(name: string): Uint8Array | null {
    return this.file.raw(this.ptr(name), this.scope);
  }

  /** The block a pointer field names. */
  blockOf(name: string): BlendBlock | null {
    return this.file.blockOf(this.ptr(name), this.scope);
  }

  /** A `char *` field's text. */
  text(name: string): string {
    return this.file.text(this.ptr(name), this.scope);
  }

  /** An embedded struct field, viewed in place. */
  sub(name: string): BlendStruct {
    const field = this.field(name);
    const struct = this.file.struct(field.type);
    if (struct === undefined)
      throw new DrftError(`blend: no struct ${field.type} in the catalogue`);
    return new BlendStruct(this.file, struct, this.offset + field.offset, this.scope);
  }

  /** The links of a `ListBase` field, following `next` until it runs out. */
  list(name: string, type?: string): BlendStruct[] {
    const base = this.sub(name);
    const out: BlendStruct[] = [];
    const seen = new Set<bigint>();
    let address = base.ptr('first');
    while (address !== 0n && !seen.has(address)) {
      seen.add(address);
      const link = this.file.at(address, this.scope, type);
      if (link === null) break;
      out.push(link);
      /* `next` is the first pointer of every link, including those that embed it in a header
         struct of their own, as every modifier and constraint does. */
      address = this.file.pointer(link.offset);
    }
    return out;
  }

  /** An array of pointers that a pointer-to-pointer field names: `Mesh.mat`, `Object.mat`. */
  pointers(name: string, count: number): bigint[] {
    const raw = this.file.find(this.ptr(name), this.scope);
    if (raw === null) return [];
    const out: bigint[] = [];
    const base = (this.file.blocks[raw.block] as BlendBlock).offset + raw.offset;
    for (let i = 0; i < count; i++)
      out.push(this.file.pointer(base + i * this.file.header.pointerSize));
    return out;
  }
}

function elementSize(field: DnaField): number {
  const count = field.dims.reduce((n, d) => n * d, 1);
  return field.size / count;
}

function readInt(file: BlendData, type: string, at: number): number {
  const le = file.header.littleEndian;
  const view = file.view;
  switch (type) {
    case 'char':
    case 'uchar':
    case 'uint8_t':
    case 'bool':
      return view.getUint8(at);
    case 'int8_t':
      return view.getInt8(at);
    case 'short':
    case 'int16_t':
      return view.getInt16(at, le);
    case 'ushort':
    case 'uint16_t':
      return view.getUint16(at, le);
    case 'int':
    case 'int32_t':
      return view.getInt32(at, le);
    case 'uint':
    case 'uint32_t':
      return view.getUint32(at, le);
    case 'int64_t':
    case 'long':
      return Number(view.getBigInt64(at, le));
    case 'uint64_t':
    case 'ulong':
      return Number(view.getBigUint64(at, le));
    case 'float':
      return view.getFloat32(at, le);
    default:
      throw new DrftError(`blend: no integer reading for a field of type ${type}`);
  }
}
