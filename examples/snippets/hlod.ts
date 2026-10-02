/**
 * Hierarchical detail baked offline and carried in a `.drft`: a proxy for a group of cells, a tree
 * as its own pictures, and regions a loader hands to `HlodSet`.
 *
 * A snippet, typechecked with the examples and quoted by the manual's hierarchical detail chapter.
 */
import { MeshBuilder, mulberry32 } from '@driftengine/core';
import type { HlodSet, RendererApi } from '@driftengine/core';
import { DrftLoader, buildImpostor, buildProxy, sampleImpostor } from '@driftengine/assets';
import { writeDrft } from '@driftengine/drft';

// #region proxy
/** A yard of two hundred crates, and the one mesh that stands in for it from a distance. */
const random = mulberry32(3);
const yard = new MeshBuilder();
for (let i = 0; i < 200; i += 1) {
  const x = random() * 40;
  const z = random() * 40;
  const s = 0.4 + random() * 0.6;
  yard.addBox([x, s, z], [s, s, s], [0.5, 0.4, 0.3]);
}
const crates = yard.build();
/** Level 1: a 16-cell outline. `null` when the outline would not be under half the crates' cost. */
export const yardProxy = buildProxy([{ id: 0, meshes: [crates] }], 1);
// #endregion

// #region impostor
/** A tree baked as eight by eight pictures, one for each direction it may be seen from. */
const tree = new MeshBuilder()
  .addCylinder([0, 1.5, 0], 0.2, 1.5, 'y', [0.35, 0.25, 0.18])
  .addSphere([0, 4, 0], 1.8, [0.2, 0.42, 0.18])
  .build();
export const treePictures = buildImpostor(tree, 8);

/** What the tree looks like from the east, at the middle of its picture: RGBA. */
export const fromTheEast = new Float32Array(4);
sampleImpostor(treePictures, [1, 0, 0], 0.5, 0.5, fromTheEast);
// #endregion

// #region container
/** One block as a region in a container: its levels name the meshes they draw, finest first. */
const fine = new MeshBuilder().addBox([50, 30, 50], [7, 30, 7], [0.6, 0.6, 0.6]).build();
const coarse = new MeshBuilder().addBox([50, 30, 50], [7.3, 30, 7.3], [0.55, 0.55, 0.55]).build();
export const city = writeDrft({
  head: { name: 'city' },
  meshes: [fine, coarse],
  regions: [
    {
      id: 0,
      bounds: [0, 0, 0, 100, 60, 100],
      levels: [
        { error: 0, meshes: [0] },
        { error: 0.5, meshes: [1] },
      ],
      instances: [],
      occluders: new Float32Array([43, 0, 43, 57, 60, 57]),
      collision: null,
    },
  ],
});
// #endregion

// #region loaded
/** Stream the container; each region is handed over ahead of the meshes it draws. */
export async function openCity(renderer: RendererApi, url: string): Promise<DrftLoader> {
  const loader = new DrftLoader(renderer);
  await loader.load(url, { fit: 'none' });
  return loader;
}

/** Once a frame: upload what has arrived, and admit each region whose meshes are all up. */
export function admitRegions(loader: DrftLoader, hlod: HlodSet, dtSec: number): void {
  loader.update(dtSec);
  for (const region of loader.regions.values()) {
    if (region.pending !== 0 || hlod.has(region.id)) continue;
    hlod.add(
      region.id,
      region.bounds,
      region.levels.map((level) => level.error),
    );
  }
}
// #endregion
