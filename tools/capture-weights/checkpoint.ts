/**
 * A checkpoint's tensors as a file holds them, whichever format it is: a name, a shape, an element
 * type and the bytes — contiguous, row-major and little-endian, as every format read here stores
 * them — decoded to numbers only when an architecture asks for them.
 *
 * **Decoding is by the file's own type, never assumed.** A checkpoint may keep its weights in
 * single, half or brain-float precision, and a counter or an index in integers; reading an integer
 * as floats would be a network built from noise, so only the floating types decode, and any other
 * is refused by the tensor's name.
 */
import { fromHalfBits } from '../../packages/texture/src/index.ts';

export interface StoredTensor {
  readonly dtype: string;
  readonly shape: readonly number[];
  readonly bytes: Uint8Array;
}

/** The bytes one element of each type takes, by the names safetensors gives the types. */
export const ELEMENT_BYTES: Readonly<Record<string, number>> = {
  F64: 8,
  F32: 4,
  F16: 2,
  BF16: 2,
  I64: 8,
  I32: 4,
  I16: 2,
  I8: 1,
  U8: 1,
  BOOL: 1,
};

export function elementCount(shape: readonly number[]): number {
  let count = 1;
  for (const d of shape) count *= d;
  return count;
}

/* A brain float is the top half of a single; this is where the two halves are joined. */
const JOIN = new DataView(new ArrayBuffer(4));

/** A floating-point tensor's values in single precision; any other type is refused by name. */
export function tensorFloats(name: string, tensor: StoredTensor): Float32Array {
  const count = elementCount(tensor.shape);
  const view = new DataView(tensor.bytes.buffer, tensor.bytes.byteOffset, tensor.bytes.byteLength);
  const out = new Float32Array(count);
  switch (tensor.dtype) {
    case 'F32':
      for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(4 * i, true);
      return out;
    case 'F64':
      for (let i = 0; i < count; i += 1) out[i] = view.getFloat64(8 * i, true);
      return out;
    case 'F16':
      for (let i = 0; i < count; i += 1) out[i] = fromHalfBits(view.getUint16(2 * i, true));
      return out;
    case 'BF16':
      for (let i = 0; i < count; i += 1) {
        JOIN.setUint32(0, view.getUint16(2 * i, true) << 16, true);
        out[i] = JOIN.getFloat32(0, true);
      }
      return out;
    default:
      throw new Error(
        `tensor "${name}" holds ${tensor.dtype}, which are not floating-point values`,
      );
  }
}
