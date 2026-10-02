/**
 * Things you see through, things that add light, and things that are only their own colour.
 *
 * A snippet, typechecked with the examples and quoted by the manual's translucency chapter.
 */
import type { MeshHandle, RendererApi } from '@driftengine/core';

// #region glass
/** A frosted green pane: it lets light through, blurs what is behind it, and tints it. */
export function drawPane(renderer: RendererApi, pane: MeshHandle, model: Float32Array): void {
  renderer.drawTranslucentMesh(pane, model, 1, {
    glass: { transmission: 0.85, frost: 0.35, tint: [0.75, 0.95, 0.85] },
  });
}
// #endregion

// #region refraction
/** A thick lens that bends what is behind it and absorbs a little per metre, as real glass does. */
export function drawLens(renderer: RendererApi, lens: MeshHandle, model: Float32Array): void {
  renderer.drawTranslucentMesh(lens, model, 0.25, {
    refraction: 0.02,
    refractTint: [0.92, 0.97, 1],
    thicknessM: 0.08,
  });
}
// #endregion

// #region additive
/** A lamp's light cone: added onto what is there, so its dark parts are invisible, not black. */
export function drawBeam(renderer: RendererApi, cone: MeshHandle, model: Float32Array): void {
  renderer.drawTranslucentMesh(cone, model, 0.6, { additive: true, lit: false, depthWrite: false });
}
// #endregion

// #region unlit
/** A marker that is exactly its colour, untouched by light, haze or the tone curve. */
export function drawMarker(renderer: RendererApi, marker: MeshHandle, model: Float32Array): void {
  renderer.drawTranslucentMesh(marker, model, 0.9, { lit: false, fog: false, toneMapped: false });
}
// #endregion
