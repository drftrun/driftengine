/**
 * Maps placed by the world: ground whose mesh carries no useful coordinates, and rock that wears its
 * texture on every face without stretching.
 *
 * A snippet, typechecked with the examples and quoted by the manual's materials chapter.
 */
import type { SurfaceMaterial, SurfaceTextureHandle } from '@driftengine/core';

// #region projection
/** Sand, two repeats a metre across the ground, whatever coordinates its mesh carries. */
export function sand(
  colour: SurfaceTextureHandle,
  normal: SurfaceTextureHandle,
): SurfaceMaterial<SurfaceTextureHandle> {
  return { albedo: colour, normal, projection: { kind: 'planar', scale: 2 } };
}

/** Rock, once a metre on all three planes, blended where the surface turns between them. */
export function rock(
  colour: SurfaceTextureHandle,
  orm: SurfaceTextureHandle,
): SurfaceMaterial<SurfaceTextureHandle> {
  return { albedo: colour, orm, projection: { kind: 'triplanar', scale: 1, sharpness: 6 } };
}
// #endregion
