/**
 * Which instances of a batch can be seen: the decision both backends make, and the reference the
 * WebGPU compute cull is held to.
 *
 * **An instance's bounds are the mesh's, placed by its matrix** — the mesh's bounding sphere with its
 * centre through the model matrix and its radius scaled by the largest axis, exactly as
 * `boundsVisible` treats one mesh — so a batch needs no bounds of its own and a caller supplies none.
 * The test is `sphereInFrustum`'s: kept unless wholly beyond one plane.
 *
 * WebGL2 runs `cullInstances` on the CPU; WebGPU runs `CULL_INSTANCES_WGSL`, the same arithmetic, on
 * the device. Both keep what this keeps: `gpu-parity.mjs` compares them on a device. What this gives
 * up is shape: a long thin mesh is culled by the sphere around it, which keeps it in more views than
 * its box would. What would make that wrong is a batch of long thin things seen end on, where a box
 * test pays; nothing in the engine draws those instanced today.
 *
 * Per frame and allocation-free: everything writes into arrays the caller owns.
 */
import type { MeshInstances } from './instances.ts';
import type { Bounds } from '../math/bounds.ts';
import { boxInFrustum } from '../math/frustum.ts';
import type { FrustumPlanes } from '../math/frustum.ts';

/** How many planes a frustum holds, four floats each. */
const PLANES = 6;

/**
 * Indices a culling batch must draw, all its instances together, before culling it instance by
 * instance pays; below it the batch is drawn whole once its box is seen (`batchBoxVisible`).
 *
 * **What a per-instance cull costs is fixed a batch, and what it saves grows with the batch.** On
 * WebGPU it is a dispatch and an indirect draw, and Chrome validates every indirect draw in its GPU
 * process — measured at 8 µs apiece in a city frame whose six hundred small prop batches took one
 * each, 52 fps against 70 with those draws gone. On WebGL2 it is a loop over the instances and an
 * upload of the survivors. A few thousand indices cost a device less than either.
 *
 * What it gives up is the instances of a small batch that stand out of view once its box is in it,
 * which the device transforms and clips for nothing. What would make it wrong is a device whose
 * vertex stage limits the frame while the CPU idles — where this wants to come down.
 */
export const INSTANCE_CULL_MIN_INDICES = 1 << 14;

/**
 * Whether a culling batch of `count` instances of a mesh of `indexCount` indices is culled instance
 * by instance, or drawn whole once its box is seen. See `INSTANCE_CULL_MIN_INDICES`.
 */
export function cullsInstances(count: number, indexCount: number): boolean {
  return count * indexCount >= INSTANCE_CULL_MIN_INDICES;
}

/**
 * Keep the instances of `data` whose spheres meet `frustum`, compacted in order into `out`, and
 * return how many. `out` must hold as many as `data` does; its count is set.
 */
export function cullInstances(
  data: MeshInstances,
  local: Bounds,
  frustum: FrustumPlanes,
  out: MeshInstances,
): number {
  const count = Math.min(data.count, data.capacity, out.capacity);
  const models = data.models;
  const tints = data.tints;
  let kept = 0;
  for (let i = 0; i < count; i++) {
    sphereOf(models, i, local, scratch);
    if (!sphereMeets(frustum, scratch)) continue;
    /* Copied float by float: a subarray would be a view allocated per instance, per frame. */
    const from = i * 16;
    const to = kept * 16;
    for (let k = 0; k < 16; k++) out.models[to + k] = models[from + k] as number;
    out.tints[kept * 3] = tints[i * 3] as number;
    out.tints[kept * 3 + 1] = tints[i * 3 + 1] as number;
    out.tints[kept * 3 + 2] = tints[i * 3 + 2] as number;
    if (out.alphas !== undefined) out.alphas[kept] = data.alphas?.[i] ?? 1;
    const regions = data.lightmapRegions;
    if (regions !== undefined && out.lightmapRegions !== undefined) {
      for (let k = 0; k < 4; k++) out.lightmapRegions[kept * 4 + k] = regions[i * 4 + k] as number;
    }
    kept++;
  }
  out.count = kept;
  return kept;
}

