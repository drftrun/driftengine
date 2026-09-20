/**
 * Whole meshes out of view, dropped before anything reads their clusters.
 *
 * **An instance here is a mesh**: every cluster names one through `meshOf`, and the raster and the
 * shading both place it by `transforms[mesh]`. A mesh wholly outside the view has nothing to
 * contribute to the frame, and before this every one of its clusters was still cut, tested against
 * six planes and a cone, and occlusion-tested in phase two — correct, and the cost this stage
 * removes.
 *
 * **The flag is read by the cut**, `LOD_CUT_WGSL`, because that is the one per-cluster stage with
 * room for it: the cluster cull binds seven storage buffers and the compaction seven, of the eight a
 * stage may bind by default, and the lookup needs two more (the flags and the cluster's mesh). A
 * cluster the cut does not select is one the cluster cull then skips without testing and the
 * compaction never lists — so a hidden mesh costs a lookup per cluster, and so does every cluster
 * at a level the cut did not choose, which used to be tested for nothing.
 *
 * **The spheres are fitted once, at upload**, from the clusters' world spheres `clusterWorld.ts`
 * already produced, for the reason that file gives: this pipeline's geometry does not move.
 */
import { CLUSTER_CULL_FLOATS } from './cullClusters.ts';
import { sphereOutsideFrustum } from './frustum.ts';
import { clusterSelected } from './lodCut.ts';

/** Four floats a mesh: world centre and radius. `CULL_INSTANCES_WGSL` reads this stride. */
export const INSTANCE_FLOATS = 4;

/** What the instance cull writes for a mesh wholly outside the view. Zero is everything else. */
export const INSTANCE_HIDDEN = 1;

/** Four words a cluster in the uploaded meta: index offset, index count, identifier, mesh. */
export const CLUSTER_META_WORDS = 4;
const META_MESH = 3;

/** Six floats a cluster in the cut's input, as `clusterWorld.ts` lays out `lod`. */
const LOD_FLOATS = 6;

/**
 * Each mesh's world bounding sphere, from the world spheres of its clusters.
 *
 * **Held to the numbers the device reads.** The centre is the middle of the clusters' box, stored
 * in single precision first; the radius is then measured from the *stored* centre and rounded up,
 * never to nearest — a sphere rounded the wrong way is a few parts in ten million short of a
 * cluster's far edge, and a cull that is not conservative is a hole in the picture.
 *
 * A mesh no cluster names is a point at the origin, which draws nothing whatever the cull says. A
 * cluster naming a mesh past `meshCount` is refused: it would be bounded by nothing and drawn by a
 * transform that does not exist.
 */
export function instanceBounds(
  cull: Float32Array,
  meshOf: Uint32Array,
  count: number,
  meshCount: number,
): Float32Array {
  const low = new Float64Array(meshCount * 3).fill(Infinity);
  const high = new Float64Array(meshCount * 3).fill(-Infinity);
  for (let c = 0; c < count; c += 1) {
    const mesh = meshOf[c] as number;
    if (!(mesh < meshCount)) {
      throw new RangeError(
        `instanceBounds: cluster ${String(c)} names mesh ${String(mesh)} and the scene has ${String(meshCount)} meshes`,
      );
    }
    const at = c * CLUSTER_CULL_FLOATS;
    const radius = cull[at + 3] as number;
    for (let axis = 0; axis < 3; axis += 1) {
      const centre = cull[at + axis] as number;
      low[mesh * 3 + axis] = Math.min(low[mesh * 3 + axis] as number, centre - radius);
      high[mesh * 3 + axis] = Math.max(high[mesh * 3 + axis] as number, centre + radius);
    }
  }

  const out = new Float32Array(meshCount * INSTANCE_FLOATS);
  for (let mesh = 0; mesh < meshCount; mesh += 1) {
    if (!((low[mesh * 3] as number) <= (high[mesh * 3] as number))) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      out[mesh * INSTANCE_FLOATS + axis] =
        ((low[mesh * 3 + axis] as number) + (high[mesh * 3 + axis] as number)) / 2;
    }
  }

  const reach = new Float64Array(meshCount);
  for (let c = 0; c < count; c += 1) {
    const mesh = meshOf[c] as number;
    const at = c * CLUSTER_CULL_FLOATS;
    const from = mesh * INSTANCE_FLOATS;
    const distance = Math.hypot(
      (cull[at] as number) - (out[from] as number),
      (cull[at + 1] as number) - (out[from + 1] as number),
      (cull[at + 2] as number) - (out[from + 2] as number),
    );
    reach[mesh] = Math.max(reach[mesh] as number, distance + (cull[at + 3] as number));
  }
  for (let mesh = 0; mesh < meshCount; mesh += 1) {
    const wanted = reach[mesh] as number;
    let radius = Math.fround(wanted);
    /* Up, not to nearest: one step past the rounding is the smallest sphere that still holds. */
    if (radius < wanted) radius = Math.fround(wanted * (1 + 2 ** -23));
    out[mesh * INSTANCE_FLOATS + 3] = radius;
  }
  return out;
}

