/**
 * A banner that shows the light behind it through itself.
 *
 * A snippet, typechecked with the examples and quoted by the manual's materials chapter.
 */
import type { SurfaceMaterial, SurfaceTextureHandle } from '@driftengine/core';

// #region thin
/** Cloth seen from either side, letting most of the light behind it through. */
export function banner(cloth: SurfaceTextureHandle): SurfaceMaterial<SurfaceTextureHandle> {
  return { albedo: cloth, doubleSided: true, diffuseTransmission: 0.7 };
}
// #endregion
