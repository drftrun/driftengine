/**
 * A stage's baked light: a page decoded from another tool's bake, a mesh carrying its second
 * coordinates, and copies of one mesh each lit by its own region of the page.
 *
 * A snippet, typechecked with the examples and quoted by the manual's materials chapter.
 */
import { createMeshInstances, lightmapModel } from '@driftengine/core';
import type {
  LightmapPage,
  MeshData,
  MeshInstances,
  RendererApi,
  SurfaceMaterial,
  SurfaceTextureHandle,
} from '@driftengine/core';

// #region page
/** A floor lit by the left half of a page: the page uploaded, the mesh given its coordinates. */
export function bakedFloor(
  renderer: RendererApi,
  page: LightmapPage,
  floor: MeshData,
  lightmapUvs: Float32Array,
  albedo: SurfaceTextureHandle,
) {
  const lightmap = renderer.createLightmap(page);
  const mesh = renderer.createMesh({ ...floor, lightmapUvs });
  /* Where the floor is on the page, as [scaleU, scaleV, biasU, biasV]. */
  const material: SurfaceMaterial<SurfaceTextureHandle> = {
    albedo,
    model: lightmapModel({ region: [0.5, 1, 0, 0] }),
    modelMap: lightmap,
  };
  return { mesh, material };
}
// #endregion

// #region instances
/** Pillars in one batch, each lit by its own column of one page. */
export function bakedPillars(count: number): MeshInstances {
  const instances = {
    ...createMeshInstances(count),
    lightmapRegions: new Float32Array(count * 4),
  };
  for (let i = 0; i < count; i += 1) {
    instances.lightmapRegions.set([1 / count, 1, i / count, 0], i * 4);
  }
  instances.count = count;
  return instances;
}
// #endregion
