/**
 * One distance field over a file's static geometry, for tracing indirect light through a scene.
 *
 * **One field for the scene rather than one per mesh, because a bought scene is shaped against the
 * per-mesh bake.** Its walls come as a few meshes spanning the whole of it, so a field sized to
 * each mesh's longest side is metre-wide voxels on exactly the walls the light bounces off, and
 * four hundred of them add more than the model's own geometry. Merged, the same scene is one grid
 * at a voxel size the caller chooses: 25 cm resolves a column, and a courtyard is three megabytes.
 *
 * **What goes in is the caller's to say**, for the reason `addDistanceField` gives: light is traced
 * against what it is safe to be blocked by. Walls and floors, not foliage, not cloth, not the copies
 * of a candle drawn ten thousand times. What it gives up is movement: a merged field is static, so
 * anything that moves wants a field of its own.
 */
import { concatMeshes } from '@driftengine/core';
import { SDFV_WHOLE_FILE } from '@driftengine/drft';
import type { DrftSdfvEntry, MeshData } from '@driftengine/drft';
import { bakeObjectSdf } from './sdf.ts';

/**
 * The field of every mesh `include` admits, merged, at `voxelM` spacing, as the file's
 * whole-geometry entry. Null when nothing is admitted.
 */
export function bakeSceneField(
  meshes: readonly MeshData[],
  voxelM: number,
  include: (index: number) => boolean,
): DrftSdfvEntry | null {
  const chosen: MeshData[] = [];
  for (let index = 0; index < meshes.length; index++) {
    if (include(index)) chosen.push(meshes[index] as MeshData);
  }
  if (chosen.length === 0) return null;
  const merged = concatMeshes(chosen);
  const positions = merged.positions;
  let longest = 0;
  for (let axis = 0; axis < 3; axis++) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let at = axis; at < positions.length; at += 3) {
      const value = positions[at] as number;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    longest = Math.max(longest, hi - lo);
  }
  const resolution = Math.max(2, Math.ceil(longest / voxelM) + 1);
  const baked = bakeObjectSdf(merged, resolution);
  return { mesh: SDFV_WHOLE_FILE, dims: baked.dims, bounds: baked.bounds, field: baked.field };
}
