import {
  PACKED_ATTRIBUTES,
  toFixed16,
  type AttributePacking,
  type VertexPacking,
} from '../../vertexPacking.ts';

/**
 * A mesh's packed attributes as a WebGPU vertex reads them: each one's format and bytes, the words
 * a pipeline key carries for them, and the writers that put sixteen-bit fixed point into the
 * interleaved rows. What is packed how is `vertexPacking.ts`'s decision; this is only its binding.
 *
 * **Sixteen-bit fields are four wide, never three**, because WebGPU has no three-component
 * sixteen-bit format: a normal or a colour takes `x4` and leaves the fourth zero, and the shader's
 * `vec3` input reads the first three. So a normal costs eight bytes here against six on WebGL2,
 * which reads three. Every field stays a whole number of four-byte words, so a vertex does too.
 */

/** The ways an attribute can travel other than as floats, as the key words name them. */
const PACKINGS = ['snorm16', 'unorm16', 'constant'] as const;

/** The pipeline key's word for one attribute's packing. Not a prefix of any other word. */
function word(name: string, packing: AttributePacking): string {
  return `${name}~${packing}`;
}

/** The key's suffix for this packing: one word each attribute not travelling as floats. */
export function packingKey(packing: VertexPacking): string {
  let key = '';
  for (const name of PACKED_ATTRIBUTES) {
    if (packing[name] !== 'float') key += `:${word(name, packing[name])}`;
  }
  return key;
}

/** Mark this packing in a pipeline's `present`, which is what `vertexBufferLayouts` reads. */
export function markPacking(present: Record<string, boolean>, packing: VertexPacking): void {
  for (const name of PACKED_ATTRIBUTES) {
    if (packing[name] !== 'float') present[word(name, packing[name])] = true;
  }
}

/** Mark the packing a mesh's key names, for a pass that has the mesh and not its data. */
export function markPackingOfKey(present: Record<string, boolean>, key: string): void {
  for (const name of PACKED_ATTRIBUTES) {
    for (const packing of PACKINGS) {
      if (key.includes(`:${word(name, packing)}`)) present[word(name, packing)] = true;
    }
  }
}

/** How `present` says this attribute travels: floats unless a word says otherwise. */
export function packingIn(
  present: Readonly<Record<string, boolean>>,
  name: string,
): AttributePacking {
  for (const packing of PACKINGS) {
    if (present[word(name, packing)] === true) return packing;
  }
  return 'float';
}

/** The format an attribute is read with, packed this way, or `float` as given. */
export function packedFormat(float: GPUVertexFormat, packing: AttributePacking): GPUVertexFormat {
  if (packing === 'snorm16') return 'snorm16x4';
  if (packing === 'unorm16') return 'unorm16x4';
  return float;
}

/** Bytes a vertex spends on one attribute read with `format`. */
export function formatBytes(format: GPUVertexFormat): number {
  if (format === 'snorm16x4' || format === 'unorm16x4') return 8;
  if (format === 'float32x4') return 16;
  if (format === 'float32x3') return 12;
  if (format === 'float32x2') return 8;
  return 4;
}

/**
 * One attribute of vertices `from` to `to` into its sixteen-bit field of the interleaved rows,
 * `scale` being `SNORM16_ONE` or `UNORM16_ONE`. Rounded by `toFixed16`, as `fixedArray` rounds
 * for the other backend; the range was checked when the packing was chosen.
 *
 * Unrolled by width, as `interleaveField` is and for its reason: the general loop was most of a
 * heavy load's upload. Three and four are the widths a packed attribute has.
 */
export function interleaveFixed(
  rows: Int16Array | Uint16Array,
  source: Float32Array,
  width: number,
  step: number,
  fieldOffset: number,
  from: number,
  to: number,
  scale: number,
): void {
  let write = from * step + fieldOffset;
  const end = to * width;
  if (width === 3) {
    for (let read = from * 3; read < end; read += 3, write += step) {
      rows[write] = toFixed16(source[read] as number, scale);
      rows[write + 1] = toFixed16(source[read + 1] as number, scale);
      rows[write + 2] = toFixed16(source[read + 2] as number, scale);
    }
  } else {
    for (let read = from * 4; read < end; read += 4, write += step) {
      rows[write] = toFixed16(source[read] as number, scale);
      rows[write + 1] = toFixed16(source[read + 1] as number, scale);
      rows[write + 2] = toFixed16(source[read + 2] as number, scale);
      rows[write + 3] = toFixed16(source[read + 3] as number, scale);
    }
  }
}
