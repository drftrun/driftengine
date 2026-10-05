/**
 * Bloom that answers as a stage authored for another engine asks.
 *
 * A snippet, typechecked with the examples and quoted by the manual's post-processing chapter.
 */
import type { RendererApi } from '@driftengine/core';

// #region response
/**
 * A colour comes in over two units past the threshold rather than having the threshold taken off
 * it, and each of the six levels, finest first, is weighted by a stage's own tint. Both thresholds
 * are compared before exposure, so a frame exposed by `exposure` divides them by it.
 */
export function stageBloom(renderer: RendererApi, exposure: number): void {
  renderer.setBloom(1, 0.1 / exposure, {
    ramp: 2 / exposure,
    tints: [
      0.35, 0.35, 0.35, 0.14, 0.14, 0.14, 0.12, 0.12, 0.12, 0.07, 0.07, 0.07, 0.07, 0.07, 0.07,
      0.06, 0.06, 0.06,
    ],
  });
}
// #endregion
