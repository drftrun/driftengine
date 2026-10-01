/**
 * What hides things and what stops a walker, region by region: occluder boxes from the buildings'
 * coarse boxes, and one collision mesh from the coarse level's opaque geometry.
 *
 * **An occluder must stand inside what it stands for**, or it hides what shows past a corner. A
 * building's box turned square to the axes is its own box; turned any other way, the largest square
 * whose corners stay inside it, since `OcclusionBuffer` takes boxes square to the axes. **It starts
 * a storey up** — a ground floor is arcades and lobbies and doors, open more often than a wall is.
 * **None narrower or lower than the coarse level's error**: an occluder that small hides little
 * and costs a draw into the buffer like any other.
 *
 * **Collision is the coarse level's opaque copies, welded**: a building's boxes, the pavements,
 * the kerbs broad enough to keep, the walls. What a walker meets is what a distant eye sees, stood
 * where most of each wall stands, so an awning does not wall off the pavement under it. Furniture
 * does not collide yet. Welded to the millimetre, a box is its eight corners.
 */
import type { MeshData } from '@driftengine/drft';

import { COARSE_ERROR } from '../mesh/region.ts';

/**
 * The occluder for a box `w` × `d` turned by `yaw` about (x, z), from `bottom` up to `top`: min xyz
 * then max xyz, or null for one too small to be worth drawing.
 */
export function occluderBox(
  x: number,
  z: number,
  yaw: number,
  w: number,
  d: number,
  bottom: number,
  top: number,
): number[] | null {
  const quarters = yaw / (Math.PI / 2);
  const k = Math.round(quarters);
  let [hx, hz] = [0, 0];
  if (Math.abs(quarters - k) < 1e-3) {
    const swap = Math.abs(k) % 2 === 1;
    [hx, hz] = swap ? [d / 2, w / 2] : [w / 2, d / 2];
  } else {
    const half = Math.min(w, d) / 2 / (Math.abs(Math.cos(yaw)) + Math.abs(Math.sin(yaw)));
    [hx, hz] = [half, half];
  }
  if (2 * Math.min(hx, hz) < COARSE_ERROR || top - bottom < COARSE_ERROR) return null;
  return [x - hx, bottom, z - hz, x + hx, top, z + hz];
}

/** Meshes as one triangle soup, corners within a millimetre merged and what that flattens dropped. */
export function welded(meshes: readonly MeshData[]): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const at = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of meshes) {
    const p = mesh.positions;
    const local = new Uint32Array(p.length / 3);
    for (let v = 0; v < local.length; v++) {
      const q = [0, 1, 2].map((a) => Math.round((p[v * 3 + a] as number) * 1000));
      const key = q.join(',');
      let index = at.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        positions.push(...q.map((c) => c / 1000));
        at.set(key, index);
      }
      local[v] = index;
    }
    const idx = mesh.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const [a, b, c] = [
        local[idx[t] as number] as number,
        local[idx[t + 1] as number] as number,
        local[idx[t + 2] as number] as number,
      ];
      if (a !== b && b !== c && a !== c) indices.push(a, b, c);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
