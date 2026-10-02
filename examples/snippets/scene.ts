/**
 * The scene graph: a hierarchy with bounds, a culled walk over it, levels of detail chosen by how
 * big a thing looks, and declared occluders.
 *
 * A snippet, typechecked with the examples and quoted by the manual's scene graph chapter.
 */
import {
  Camera,
  MeshBuilder,
  SceneNode,
  createFrustum,
  createVisitResult,
  frustumFromViewProjection,
  lodForBounds,
  visitVisible,
} from '@driftengine/core';
import type { Environment, MeshHandle, RendererApi } from '@driftengine/core';

// #region hierarchy
/** A tower of blocks under one root: move the root and every block moves with it. */
export function buildTower(renderer: RendererApi): { root: SceneNode; block: MeshHandle } {
  const block = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [0.7, 0.7, 0.75]).build(),
  );
  const root = new SceneNode();
  for (let level = 0; level < 10; level += 1) {
    const node = new SceneNode();
    node.setPosition(0, level + 0.5, 0);
    // The mesh's bounds were measured when it was uploaded; the node only says it holds them.
    node.setBounds(block.bounds);
    root.attachChild(node);
  }
  root.setPosition(4, 0, -6);
  root.updateWorld();
  return { root, block };
}
// #endregion

// #region visit
const frustum = createFrustum();
const counts = createVisitResult();

/** Draw only what the camera can see. A rejected parent rejects its whole subtree in one test. */
export function drawVisible(
  renderer: RendererApi,
  camera: Camera,
  env: Environment,
  root: SceneNode,
  block: MeshHandle,
): void {
  frustumFromViewProjection(camera.viewProjection, frustum);
  renderer.bindMeshPass(camera, env);
  visitVisible(root, frustum, (node) => renderer.drawMesh(block, node.worldMatrix), counts);
  // counts.visited, counts.pruned and counts.tested say what the walk saved.
}
// #endregion

// #region lod
/** Apparent sizes, in radians, at which each level stops being good enough. */
const THRESHOLDS = [0.2, 0.06, 0.015];

/** The finest level a thing has earned, from how big it looks, not how far away it is. */
export function levelFor(node: SceneNode, camera: Camera): number {
  const eye = camera.position;
  return lodForBounds(node.worldBounds, node.worldMatrix, eye[0], eye[1], eye[2], THRESHOLDS);
}
// #endregion

// #region occlusion
const WALL_MIN = [-6, 0, -0.5];
const WALL_MAX = [6, 8, 0.5];
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Hide what a wall hides. Needs `occlusionCulling` set in the quality profile, the width of the
 * occlusion buffer in texels; without it `addOccluder` does nothing and `occluded` answers false.
 */
export function drawBehindWall(
  renderer: RendererApi,
  camera: Camera,
  env: Environment,
  wall: MeshHandle,
  crates: readonly SceneNode[],
  crate: MeshHandle,
): void {
  renderer.bindMeshPass(camera, env);
  // After binding the pass and before the first draw: the first test freezes the buffer.
  renderer.addOccluder(WALL_MIN, WALL_MAX, IDENTITY);
  renderer.drawMesh(wall, IDENTITY);
  for (const node of crates) {
    if (!renderer.occluded(crate.bounds, node.worldMatrix))
      renderer.drawMesh(crate, node.worldMatrix);
  }
}
// #endregion
