/**
 * A district carried as copies of a kit: an assembly written into a `.drft` beside its pieces, and
 * a region whose finest level is paged in only while it is drawn.
 *
 * A snippet, typechecked with the examples and quoted by the manual's kit chapter.
 */
import { MeshBuilder } from '@driftengine/core';
import type { HlodSet } from '@driftengine/core';
import type { DrftLoader } from '@driftengine/assets';
import { SURFACE, SURFACE_FLOATS, expandAssembly, writeDrft } from '@driftengine/drft';
import type { DrftAssembly } from '@driftengine/drft';

// #region assembly
/** Two pieces, and a tower made of four copies of them: a body, a roof and two columns. */
const box = new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1]).build();
const column = new MeshBuilder().addCylinder([0, 0, 0], 0.5, 0.5, 'y', [1, 1, 1]).build();

const surfaces = new Float32Array(2 * SURFACE_FLOATS);
surfaces.set([0.8, 0.7, 0.6], SURFACE.color);
surfaces.set([0.9, 0.9, 0.88], SURFACE_FLOATS + SURFACE.color);

const UNSTRETCHED = [1, 1, 1, 1, 1, 1, 0, 0];
export const tower: DrftAssembly = {
  attributes: 0,
  surfaces,
  /* By mesh ordinal in the file: 0 is the box and 1 the column. */
  pieces: Uint32Array.of(0, 0, 1, 1),
  surfaceOf: Uint32Array.of(0, 1, 1, 1),
  /* Per copy, the three columns of a scale and then where it stands. */
  transforms: Float32Array.of(
    ...[10, 0, 0, 0, 30, 0, 0, 0, 10, 0, 15, 0],
    ...[11, 0, 0, 0, 1, 0, 0, 0, 11, 0, 30.5, 0],
    ...[0.6, 0, 0, 0, 4, 0, 0, 0, 0.6, -3, 2, 6],
    ...[0.6, 0, 0, 0, 4, 0, 0, 0, 0.6, 3, 2, 6],
  ),
  /* No texture to stretch: a stretch of one along every piece axis, and no offset, a copy. */
  uv: Float32Array.of(...UNSTRETCHED, ...UNSTRETCHED, ...UNSTRETCHED, ...UNSTRETCHED),
};

/** The mesh it describes, as a `MESH` would have carried it. */
export const expanded = expandAssembly(tower, (ordinal) => (ordinal === 0 ? box : column));
// #endregion

// #region container
/** The kit names the pieces; the assembly stands in a mesh slot like any other mesh. */
const block = new MeshBuilder().addBox([0, 15.5, 0], [5.5, 15.5, 5.5], [0.75, 0.68, 0.6]).build();
export const district = writeDrft({
  head: { name: 'district' },
  meshes: [box, column, tower, block],
  kit: [0, 1],
  regions: [
    {
      id: 0,
      bounds: [-6, 0, -6, 6, 31, 7],
      levels: [
        { error: 0, meshes: [2] },
        { error: 1, meshes: [3] },
      ],
      instances: [],
      occluders: new Float32Array(0),
      collision: null,
    },
  ],
  texturesFirst: true,
});
// #endregion

// #region paging
/**
 * Page a region's finest level in while the selection draws it, and out once the eye has left.
 * Until it is resident, the region is drawn at its next level.
 */
const paged = new Map<number, boolean>();
export function pageFinest(loader: DrftLoader, hlod: HlodSet): void {
  for (const region of loader.regions.values()) {
    if (region.levels[0]?.paged !== true) continue;
    const wanted = hlod.levelOf(region.id) === 0;
    if (paged.get(region.id) === wanted) continue;
    paged.set(region.id, wanted);
    loader.pageRegion(region.id, 0, wanted);
  }
}

/** The level to draw for a region the selection put at `level`. */
export function drawnLevel(loader: DrftLoader, id: number, level: number): number {
  const region = loader.regions.get(id);
  if (level === 0 && region?.levels[0]?.resident === false) return 1;
  return level;
}
// #endregion
