/**
 * Marks on surfaces: one baked into a mesh once, and one projected every frame onto whatever is
 * there.
 *
 * A snippet, typechecked with the examples and quoted by the manual's decals chapter.
 */
import { DecalProjector, projectDecal } from '@driftengine/core';
import type { MeshData, RendererApi } from '@driftengine/core';

// #region baked
/** A scorch mark on a road: the road's own triangles, clipped to a box and lifted off it. */
export function scorch(renderer: RendererApi, road: MeshData, x: number, y: number, z: number) {
  return renderer.createMesh(
    projectDecal(road, {
      center: [x, y, z],
      halfExtents: [1.2, 1.2, 0.6],
      forward: [0, -1, 0],
      up: [0, 0, 1],
      color: [0.2, 0.18, 0.16],
    }),
  );
}
// #endregion

// #region projected
/** A wet patch that follows a moving thing, decided each frame from the depth already drawn. */
const wet = new DecalProjector({
  center: [0, 0, 0],
  halfExtents: [1.2, 1.2, 0.6],
  forward: [0, -1, 0],
  up: [0, 0, 1],
  color: [0.55, 0.6, 0.7],
  softness: 0.6,
});

/** After the opaque geometry it lands on, before `endFrame`. */
export function drawWetPatch(renderer: RendererApi, x: number, y: number, z: number): void {
  wet.setPose([x, y + 0.3, z], [0, -1, 0], [0, 0, 1]);
  renderer.drawDecal(wet);
}
// #endregion
