import type { MeshData } from '@driftengine/drft';

/**
 * How each of a mesh's vertex attributes travels to the device, decided once from its data and
 * bound by each backend: as floats, as sixteen-bit fixed point, or as one value every vertex
 * shares.
 *
 * **Only what reads back as it went, or near enough that no picture can tell.** One value every
 * vertex shares is exact, and is a constant rather than a stream: a colour or an emissive naming
 * no difference between vertices costs nothing a vertex, where both were always stored per vertex.
 * A unit direction — a normal, a tangent and its handedness — in sixteen-bit signed fixed point is
 * within 1/32767 a component, a few thousandths of a degree: measured against floats, 12 pixels of
 * 921,600 moved in one published scene, by 2 of 255 on average, and none in the other eight.
 * Colours and skin weights inside [0, 1] in sixteen-bit unsigned fixed point are within 1/65535. A
 * textured vertex with a tangent frame, white and not glowing, goes from 64 bytes to 36 on WebGPU.
 *
 * **What it gives up.** Eight-bit normals would save four bytes more and are not taken: a normal in
 * steps of 1/127 can band a highlight. **Texture coordinates stay floats**, in any range: a
 * coordinate on a tile's far edge rounds past it in sixteen-bit fixed point, by 1/131,070, and a
 * pixel there samples the neighbouring tile of an atlas — measured as 29 pixels moved by 62 of 255
 * in the voxel scene, every one at a face's edge — and a half float, which steps by a 2048th near
 * 1.0, is worse. A dynamic mesh's normals stay floats, because each rewrite would have to be packed
 * on the CPU. What would make this wrong is a value outside its range, which the range check sends
 * to floats rather than clamping, or a shader reading an attribute as something other than the
 * value it carries.
 */

/** Floats; sixteen-bit fixed point, signed or not; or one value for every vertex. */
export type AttributePacking = 'float' | 'snorm16' | 'unorm16' | 'constant';

/** The attributes this decides for. Every other one travels as floats. */
export const PACKED_ATTRIBUTES = [
  'normals',
  'tangents',
  'colors',
  'emissive',
  'weights',
  'weights2',
] as const;

export type PackedAttribute = (typeof PACKED_ATTRIBUTES)[number];

export type VertexPacking = Readonly<Record<PackedAttribute, AttributePacking>>;

/** The choice for this mesh. `dynamic` is a mesh whose positions and normals are rewritten. */
export function vertexPackingOf(data: MeshData, dynamic: boolean): VertexPacking {
  return {
    normals: dynamic ? 'float' : fixedOrFloat(data.normals, -1),
    tangents: fixedOrFloat(data.tangents, -1),
    colors: shared(data.colors, 3) ? 'constant' : fixedOrFloat(data.colors, 0),
    emissive: shared(data.emissive, 1) ? 'constant' : 'float',
    weights: fixedOrFloat(data.weights, 0),
    weights2: fixedOrFloat(data.weights2, 0),
  };
}

/**
 * What 1 is in each fixed point, the values WebGPU's `snorm16` and `unorm16` and WebGL2's
 * normalised `SHORT` and `UNSIGNED_SHORT` divide by. A value is stored rounded to nearest, so 1, 0
 * and -1 come back exactly.
 */
export const SNORM16_ONE = 32767;
export const UNORM16_ONE = 65535;

/** One value in the fixed point whose 1 is `one`, rounded to nearest: the only place it is. */
export function toFixed16(value: number, one: number): number {
  return Math.round(value * one);
}

/** An attribute's values in its fixed point, tightly, for a backend reading separate arrays. */
export function fixedArray(
  values: Float32Array,
  packing: 'snorm16' | 'unorm16',
): Int16Array | Uint16Array {
  const out =
    packing === 'snorm16' ? new Int16Array(values.length) : new Uint16Array(values.length);
  const one = packing === 'snorm16' ? SNORM16_ONE : UNORM16_ONE;
  for (let at = 0; at < values.length; at++) out[at] = toFixed16(values[at] as number, one);
  return out;
}

/** How `name` travels under this packing: floats for an attribute it does not decide for. */
export function packingFor(packing: VertexPacking, name: string): AttributePacking {
  return (packing as Readonly<Record<string, AttributePacking>>)[name] ?? 'float';
}

/** The value every vertex shares, for an attribute packed as `'constant'`. */
export function sharedValue(values: Float32Array, width: number): number[] {
  return Array.from(values.subarray(0, width));
}

/** Fixed point where every value lies in [low, 1]; floats otherwise, and for a NaN. */
function fixedOrFloat(values: Float32Array | undefined, low: -1 | 0): AttributePacking {
  if (values === undefined) return 'float';
  for (let at = 0; at < values.length; at++) {
    const value = values[at] as number;
    if (!(value >= low && value <= 1)) return 'float';
  }
  return low < 0 ? 'snorm16' : 'unorm16';
}

/** Whether every vertex holds the first vertex's value. Not for a mesh of none. */
function shared(values: Float32Array, width: number): boolean {
  if (values.length < width) return false;
  for (let at = width; at < values.length; at++) {
    if (values[at] !== values[at % width]) return false;
  }
  return true;
}
