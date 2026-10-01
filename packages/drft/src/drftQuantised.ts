/**
 * `MSHQ`: a mesh stored in the bytes its data needs, decoded on read into the same `MeshData` a
 * `MESH` gives. Added in 1.18.
 *
 * **Why a second mesh chunk rather than a flag in `MESH`.** `MESH`'s reserved word must be ignored
 * by readers (§4.4 rule 6), so a flag there would let an older reader read 16-bit numbers as floats
 * and draw noise without a word. A new FourCC, marked required, makes that reader refuse by name.
 *
 * **One encoding per attribute, chosen from what the data allows:**
 * - constant, when every vertex carries one value: a bought scene's colour and emissive, 16 bytes a
 *   vertex of nothing;
 * - 16 bits over the attribute's own range, for positions, UVs, scalars and weights: half a step of
 *   error, 0.27 mm across 36 m;
 * - octahedral in two 16-bit numbers, for unit normals, and for unit tangents with the handedness
 *   in a sign byte: within 5e-5 rad, 0.003°, measured over the sphere;
 * - raw floats, where exactness is the contract (joints) or where a "direction" is not unit length
 *   and an octahedral code would bend it into one: data already malformed is carried as it came.
 *
 * Indices are 16-bit when the mesh has at most 65,536 vertices.
 *
 * What it gives up is exactness: a quantised mesh is within its bound of the source, not equal to it,
 * and it is no longer a zero-copy view of the file. What would make that wrong is a consumer that
 * compares vertices bit for bit, or one that cannot afford the decode's copy; `writeDrft`'s
 * `quantise: false` writes `MESH` as before.
 */
import {
  ATTR_EMISSIVE_COLOR,
  ATTR_GRAIN,
  ATTR_JOINTS,
  ATTR_RELIEF,
  ATTR_ROUGHNESS,
  ATTR_SPECULAR,
  ATTR_TANGENT,
  ATTR_UVS,
  ATTR_WEIGHTS,
  ATTR_LAYERS,
  ATTR_CHANNEL,
  DrftError,
  align,
} from './drftFormat.ts';
import type { MeshData } from './meshData.ts';

const RAW = 0;
const CONSTANT = 1;
const RANGE16 = 2;
const OCTAHEDRAL = 3;
const OCTAHEDRAL_SIGNED = 4;

/** Header flag: the indices are 16-bit. */
const INDICES_16 = 1;

type Name =
  | 'positions'
  | 'normals'
  | 'colors'
  | 'emissive'
  | 'specular'
  | 'uvs'
  | 'emissiveColor'
  | 'roughness'
  | 'grain'
  | 'relief'
  | 'tangents'
  | 'joints'
  | 'weights'
  | 'layers'
  | 'channel';

/** The frozen order `MESH` uses, with each optional array's bit: `FORMAT.md` §4.3. */
const ORDER: readonly {
  name: Name;
  width: number;
  bit: number;
  kind: 'value' | 'direction' | 'exact';
}[] = [
  { name: 'positions', width: 3, bit: 0, kind: 'value' },
  { name: 'normals', width: 3, bit: 0, kind: 'direction' },
  { name: 'colors', width: 3, bit: 0, kind: 'value' },
  { name: 'emissive', width: 1, bit: 0, kind: 'value' },
  { name: 'specular', width: 1, bit: ATTR_SPECULAR, kind: 'value' },
  { name: 'uvs', width: 2, bit: ATTR_UVS, kind: 'value' },
  { name: 'emissiveColor', width: 3, bit: ATTR_EMISSIVE_COLOR, kind: 'value' },
  { name: 'roughness', width: 1, bit: ATTR_ROUGHNESS, kind: 'value' },
  { name: 'grain', width: 1, bit: ATTR_GRAIN, kind: 'value' },
  { name: 'relief', width: 1, bit: ATTR_RELIEF, kind: 'value' },
  { name: 'tangents', width: 4, bit: ATTR_TANGENT, kind: 'direction' },
  { name: 'joints', width: 4, bit: ATTR_JOINTS, kind: 'exact' },
  { name: 'weights', width: 4, bit: ATTR_WEIGHTS, kind: 'value' },
  /* Whole numbers naming an image, so exact: a layer quantised onto its neighbour is another picture. */
  { name: 'layers', width: 1, bit: ATTR_LAYERS, kind: 'exact' },
  { name: 'channel', width: 4, bit: ATTR_CHANNEL, kind: 'value' },
];

