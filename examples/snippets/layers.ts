/**
 * Rock with moss and sand laid over it by a mask, each at its own repeat.
 *
 * A snippet, typechecked with the examples and quoted by the manual's materials chapter.
 */
import type { SurfaceLayers, SurfaceMaterial, SurfaceTextureHandle } from '@driftengine/core';

// #region layers
/**
 * Three layers in three arrays — rock, moss, sand, the same order in each — and a mask whose red
 * lays the moss and green the sand. The rock repeats forty times across the mesh, the moss three.
 */
export function mossyRock(
  albedo: SurfaceTextureHandle,
  normal: SurfaceTextureHandle,
  orm: SurfaceTextureHandle,
  mask: SurfaceTextureHandle,
): SurfaceMaterial<SurfaceTextureHandle> {
  return { albedo, normal, orm, layers: { mask, repeats: [40, 3, 12] } };
}
// #endregion

// #region shared
/**
 * Two cliffs that share one array of each kind, every texture in it once. Each cliff picks its
 * layers by index and gives them a look of its own; its own mask and its occlusion sit past the
 * shared textures, at `extrasAt` in the ORM array.
 */
export function sharedCliffs(
  albedo: SurfaceTextureHandle,
  normal: SurfaceTextureHandle,
  orm: SurfaceTextureHandle,
): SurfaceMaterial<SurfaceTextureHandle>[] {
  const warm: SurfaceLayers<SurfaceTextureHandle> = {
    mask: 'orm',
    repeats: [8, 4, 16],
    /* Rock, moss and sand: textures 0, 5 and 2 of every array. */
    arrayLayers: [0, 5, 2],
    /* This cliff's mask is the ORM array's layer 30, and its occlusion the one after. */
    extrasAt: 30,
    meshOcclusion: 0.8,
    looks: [{ tint: [1.2, 1, 0.85], roughness: [0.6, 0.95] }, { normalStrength: 2 }],
  };
  /* The same rock, darker and smoother, under a different moss: nothing new uploaded. */
  const cold: SurfaceLayers<SurfaceTextureHandle> = {
    ...warm,
    arrayLayers: [0, 7, 2],
    extrasAt: 32,
    looks: [{ tint: [0.7, 0.75, 0.85], roughness: [0.3, 0.6] }],
  };
  return [
    { albedo, normal, orm, layers: warm },
    { albedo, normal, orm, layers: cold },
  ];
}
// #endregion
