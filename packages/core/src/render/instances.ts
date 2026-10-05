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
 * **What it gives up** is a matrix per instance where a scatter spends five floats: 80 bytes
 * against 44, and no wind. **What would make it wrong** is a caller wanting per-instance
 * anything beyond an opacity — a morph weight, a texture cell — which wants another attribute,
 * and the sixteen WebGL2 guarantees are already spent. The opacity rides the float the stride was
 * padded with, which is why it costs nothing.
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
  /**
   * One float each, the instance's opacity from 0 to 1, which a blended draw
   * (`drawTranslucentInstanced`) multiplies into the batch's own. **Absent, or an instance past its
   * end, is 1** — wholly opaque, which is what every instance was before 4.8.6.
   *
   * What lets one draw carry particles fading at different rates: without it a consumer drew a
   * batch per opacity level, each a draw and a material of its own. It is the instance's twin of
   * the per-vertex alpha lane (`MeshData.channel`), multiplied in where that lane is.
   */
  readonly alphas?: Float32Array;
  /**
   * Four floats each, the instance's region of its lightmap page: `[scaleU, scaleV, biasU, biasV]`,
   * read by a draw whose material is a `lightmapModel` — instances of one mesh in one material sit
   * in different regions of one page, each applied before the material's own region. **They ride
   * the tint and the opacity**, which a lightmapped instance gives up (see `lightmap.ts`): where
   * these are given, those are not read. **A lightmapped batch needs them**, since a bake is
   * different light at each instance; one drawn without them reads its tints as its regions, and
   * either mismatch is said once on the console.
   */
  readonly lightmapRegions?: Float32Array;
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
    alphas: new Float32Array(capacity).fill(1),
    capacity,
    count: 0,
  };
}

/**
 * Floats one instance occupies in the interleaved vertex buffer: sixteen of matrix, three of
 * tint, and the opacity.
 *
 * **Twenty so the stride is 80 bytes rather than 76.** A vertex buffer's stride must be a multiple
 * of four on both backends, which 76 already is — the twentieth float was padding for the
 * *attribute* offsets: the tint sits at byte 64 and a three-float attribute ending at 76 leaves the
 * next instance's first column starting there, which is legal but puts every second instance on an
 * offset no driver aligns well. Since 4.8.6 it carries the instance's opacity, read with the tint
 * as one four-float attribute, so the opacity cost no attribute and no byte.
 */
export const INSTANCE_FLOATS = 20;

/** Bytes one instance occupies. See `INSTANCE_FLOATS`. */
export const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

/**
 * Interleave `count` instances into `out`, matrix, tint and opacity, at `INSTANCE_FLOATS` apart.
 *
 * **Interleaved rather than two buffers** so a batch's upload is one `writeBuffer` and an
 * instance's colour sits beside the matrix that places it. Shared by both backends, because
 * which floats go where is a decision and not a binding — the rule this repository draws around
 * `resolveAtmosphere` and `resolvePointLights`.
 *
 * Writes nothing beyond `count`, and allocates nothing: `out` is the caller's staging array.
 */
export function packInstances(instances: MeshInstances, out: Float32Array): void {
  const { models, tints, alphas, lightmapRegions } = instances;
  const count = Math.min(instances.count, instances.capacity);
  for (let i = 0; i < count; i += 1) {
    const at = i * INSTANCE_FLOATS;
    const m = i * 16;
    for (let c = 0; c < 16; c += 1) out[at + c] = models[m + c] as number;
    if (lightmapRegions !== undefined) {
      /* The region in the tint's and the opacity's place. See `lightmapRegions`. */
      for (let c = 0; c < 4; c += 1) out[at + 16 + c] = lightmapRegions[i * 4 + c] as number;
      continue;
    }
    const t = i * 3;
    out[at + 16] = tints[t] as number;
    out[at + 17] = tints[t + 1] as number;
    out[at + 18] = tints[t + 2] as number;
    out[at + 19] = alphas?.[i] ?? 1;
  }
}

/** How a batch made by `createInstanced` behaves. */
export interface InstancedOptions {
  /**
   * Cull the camera draw: the whole batch skipped when its instances' sphere is out of view or behind
   * the declared occluders, and otherwise each instance kept only where its sphere meets the view —
   * on the CPU on WebGL2, as compute into an indirect draw on WebGPU — once the batch is large enough
   * to repay that (`cullsInstances`); a smaller one is drawn whole. Shadow, mirror-free motion and
   * blended draws still see every instance. Off by default, because a batch small enough to draw whole
   * pays for nothing it would save.
   *
   * **For a batch spread over space** — a prop across a region, a crowd, traffic. A batch in one
   * place gains only the whole-batch test, which it could as well do itself.
   */
  readonly cull?: boolean;
}
