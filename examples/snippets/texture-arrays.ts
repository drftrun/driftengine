/**
 * A texture array: many images of one size as one texture, a layer chosen per vertex, and what each
 * layer does beyond its picture.
 *
 * A snippet, typechecked with the examples and quoted by the manual's texture arrays chapter.
 */
import { MeshBuilder, concatMeshes, createEnvironment, generateTangents } from '@driftengine/core';
import type { MeshData, RendererApi } from '@driftengine/core';

// #region array
/**
 * Three images of one size: a facade whose windows are holes in its alpha, a sign, and the room a
 * window looks into. Each layer's effects are given beside it; a layer with none is `undefined`.
 */
export function facadeArray(renderer: RendererApi, images: readonly HTMLImageElement[]) {
  return renderer.createSurfaceTextureArray(images, {
    colorSpace: 'srgb',
    effects: [
      {
        windows: { cells: [6, 12], glass: true, glow: 1.2, seed: 3 },
        interior: { roomLayer: 2, depth: 0.5, lit: 0.7 },
        wear: { grime: 0.35, streaks: 0.25, fade: 120 },
      },
      { animation: { scroll: [0.15, 0], pulse: [0.5, 0.3] } },
      undefined,
    ],
  });
}
// #endregion

// #region layers
/**
 * A builder has no layer channel, so each piece is built, given its layer, then joined. Rooms behind
 * windows are drawn through the mesh's tangent frame, so the pieces get tangents as well.
 */
function onLayer(mesh: MeshData, layer: number): MeshData {
  const uvs = mesh.uvs ?? new Float32Array((mesh.positions.length / 3) * 2);
  return {
    ...mesh,
    tangents: generateTangents(mesh.positions, mesh.normals, uvs, mesh.indices),
    layers: new Float32Array(mesh.positions.length / 3).fill(layer),
  };
}

export function building(): MeshData {
  const tower = new MeshBuilder()
    .addBox([0, 20, 0], [8, 20, 8], [1, 1, 1])
    .build({ planarUvs: true });
  const sign = new MeshBuilder()
    .addQuad([-4, 3, 8.05], [4, 3, 8.05], [4, 5, 8.05], [-4, 5, 8.05], [1, 1, 1], 1)
    .build({ planarUvs: true });
  return concatMeshes([onLayer(tower, 0), onLayer(sign, 1)]);
}
// #endregion

// #region scene
/** The scene's half: how wet it is, how many windows are lit, and the clock the animations run on. */
export const NIGHT = createEnvironment({
  directionalDir: [0.2, 0.9, 0.3],
  directionalColor: [0.2, 0.24, 0.35],
  ambient: [0.05, 0.06, 0.09],
  nightFactor: 1,
  emissiveGain: 1,
  litWindows: 0.45,
  lateWindows: 0.08,
  wetness: 0.3,
  surfaceTime: 0,
});
// #endregion
