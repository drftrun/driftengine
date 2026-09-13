import type { PlumePlacement } from './plumeRenderer.ts';

/**
 * The crossed quads a plume batch is drawn from, built once for both backends.
 *
 * **Two blades rather than a billboard, and two rather than three.** A single card turned to
 * face the viewer has no three-dimensional structure to see — orbiting a fire showed the same
 * silhouette from every angle — while a fixed cross has the parallax a volume has and never
 * goes edge-on, because its partner is square-on at that exact moment. The third blade costs
 * 50% more geometry for a difference the eye does not separate at these sizes.
 *
 * Here rather than in `plumeRenderer.ts` because a second copy of a mesh generator is a plume
 * whose triangles differ per backend, which is the 2026-08-13 rule in `AGENTS.md`.
 */
export const PLUME_BLADES = 2;
export const PLUME_VERTS = PLUME_BLADES * 4;

/** Corners of one blade, as a quad. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

/** The five attribute streams and the index list. */
export interface PlumeGeometryData {
  readonly centers: Float32Array;
  readonly corners: Float32Array;
  readonly sizes: Float32Array;
  readonly seeds: Float32Array;
  readonly blades: Float32Array;
  readonly indices: Uint32Array;
}

export function buildPlumeGeometry(plumes: readonly PlumePlacement[]): PlumeGeometryData {
  const count = plumes.length;
  const centers = new Float32Array(count * PLUME_VERTS * 3);
  const corners = new Float32Array(count * PLUME_VERTS * 2);
  const sizes = new Float32Array(count * PLUME_VERTS * 2);
  const seeds = new Float32Array(count * PLUME_VERTS);
  const blades = new Float32Array(count * PLUME_VERTS);
  const indices = new Uint32Array(count * 6 * PLUME_BLADES);

  for (let f = 0; f < count; f++) {
    const plume = plumes[f];
    if (plume === undefined) continue;
    for (let b = 0; b < PLUME_BLADES; b++) {
      for (let c = 0; c < 4; c++) {
        const v = f * PLUME_VERTS + b * 4 + c;
        const corner = CORNERS[c] ?? [0, 0];
        centers[v * 3] = plume.x;
        centers[v * 3 + 1] = plume.y;
        centers[v * 3 + 2] = plume.z;
        corners[v * 2] = corner[0];
        corners[v * 2 + 1] = corner[1];
        sizes[v * 2] = plume.width;
        sizes[v * 2 + 1] = plume.height;
        // Golden-ratio phase offset: neighbours never animate in step.
        seeds[v] = f * 0.618;
        // Which blade of the cross this vertex belongs to.
        blades[v] = b;
      }
      const base = f * PLUME_VERTS + b * 4;
      const i = (f * PLUME_BLADES + b) * 6;
      indices[i] = base;
      indices[i + 1] = base + 1;
      indices[i + 2] = base + 2;
      indices[i + 3] = base;
      indices[i + 4] = base + 2;
      indices[i + 5] = base + 3;
    }
  }
  return { centers, corners, sizes, seeds, blades, indices };
}