/**
 * One mesh's bounding sphere, from a contiguous run of its clusters' world bounds.
 *
 * **A run rather than a `meshOf` scan, because a streamed mesh's clusters are contiguous by
 * construction** — the allocator hands out a range — so the scan `instanceBounds` does is work a
 * streaming caller has already done.
 *
 * **A mesh with no clusters gets a sphere of zero radius rather than an empty box's arithmetic.**
 * `Infinity - (-Infinity)` is `-Infinity`, and every comparison against `NaN` is false, which
 * reads as a mesh that is never culled rather than one that is never drawn.
 *
 * The two forms must agree, and `instances.test.ts` is what holds them to it.
 */
export function instanceSphereInto(
  cull: Float32Array,
  from: number,
  count: number,
  out: Float32Array,
  at: number,
): void {
  const base = at * INSTANCE_FLOATS;
  if (count <= 0) {
    out[base] = 0;
    out[base + 1] = 0;
    out[base + 2] = 0;
    out[base + 3] = 0;
    return;
  }

  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let c = from; c < from + count; c += 1) {
    const record = c * CLUSTER_CULL_FLOATS;
    const radius = cull[record + 3] as number;
    for (let axis = 0; axis < 3; axis += 1) {
      const centre = cull[record + axis] as number;
      low[axis] = Math.min(low[axis] as number, centre - radius);
      high[axis] = Math.max(high[axis] as number, centre + radius);
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    out[base + axis] = ((low[axis] as number) + (high[axis] as number)) / 2;
  }

  /* The reach from that centre, which is what makes the sphere hold every cluster rather than
     every corner of the box — the same second pass `instanceBounds` makes, for the same reason. */
  let reach = 0;
  for (let c = from; c < from + count; c += 1) {
    const record = c * CLUSTER_CULL_FLOATS;
    const distance = Math.hypot(
      (cull[record] as number) - (out[base] as number),
      (cull[record + 1] as number) - (out[base + 1] as number),
      (cull[record + 2] as number) - (out[base + 2] as number),
    );
    reach = Math.max(reach, distance + (cull[record + 3] as number));
  }
  let radius = Math.fround(reach);
  /* Up, not to nearest: one step past the rounding is the smallest sphere that still holds. */
  if (radius < reach) radius = Math.fround(reach * (1 + 2 ** -23));
  out[base + 3] = radius;
}

/**
 * One flag a mesh: `INSTANCE_HIDDEN` where its sphere is wholly outside the view. Returns how many
 * are. Mirrors `CULL_INSTANCES_WGSL`, which `gpu-parity.mjs` holds to `sphereOutsideFrustum`.
 */
export function cullInstances(
  planes: Float32Array,
  spheres: Float32Array,
  count: number,
  out: Uint32Array,
): number {
  let hidden = 0;
  for (let i = 0; i < count; i += 1) {
    const at = i * INSTANCE_FLOATS;
    const outside = sphereOutsideFrustum(
      planes,
      spheres[at] as number,
      spheres[at + 1] as number,
      spheres[at + 2] as number,
      spheres[at + 3] as number,
    );
    out[i] = outside ? INSTANCE_HIDDEN : 0;
    if (outside) hidden += 1;
  }
  return hidden;
}

/**
 * The cut, over every cluster, with the instance flags applied first: one flag a cluster, and how
 * many were selected. Mirrors `LOD_CUT_WGSL`.
 */
export function selectClusters(
  lod: Float32Array,
  meta: Uint32Array,
  hidden: Uint32Array,
  screenHeight: number,
  fovY: number,
  thresholdPixels: number,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  out: Uint32Array,
): number {
  const count = Math.floor(lod.length / LOD_FLOATS);
  let chosen = 0;
  for (let i = 0; i < count; i += 1) {
    const mesh = meta[i * CLUSTER_META_WORDS + META_MESH] as number;
    if ((hidden[mesh] ?? 0) !== 0) {
      out[i] = 0;
      continue;
    }
    const at = i * LOD_FLOATS;
    const selected = clusterSelected(
      lod[at + 4] as number,
      lod[at + 5] as number,
      Math.hypot(
        (lod[at] as number) - eyeX,
        (lod[at + 1] as number) - eyeY,
        (lod[at + 2] as number) - eyeZ,
      ),
      lod[at + 3] as number,
      screenHeight,
      fovY,
      thresholdPixels,
    );
    out[i] = selected ? 1 : 0;
    if (selected) chosen += 1;
  }
  return chosen;
}
