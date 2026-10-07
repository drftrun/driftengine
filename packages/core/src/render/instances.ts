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
 * anything beyond an opacity and a texture cell — a morph weight, say — which wants another
 * attribute, and the sixteen WebGL2 guarantees are already spent. The opacity rides the float the
 * stride was padded with and the cell the matrix's bottom row, which is why neither costs a byte.
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
  /**
   * Four floats each, the instance's cell of its texture: `[scaleU, scaleV, offsetU, offsetV]`,
   * applied to the mesh's coordinates before the material's own scale and offset, in every pass
   * that reads them — so one draw carries particles in different cells of a flipbook, or props
   * wearing different tiles of one atlas. **Absent, or past `count`, is the whole texture**,
   * `[1, 1, 0, 0]`, which is what every instance read before 4.8.7.
   *
   * **It rides the matrix's bottom row**, which an instance's placement — a turn, a scale and a
   * move — leaves at `[0, 0, 0, 1]`, and which every stage drawing an instance rebuilds as that.
   * So a placement must be affine, as every placement of a solid object is; a projective one is
   * drawn as its affine part. A culled batch (`cullInstances`) carries the cells only into a
   * target that has the array.
   */
  readonly uvRegions?: Float32Array;
  /** How many instances the arrays hold. Fixed at creation; the buffers are sized from it. */
  /**
   * Two floats each, the instance's clock for a batch that plays a bone animation
   * (`InstancedOptions.animation`): its phase in seconds, added to the scene's time once the rate has
   * scaled it, and its rate, 1 for the clip's own speed. **Absent, or an instance past its end, is
   * `(0, 1)`** — every instance at the clip's speed and in step. Read by `uploadInstanced`, as the
   * matrices are; a batch with no animation ignores it.
   */
  readonly clocks?: Float32Array;
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
 * Floats one instance occupies in the interleaved vertex buffer: sixteen of matrix, the bottom row
 * of which carries the texture cell, three of tint, and the opacity.
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
  const { models, tints, alphas, lightmapRegions, uvRegions } = instances;
  const count = Math.min(instances.count, instances.capacity);
  for (let i = 0; i < count; i += 1) {
    const at = i * INSTANCE_FLOATS;
    const m = i * 16;
    for (let c = 0; c < 16; c += 1) out[at + c] = models[m + c] as number;
    /* The texture cell in the bottom row an affine placement leaves free. See `uvRegions`. */
    const cell = i * 4;
    out[at + 3] = uvRegions?.[cell] ?? 1;
    out[at + 7] = uvRegions?.[cell + 1] ?? 1;
    out[at + 11] = uvRegions?.[cell + 2] ?? 0;
    out[at + 15] = uvRegions?.[cell + 3] ?? 0;
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

import type { BoneAnimationHandle } from './boneAnimation.ts';

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
  /**
   * A bone animation every instance plays (`createBoneAnimation`): each vertex follows the bone its
   * mesh's second coordinates name, at the instance's own moment of the clip (`MeshInstances.clocks`
   * and the clock `setAnimationTime` sets), in the colour pass and in every shadow. The mesh must
   * carry second coordinates. See `boneAnimation.ts`.
   *
   * **An animated batch is culled whole, never instance by instance**: its instances read their
   * clocks by index, which a cull that compacts the survivors would reorder. And its bounds are the
   * rest pose's, so a clip that carries vertices far from it wants a mesh whose bounds hold them.
   *
   * **What it gives up**: under reconstruction or the temporal resolve, a crowd's own movement is not
   * in the frame's motion — the motion pass places a batch by its matrices, not by its clip — so its
   * moving parts are reprojected as though still, which softens a fast clip a little; and a glass
   * batch's coloured shadow is cast from rest. What would make the first wrong is a clip fast enough
   * at the size it is seen to smear, which is then the motion pass's to learn.
   */
  readonly animation?: BoneAnimationHandle;
}
