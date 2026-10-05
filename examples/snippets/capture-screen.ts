/**
 * A screen in the world showing what a second camera sees: the scene captured into a texture once
 * a frame, and that texture a material's emissive map.
 *
 * A snippet, typechecked with the examples and quoted by the manual's materials chapter.
 */
import { Camera } from '@driftengine/core';
import type { Environment, MeshHandle, RendererApi, Vec3 } from '@driftengine/core';

// #region screen
/** A 1024 by 576 capture, made once with the scene, and the camera that films it. */
export function createBroadcast(renderer: RendererApi) {
  const feed = renderer.createSceneCapture(1024, 576);
  const camera = new Camera();
  camera.fovYDeg = 35;
  return { feed, camera, screen: { emissive: feed } };
}

/** Each frame: film the world first, then draw the frame with the screen showing the film. */
export function drawWithScreen(
  renderer: RendererApi,
  broadcast: ReturnType<typeof createBroadcast>,
  viewer: Camera,
  env: Environment,
  clear: Vec3,
  drawWorld: () => void,
  screenMesh: MeshHandle,
  screenPlacement: Float32Array,
): void {
  renderer.beginFrame(clear);
  renderer.captureScene(broadcast.feed, broadcast.camera, clear, (filming) => {
    renderer.bindMeshPass(filming, env);
    drawWorld();
  });
  renderer.bindMeshPass(viewer, env);
  drawWorld();
  renderer.setMaterial(broadcast.screen);
  renderer.drawMesh(screenMesh, screenPlacement);
  renderer.setMaterial(null);
  renderer.endFrame();
}
// #endregion