/** `sphereInFrustum` over a packed (x, y, z, radius): kept unless wholly beyond one plane. */
function sphereMeets(frustum: FrustumPlanes, sphere: Float32Array): boolean {
  const x = sphere[0] as number;
  const y = sphere[1] as number;
  const z = sphere[2] as number;
  const radius = sphere[3] as number;
  for (let plane = 0; plane < PLANES; plane++) {
    const at = plane * 4;
    const distance =
      (frustum[at] as number) * x +
      (frustum[at + 1] as number) * y +
      (frustum[at + 2] as number) * z +
      (frustum[at + 3] as number);
    if (distance < -radius) return false;
  }
  return true;
}

/**
 * The world box around every instance's sphere, for testing a whole batch at once: (minX, minY,
 * minZ, maxX, maxY, maxZ) into `out`. A batch holding nothing writes a min above its max.
 *
 * **A box, not a sphere, and the difference is the whole point for a flat batch.** A region of props
 * a hundred metres square has a sphere seventy metres deep underground, where nothing occludes it,
 * so a sphere test never finds a region hidden. The box stays as flat as the props are.
 */
export function instancesBox(data: MeshInstances, local: Bounds, out: Float32Array): void {
  const count = Math.min(data.count, data.capacity);
  if (count === 0) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    out[3] = -1;
    out[4] = -1;
    out[5] = -1;
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    sphereOf(data.models, i, local, scratch);
    const r = scratch[3] as number;
    minX = Math.min(minX, (scratch[0] as number) - r);
    minY = Math.min(minY, (scratch[1] as number) - r);
    minZ = Math.min(minZ, (scratch[2] as number) - r);
    maxX = Math.max(maxX, (scratch[0] as number) + r);
    maxY = Math.max(maxY, (scratch[1] as number) + r);
    maxZ = Math.max(maxZ, (scratch[2] as number) + r);
  }
  out[0] = minX;
  out[1] = minY;
  out[2] = minZ;
  out[3] = maxX;
  out[4] = maxY;
  out[5] = maxZ;
}

const scratch = new Float32Array(4);

/** Instance `i`'s world sphere into `out` as (x, y, z, radius). */
function sphereOf(models: Float32Array, i: number, local: Bounds, out: Float32Array): void {
  const m = i * 16;
  const cx = local.centre[0] ?? 0;
  const cy = local.centre[1] ?? 0;
  const cz = local.centre[2] ?? 0;
  const m0 = models[m] as number;
  const m1 = models[m + 1] as number;
  const m2 = models[m + 2] as number;
  const m4 = models[m + 4] as number;
  const m5 = models[m + 5] as number;
  const m6 = models[m + 6] as number;
  const m8 = models[m + 8] as number;
  const m9 = models[m + 9] as number;
  const m10 = models[m + 10] as number;
  out[0] = m0 * cx + m4 * cy + m8 * cz + (models[m + 12] as number);
  out[1] = m1 * cx + m5 * cy + m9 * cz + (models[m + 13] as number);
  out[2] = m2 * cx + m6 * cy + m10 * cz + (models[m + 14] as number);
  out[3] =
    local.radius *
    Math.sqrt(
      Math.max(
        m0 * m0 + m1 * m1 + m2 * m2,
        m4 * m4 + m5 * m5 + m6 * m6,
        m8 * m8 + m9 * m9 + m10 * m10,
      ),
    );
}

/** What the batch test asks of an occlusion buffer. `OcclusionBuffer` and both renderers answer it. */
export interface BoxOccluder {
  occludedBox(min: ArrayLike<number>, max: ArrayLike<number>): boolean;
}

/**
 * Whether a batch's box (`instancesBox`) can be seen at all: inside the frustum, and not behind the
 * declared occluders. One test for a whole region's props, run before any instance is looked at.
 */
export function batchBoxVisible(
  box: Float32Array,
  frustum: FrustumPlanes,
  occluder: BoxOccluder | null,
): boolean {
  const minX = box[0] as number;
  const minY = box[1] as number;
  const minZ = box[2] as number;
  const maxX = box[3] as number;
  const maxY = box[4] as number;
  const maxZ = box[5] as number;
  if (minX > maxX) return false;
  if (!boxInFrustum(frustum, minX, minY, minZ, maxX, maxY, maxZ)) return false;
  if (occluder === null) return true;
  boxMin[0] = minX;
  boxMin[1] = minY;
  boxMin[2] = minZ;
  boxMax[0] = maxX;
  boxMax[1] = maxY;
  boxMax[2] = maxZ;
  return !occluder.occludedBox(boxMin, boxMax);
}

const boxMin = new Float32Array(3);
const boxMax = new Float32Array(3);
