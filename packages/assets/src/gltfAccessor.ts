import { DrftError } from '@driftengine/drft';

import type { GltfDocument } from './gltf.ts';

/**
 * Reading one glTF accessor into floats, and the two tables that describe one.
 *
 * **Its own module so `gltfSkin.ts` and `gltf.ts` can both use it without importing each other.**
 * The skin reader needs the graph the mesh reader deliberately discards, and the mesh reader needs
 * the skin reader's remap — which would be a runtime import cycle if the accessor reader stayed in
 * either of them. The `GltfDocument` type still comes from `gltf.ts` and costs nothing: a type
 * import is erased, so no cycle survives to run.
 *
 * Every component type widens to `Float32Array`, which is what `MeshData` carries throughout —
 * including `JOINTS_0`, whose unsigned bytes are exact in float32 well past the 512-joint cap.
 */

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

export function accessorFloats(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  index: number,
  what: string,
): Float32Array {
  const accessor = doc.accessors?.[index];
  if (accessor === undefined)
    throw new DrftError(`gltf: ${what} names accessor ${index}, which is absent`);
  if (accessor.sparse !== undefined) {
    throw new DrftError(
      `gltf: ${what} uses a sparse accessor, which this reader does not implement. ` +
        `Re-export without sparse accessors, or convert with a tool that expands them.`,
    );
  }
  const components = TYPE_COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (components === undefined || componentBytes === undefined) {
    throw new DrftError(
      `gltf: ${what} has an unsupported type ${accessor.type}/${accessor.componentType}`,
    );
  }

  const out = new Float32Array(accessor.count * components);
  if (accessor.bufferView === undefined) return out; // Defined as zeroes.

  const bufferView = doc.bufferViews?.[accessor.bufferView];
  if (bufferView === undefined)
    throw new DrftError(`gltf: ${what} names a bufferView that is absent`);
  const source = buffers[bufferView.buffer];
  if (source === undefined)
    throw new DrftError(`gltf: ${what} names buffer ${bufferView.buffer}, absent`);

  const stride = bufferView.byteStride ?? components * componentBytes;
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);

  /* Normalised integers carry their range in the type, which is why this is not a cast. */
  const scale = accessor.normalized === true ? normalisedScale(accessor.componentType) : 1;

  for (let i = 0; i < accessor.count; i++) {
    const at = base + i * stride;
    for (let c = 0; c < components; c++) {
      const offset = at + c * componentBytes;
      if (offset + componentBytes > source.byteLength) {
        throw new DrftError(`gltf: ${what} reads past the end of its buffer at ${offset}`);
      }
      out[i * components + c] = readComponent(view, offset, accessor.componentType) * scale;
    }
  }
  return out;
}

function readComponent(view: DataView, at: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(at);
    case 5121:
      return view.getUint8(at);
    case 5122:
      return view.getInt16(at, true);
    case 5123:
      return view.getUint16(at, true);
    case 5125:
      return view.getUint32(at, true);
    default:
      return view.getFloat32(at, true);
  }
}

function normalisedScale(componentType: number): number {
  switch (componentType) {
    case 5120:
      return 1 / 127;
    case 5121:
      return 1 / 255;
    case 5122:
      return 1 / 32767;
    case 5123:
      return 1 / 65535;
    default:
      return 1;
  }
}

/**
 * The matrix a skinned primitive is built with: none.
 *
 * A palette entry already carries its joint's inverse bind, so it takes a vertex from model space
 * to where the joint moved it — and `uModel` then places the character. Baking the node's world
 * matrix in as well applies that placement twice and throws the rig across the scene. See
 * `gltfSkin.ts`.
 */
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
