/**
 * A first-person view model: arms and a held weapon drawn in the nearest sliver of depth, so they
 * never go into the wall they are pushed against and the world's depth is never cleared.
 *
 * A snippet, typechecked with the examples and quoted by the manual's text-and-overlays chapter.
 */
import type { Camera, Environment, MeshHandle, RendererApi } from '@driftengine/core';

// #region view-model
/** The world first, then the view model over it, through the same camera. */
export function drawWithViewModel(
  renderer: RendererApi,
  camera: Camera,
  env: Environment,
  world: () => void,
  weapon: MeshHandle,
  weaponModel: Float32Array,
): void {
  renderer.bindMeshPass(camera, env);
  world();
  renderer.beginViewModel();
  renderer.drawMesh(weapon, weaponModel);
  renderer.endViewModel();
}
// #endregion
