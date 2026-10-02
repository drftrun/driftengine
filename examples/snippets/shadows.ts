/**
 * The sun's shadow in its three layers, and a caster list that carries every kind of draw.
 *
 * A snippet, typechecked with the examples and quoted by the manual's shadows chapter.
 */
import { computeLightMatrix } from '@driftengine/core';
import type {
  Environment,
  InstancedHandle,
  MeshHandle,
  MeshInstances,
  RendererApi,
  ShadowCasters,
  SurfaceTextureHandle,
} from '@driftengine/core';

// #region layers
/**
 * The still world is drawn into its layers only when the light's matrix moves, which it does in
 * whole texels; whatever moves is drawn into the dynamic layer every frame.
 */
export function sunShadows(
  renderer: RendererApi,
  env: Environment,
  still: ShadowCasters,
  moving: ShadowCasters,
): (x: number, y: number, z: number) => void {
  const matrix = new Float32Array(16);
  const drawnWith = new Float32Array(16);
  env.lightViewProj = matrix;
  env.shadowStrength = 0.85;

  return (x, y, z) => {
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      x,
      y,
      z,
      40,
      renderer.shadowMapSize,
      matrix,
    );
    if (matrix.some((value, i) => value !== drawnWith[i])) {
      renderer.beginShadowPass(matrix, 'static');
      renderer.drawShadowCasters(still);
      renderer.endShadowPass();
      renderer.beginShadowPass(matrix, 'static-peel');
      renderer.drawShadowCasters(still);
      renderer.endShadowPass();
      drawnWith.set(matrix);
    }
    renderer.beginShadowPass(matrix, 'dynamic');
    renderer.drawShadowCasters(moving);
    renderer.endShadowPass();
  };
}
// #endregion

// #region sink
/** One list for every kind of caster: a mesh, a cutout, a skinned figure and an instanced batch. */
export function townCasters(
  town: { house: MeshHandle; houseModel: Float32Array },
  hedge: { mesh: MeshHandle; model: Float32Array; leaves: SurfaceTextureHandle },
  hero: { mesh: MeshHandle; model: Float32Array; palette: Float32Array },
  trees: { batch: InstancedHandle; data: MeshInstances },
): ShadowCasters {
  return (sink) => {
    sink.mesh(town.house, town.houseModel);
    /* A cutout casts the leaves, not the card they are painted on. */
    sink.mesh(hedge.mesh, hedge.model, { albedo: hedge.leaves, cutout: 0.5 });
    /* The same palette the visible draw uses, or the shadow is the bind pose. */
    sink.skinnedMesh(hero.mesh, hero.model, hero.palette);
    sink.instanced?.(trees.batch, trees.data);
  };
}
// #endregion
