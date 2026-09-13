/**
 * A binary FBX, written, so a reader can be tested without a licence and without a fixture.
 *
 * **Not a `.test.ts`, for the reason `rendererHarness.ts` gives one level down**: Vitest registers
 * a test when the file declaring it is imported, so a second test file importing this from beside
 * its own tests would re-run every test in that file too. Split out so importing the harness costs
 * nothing but the harness.
 *
 * **Why write one rather than check one in.** The rig-carrying files this reader exists for are
 * bought character assets: they are tens of megabytes, they are licensed, and none of them can be
 * committed here. A fixture would also answer only the questions that one file happens to ask. A
 * writer answers the ones a test asks — a cluster whose weights do not sum to one, a bone whose
 * only connection is to its cluster, a curve with one key — and each is three lines rather than a
 * hunt for a file that happens to contain it.
 *
 * **What it is not**: a general FBX writer. It emits the records this reader reads, in the shape
 * Autodesk's own exporters emit them, and nothing else. Arrays are written uncompressed, which is
 * legal — `encoding` 0 — and keeps the harness free of a deflate implementation.
 */

/** A property, tagged with the type letter the container stores it under. */
export type FbxProperty =
  | { readonly kind: 'I'; readonly value: number }
  | { readonly kind: 'D'; readonly value: number }
  | { readonly kind: 'L'; readonly value: number }
  | { readonly kind: 'S'; readonly value: string }
  | { readonly kind: 'd'; readonly value: readonly number[] }
  | { readonly kind: 'i'; readonly value: readonly number[] }
  | { readonly kind: 'l'; readonly value: readonly number[] };

export const I = (value: number): FbxProperty => ({ kind: 'I', value });
export const D = (value: number): FbxProperty => ({ kind: 'D', value });
export const L = (value: number): FbxProperty => ({ kind: 'L', value });
export const S = (value: string): FbxProperty => ({ kind: 'S', value });
export const doubles = (value: readonly number[]): FbxProperty => ({ kind: 'd', value });
export const ints = (value: readonly number[]): FbxProperty => ({ kind: 'i', value });
export const longs = (value: readonly number[]): FbxProperty => ({ kind: 'l', value });

export interface FbxWritable {
  readonly name: string;
  readonly properties?: readonly FbxProperty[];
  readonly children?: readonly FbxWritable[];
}

export const node = (
  name: string,
  properties: readonly FbxProperty[] = [],
  children: readonly FbxWritable[] = [],
): FbxWritable => ({ name, properties, children });

/** A `Properties70` entry, which is a `P` record of name, type, subtype, flags, then values. */
export const p = (name: string, type: string, ...values: readonly FbxProperty[]): FbxWritable =>
  node('P', [S(name), S(type), S(''), S(''), ...values]);

/** One `C` record. `OO` is object-to-object; `OP` names the property it drives. */
export const connect = (child: number, parent: number, property?: string): FbxWritable =>
  property === undefined
    ? node('C', [S('OO'), L(child), L(parent)])
    : node('C', [S('OP'), L(child), L(parent), S(property)]);

class Bytes {
  private buffer = new Uint8Array(1024);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private room(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length;
    while (size < this.length + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.room(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  u32(value: number): void {
    this.room(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  i32(value: number): void {
    this.room(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  f32(value: number): void {
    this.room(4);
    this.view.setFloat32(this.length, value, true);
    this.length += 4;
  }

  f64(value: number): void {
    this.room(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  i64(value: number): void {
    this.room(8);
    this.view.setBigInt64(this.length, BigInt(Math.trunc(value)), true);
    this.length += 8;
  }

  raw(value: Uint8Array): void {
    this.room(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  /** Overwrite a `u32` already written, which is how a record learns where it ends. */
  patch(at: number, value: number): void {
    this.view.setUint32(at, value, true);
  }

  done(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

const latin1 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

function writeProperty(out: Bytes, property: FbxProperty): void {
  out.u8(property.kind.charCodeAt(0));
  switch (property.kind) {
    case 'I':
      out.i32(property.value);
      return;
    case 'D':
      out.f64(property.value);
      return;
    case 'L':
      out.i64(property.value);
      return;
    case 'S': {
      const text = latin1(property.value);
      out.u32(text.length);
      out.raw(text);
      return;
    }
    default: {
      /* count, encoding, then the byte length of the payload. Encoding 0 is uncompressed. */
      const values = property.value;
      out.u32(values.length);
      out.u32(0);
      const width = property.kind === 'd' || property.kind === 'l' ? 8 : 4;
      out.u32(values.length * width);
      for (const value of values) {
        if (property.kind === 'd') out.f64(value);
        else if (property.kind === 'l') out.i64(value);
        else out.i32(value);
      }
    }
  }
}

function writeNode(out: Bytes, subject: FbxWritable): void {
  const endAt = out.length;
  out.u32(0);
  const properties = subject.properties ?? [];
  const children = subject.children ?? [];
  out.u32(properties.length);
  const lengthAt = out.length;
  out.u32(0);
  const name = latin1(subject.name);
  out.u8(name.length);
  out.raw(name);

  const propertiesFrom = out.length;
  for (const property of properties) writeProperty(out, property);
  out.patch(lengthAt, out.length - propertiesFrom);

  if (children.length > 0) {
    for (const child of children) writeNode(out, child);
    /* The null record that closes a nested list: thirteen zero bytes at this version. */
    for (let i = 0; i < 13; i++) out.u8(0);
  }
  out.patch(endAt, out.length);
}

/**
 * A whole file: the magic, the version, the records, and the terminator.
 *
 * Version is a parameter because the container's one structural break is at 7500, where record
 * offsets widen to 64 bits. This writer emits the narrow form, so it writes files below that —
 * which is what every exporter in the wild still writes, and what the reader's own `wide` branch
 * exists to tell apart.
 */
export function writeFbx(children: readonly FbxWritable[], version = 7400): ArrayBuffer {
  if (version >= 7500) throw new Error('fbxHarness: this writer emits the pre-7500 narrow form');
  const out = new Bytes();
  out.raw(latin1('Kaydara FBX Binary  '));
  out.u8(0x00);
  out.u8(0x1a);
  out.u8(0x00);
  out.u32(version);
  for (const child of children) writeNode(out, child);
  /* A null record to end the top-level list, then the footer's slack: the reader stops sixteen
     bytes from the end, which is what a real file's footer occupies. */
  for (let i = 0; i < 13; i++) out.u8(0);
  for (let i = 0; i < 16; i++) out.u8(0);
  const bytes = out.done();
  return bytes.slice().buffer as ArrayBuffer;
}
