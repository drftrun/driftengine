/**
 * Rock with moss and sand laid over it by a mask, each at its own repeat.
 *
 * A snippet, typechecked with the examples and quoted by the manual's materials chapter.
 */
import type { SurfaceMaterial, SurfaceTextureHandle } from '@driftengine/core';

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
