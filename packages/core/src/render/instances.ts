/**
 * One base mesh's per-instance placement and colour.
 *
 * **Many copies of one mesh are one draw and one material.** A street of thirty cars of five
 * models is five draws rather than thirty, and — the half that is easy to miss — five *material*
 * changes rather than thirty, which on the WebGPU backend is the scarcer of the two.
 *
 * Distinct from `InstanceData`, which `createScatter` takes, and deliberately not merged with it:
 * a scatter instance carries a uniform scale, a yaw and a wind response, because it describes a
 * plant. This one carries a full transform, because a vehicle pitches and rolls on its suspension
 * and a yaw cannot say so.
 *
 * **What it gives up** is a matrix per instance where a scatter spends five floats: 76 bytes
 * against 44, and no wind. **What would make it wrong** is a caller wanting per-instance
 * anything else — an opacity, a morph weight — which wants another attribute, and the sixteen
 * WebGL2 guarantees are already spent.
 */
export interface MeshInstances {
  /**
   * Sixteen floats each, column-major: one model matrix per instance.
   *
   * The same layout `drawMesh` takes, so a caller that already builds a matrix per object passes
   * what it has rather than decomposing it.
   */
  readonly models: Float32Array;
  /**
   * Three floats each, multiplied into the base mesh's colour exactly as `drawMesh`'s tint is.
   *
   * White is the identity. A batch whose instances share a colour still spends three floats each
   * — the alternative is a second batch per colour, which is the thing this exists to avoid.
   */
  readonly tints: Float32Array;
  /** How many instances the arrays hold. Fixed at creation; the buffers are sized from it. */
  readonly capacity: number;
  /** How many are live. The rest of the buffer is neither uploaded nor drawn. */
  count: number;
}

/**
 * Allocate both arrays at `capacity`, empty.
 *
 * Allocated once and rewritten in place, never per frame — the arrays are the caller's to fill
 * and the count is the caller's to set, which is what keeps a frame that redraws a batch
 * allocation-free.
 */
export function createMeshInstances(capacity: number): MeshInstances {
  return {
    models: new Float32Array(capacity * 16),
    tints: new Float32Array(capacity * 3),
    capacity,
    count: 0,
  };
}

/**
 * Floats one instance occupies in the interleaved vertex buffer: sixteen of matrix, three of
 * tint, and one of padding.
 *
 * **Padded to twenty so the stride is 80 bytes rather than 76.** A vertex buffer's stride must be
 * a multiple of four on both backends, which 76 already is — the padding is for the *attribute*
 * offsets: the tint sits at byte 64 and a three-float attribute ending at 76 leaves the next
 * instance's first column starting there, which is legal but puts every second instance on an
 * offset no driver aligns well. One wasted float an instance is 4 bytes against 76.
 */
export const INSTANCE_FLOATS = 20;

/** Bytes one instance occupies. See `INSTANCE_FLOATS`. */
export const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

/**
 * Interleave `count` instances into `out`, matrix then tint, at `INSTANCE_FLOATS` apart.
 *
 * **Interleaved rather than two buffers** so a batch's upload is one `writeBuffer` and an
 * instance's colour sits beside the matrix that places it. Shared by both backends, because
 * which floats go where is a decision and not a binding — the rule this repository draws around
 * `resolveAtmosphere` and `resolvePointLights`.
 *
 * Writes nothing beyond `count`, and allocates nothing: `out` is the caller's staging array.
 */
export function packInstances(instances: MeshInstances, out: Float32Array): void {
  const { models, tints } = instances;
  const count = Math.min(instances.count, instances.capacity);
  for (let i = 0; i < count; i += 1) {
    const at = i * INSTANCE_FLOATS;
    const m = i * 16;
    for (let c = 0; c < 16; c += 1) out[at + c] = models[m + c] as number;
    const t = i * 3;
    out[at + 16] = tints[t] as number;
    out[at + 17] = tints[t + 1] as number;
    out[at + 18] = tints[t + 2] as number;
  }
}