/** A growing little-endian byte list, for the writer: offline, so it may allocate. */
class Bytes {
  private data = new Uint8Array(1024);
  private view = new DataView(this.data.buffer);
  length = 0;
  private room(n: number): void {
    if (this.length + n <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.room(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
  }
  u16(v: number): void {
    this.room(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
  }
  i16(v: number): void {
    this.room(2);
    this.view.setInt16(this.length, v, true);
    this.length += 2;
  }
  u32(v: number): void {
    this.room(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
  }
  f32(v: number): void {
    this.room(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
  }
  pad(): void {
    while (this.length % 4 !== 0) this.u8(0);
  }
  finish(): Uint8Array {
    this.pad();
    return this.data.slice(0, align(this.length));
  }
}

export function encodeQuantisedMesh(mesh: MeshData): Uint8Array {
  const vertices = mesh.positions.length / 3;
  let attributes = 0;
  for (const entry of ORDER)
    if (entry.bit !== 0 && mesh[entry.name] !== undefined) attributes |= entry.bit;
  if (((attributes & ATTR_JOINTS) !== 0) !== ((attributes & ATTR_WEIGHTS) !== 0)) {
    throw new DrftError('a mesh carries joints without weights, or weights without joints');
  }
  const narrow = vertices <= 65_536;
  const out = new Bytes();
  out.u32(vertices);
  out.u32(mesh.indices.length);
  out.u32(attributes);
  out.u32(narrow ? INDICES_16 : 0);
  for (const entry of ORDER) {
    const values = mesh[entry.name];
    if (values === undefined) continue;
    writeAttribute(out, values, vertices, entry.width, entry.kind);
  }
  for (let i = 0; i < mesh.indices.length; i++) {
    const index = mesh.indices[i] as number;
    if (narrow) out.u16(index);
    else out.u32(index);
  }
  return out.finish();
}

function writeAttribute(
  out: Bytes,
  values: Float32Array,
  vertices: number,
  width: number,
  kind: 'value' | 'direction' | 'exact',
): void {
  const encoding = choose(values, vertices, width, kind);
  out.u8(encoding);
  out.u8(width);
  out.u16(0);
  if (encoding === CONSTANT) {
    for (let c = 0; c < width; c++) out.f32(vertices === 0 ? 0 : (values[c] as number));
    return;
  }
  if (encoding === RAW) {
    for (let i = 0; i < vertices * width; i++) out.f32(values[i] as number);
    return;
  }
  if (encoding === RANGE16) {
    const lo = new Float64Array(width).fill(Infinity);
    const hi = new Float64Array(width).fill(-Infinity);
    for (let v = 0; v < vertices; v++) {
      for (let c = 0; c < width; c++) {
        const x = values[v * width + c] as number;
        if (x < (lo[c] as number)) lo[c] = x;
        if (x > (hi[c] as number)) hi[c] = x;
      }
    }
    for (let c = 0; c < width; c++) out.f32(lo[c] as number);
    for (let c = 0; c < width; c++) out.f32(hi[c] as number);
    /* Quantised against the float32 the reader will see, so the reader's arithmetic is the same. */
    const flo = Float32Array.from(lo);
    const fhi = Float32Array.from(hi);
    for (let v = 0; v < vertices; v++) {
      for (let c = 0; c < width; c++) {
        const span = (fhi[c] as number) - (flo[c] as number);
        const x = values[v * width + c] as number;
        out.u16(span > 0 ? Math.round(((x - (flo[c] as number)) / span) * 65535) : 0);
      }
    }
    out.pad();
    return;
  }
  /* Octahedral: two snorm16 a direction, and for a tangent a sign byte after them all. */
  for (let v = 0; v < vertices; v++) {
    const [u, w] = octEncode(
      values[v * width] as number,
      values[v * width + 1] as number,
      values[v * width + 2] as number,
    );
    out.i16(u);
    out.i16(w);
  }
  if (encoding === OCTAHEDRAL_SIGNED) {
    for (let v = 0; v < vertices; v++) out.u8((values[v * 4 + 3] as number) < 0 ? 1 : 0);
    out.pad();
  }
}

function choose(values: Float32Array, vertices: number, width: number, kind: string): number {
  if (kind === 'exact') return RAW;
  let constant = true;
  for (let v = 1; v < vertices && constant; v++) {
    for (let c = 0; c < width; c++) {
      if (values[v * width + c] !== values[c]) {
        constant = false;
        break;
      }
    }
  }
  if (constant) return CONSTANT;
  if (kind === 'direction') {
    /* Only unit directions, and for a tangent only a handedness of exactly ±1, take a code. */
    for (let v = 0; v < vertices; v++) {
      const x = values[v * width] as number;
      const y = values[v * width + 1] as number;
      const z = values[v * width + 2] as number;
      if (Math.abs(Math.hypot(x, y, z) - 1) > 1e-3) return RAW;
      if (width === 4 && Math.abs(values[v * 4 + 3] as number) !== 1) return RAW;
    }
    return width === 4 ? OCTAHEDRAL_SIGNED : OCTAHEDRAL;
  }
  return RANGE16;
}

const SNORM = 32767;

/**
 * The octahedral code of a unit direction: the nearest of the four 16-bit neighbours of the exact
 * projection, measured by decoding each: the "precise" variant, whose worst over 200,000 directions
 * is 4.3e-5 rad. Rounding each coordinate alone does noticeably worse near the folds.
 */
function octEncode(x: number, y: number, z: number): [number, number] {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let u = x / l1;
  let w = y / l1;
  if (z < 0) {
    const pu = u;
    u = (1 - Math.abs(w)) * (pu >= 0 ? 1 : -1);
    w = (1 - Math.abs(pu)) * (w >= 0 ? 1 : -1);
  }
  const fu = Math.floor(u * SNORM);
  const fw = Math.floor(w * SNORM);
  let best: [number, number] = [fu, fw];
  let bestDot = -2;
  for (let du = 0; du <= 1; du++) {
    for (let dw = 0; dw <= 1; dw++) {
      const qu = Math.max(-SNORM, Math.min(SNORM, fu + du));
      const qw = Math.max(-SNORM, Math.min(SNORM, fw + dw));
      octDecode(qu, qw, OCT_SCRATCH, 0);
      const dot =
        (OCT_SCRATCH[0] as number) * x +
        (OCT_SCRATCH[1] as number) * y +
        (OCT_SCRATCH[2] as number) * z;
      if (dot > bestDot) {
        bestDot = dot;
        best = [qu, qw];
      }
    }
  }
  return best;
}

/*
 * Float64, because the choice is between codes a ten-thousandth of a radian apart and a float32 dot
 * product near 1 cannot see differences below about 3e-4: its own rounding is that coarse.
 */
const OCT_SCRATCH = new Float64Array(3);

function octDecode(qu: number, qw: number, out: Float32Array | Float64Array, at: number): void {
  let x = Math.max(-1, qu / SNORM);
  let y = Math.max(-1, qw / SNORM);
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const px = x;
    x = (1 - Math.abs(y)) * (px >= 0 ? 1 : -1);
    y = (1 - Math.abs(px)) * (y >= 0 ? 1 : -1);
  }
  /*
   * A square root rather than `Math.hypot`, which guards an overflow that three numbers bounded by
   * one cannot reach and costs nearly three times as much for it: 0.7 s of a five-pack load was this
   * function. The float32 a reader keeps agreed with `hypot`'s on every one of 263 million codes
   * sampled across the whole lattice.
   */
  const len = Math.sqrt(x * x + y * y + z * z);
  out[at] = x / len;
  out[at + 1] = y / len;
  out[at + 2] = z / len;
}

export function decodeQuantisedMesh(
  buffer: ArrayBufferLike,
  offset: number,
  byteLength: number,
): MeshData {
  const view = new DataView(buffer, offset, byteLength);
  if (byteLength < 16) throw new DrftError('MSHQ is shorter than its header');
  const vertices = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);
  const attributes = view.getUint32(8, true);
  const flags = view.getUint32(12, true);
  let at = 16;
  const need = (n: number, what: string): void => {
    if (at + n > byteLength) throw new DrftError(`MSHQ ends inside ${what}`);
  };
  const out: Record<string, unknown> = {};
  for (const entry of ORDER) {
    if (entry.bit !== 0 && (attributes & entry.bit) === 0) continue;
    need(4, entry.name);
    const encoding = view.getUint8(at);
    const width = view.getUint8(at + 1);
    at += 4;
    if (width !== entry.width) {
      throw new DrftError(
        `MSHQ ${entry.name} is ${width} wide, and the format says ${entry.width}`,
      );
    }
    const values = new Float32Array(vertices * width);
    if (encoding === CONSTANT) {
      need(width * 4, entry.name);
      for (let c = 0; c < width; c++) {
        const x = view.getFloat32(at + c * 4, true);
        for (let v = 0; v < vertices; v++) values[v * width + c] = x;
      }
      at += width * 4;
    } else if (encoding === RAW) {
      need(vertices * width * 4, entry.name);
      for (let i = 0; i < vertices * width; i++) values[i] = view.getFloat32(at + i * 4, true);
      at += vertices * width * 4;
    } else if (encoding === RANGE16) {
      need(width * 8 + vertices * width * 2, entry.name);
      const lo = new Float32Array(width);
      const hi = new Float32Array(width);
      for (let c = 0; c < width; c++) lo[c] = view.getFloat32(at + c * 4, true);
      for (let c = 0; c < width; c++) hi[c] = view.getFloat32(at + width * 4 + c * 4, true);
      at += width * 8;
      for (let v = 0; v < vertices; v++) {
        for (let c = 0; c < width; c++) {
          const q = view.getUint16(at + (v * width + c) * 2, true);
          values[v * width + c] =
            (lo[c] as number) + (q / 65535) * ((hi[c] as number) - (lo[c] as number));
        }
      }
      at = align(at + vertices * width * 2);
    } else if (encoding === OCTAHEDRAL || encoding === OCTAHEDRAL_SIGNED) {
      need(vertices * 4, entry.name);
      for (let v = 0; v < vertices; v++) {
        octDecode(
          view.getInt16(at + v * 4, true),
          view.getInt16(at + v * 4 + 2, true),
          values,
          v * width,
        );
      }
      at += vertices * 4;
      if (encoding === OCTAHEDRAL_SIGNED) {
        need(vertices, `${entry.name}' handedness`);
        for (let v = 0; v < vertices; v++) values[v * 4 + 3] = view.getUint8(at + v) === 1 ? -1 : 1;
        at = align(at + vertices);
      }
    } else {
      throw new DrftError(
        `MSHQ ${entry.name} has encoding ${encoding}, which this reader does not know`,
      );
    }
    out[entry.name] = values;
  }
  const narrow = (flags & INDICES_16) !== 0;
  need(indexCount * (narrow ? 2 : 4), 'its indices');
  const indices = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) {
    const index = narrow ? view.getUint16(at + i * 2, true) : view.getUint32(at + i * 4, true);
    if (index >= vertices)
      throw new DrftError(`MSHQ index ${i} names vertex ${index} of ${vertices}`);
    indices[i] = index;
  }
  out['indices'] = indices;
  return out as unknown as MeshData;
}
