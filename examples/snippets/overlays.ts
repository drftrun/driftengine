/**
 * What a character wears over its materials: a rim of light and a dissolve, set for its draws and
 * taken off after them.
 *
 * A snippet, typechecked with the examples and quoted by the manual's materials chapter.
 */
import type { MeshHandle, RendererApi, SurfaceTextureHandle } from '@driftengine/core';

/** One part of a character: its mesh and its placement. */
interface Part {
  readonly mesh: MeshHandle;
  readonly model: Float32Array;
}

// #region overlay
/** A character in its heat: an orange rim over all of it, and its edges burning away. */
export function drawInHeat(
  renderer: RendererApi,
  character: readonly Part[],
  atlas: SurfaceTextureHandle,
): void {
  const noise = { scale: [0.5, 0.5], offset: [0, 0] } as const;
  renderer.setSurfaceOverlay({
    maps: atlas,
    rim: {
      colour: [1, 0.45, 0.1],
      intensity: 2,
      noise: { region: noise, scroll: [0, 0.2], tiling: 3 },
      pulse: { rate: 1.257, low: 0.6, high: 1 },
    },
    dissolve: {
      noise: { region: noise },
      threshold: 0.4,
      edgeColour: [0.3, 0.8, 1],
      edgeIntensity: 4,
    },
  });
  for (const part of character) renderer.drawMesh(part.mesh, part.model);
  renderer.setSurfaceOverlay(null);
}
// #endregion
