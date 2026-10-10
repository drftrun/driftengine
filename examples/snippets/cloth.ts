/**
 * Garments stepped together: a character's cloth as one set, posed one garment at a time and
 * stepped once a frame, with a cap on the steps a slow frame may ask for.
 *
 * A snippet, typechecked with the examples and quoted by the manual's cloth chapter.
 */
import { createSkinnedClothSet } from '@driftengine/core';
import type { RendererApi, SkinnedClothSet } from '@driftengine/core';
import type { SkinnedClothSetup } from '@driftengine/physics';

// #region set
/** Every garment of a character in one set, each held to two steps a frame. */
export function wardrobe(renderer: RendererApi, garments: readonly SkinnedClothSetup[]) {
  return createSkinnedClothSet(
    renderer,
    garments.map((setup) => ({ ...setup, parameters: { ...setup.parameters, maxSteps: 2 } })),
  );
}

/** Once a frame, before the draws: each garment's rig, then one step for all of them. */
export function stepWardrobe(
  set: SkinnedClothSet,
  globals: Float32Array,
  model: Float32Array,
  dt: number,
): void {
  for (let g = 0; g < set.particles.length; g += 1) set.setPose(g, globals, model);
  set.step(dt);
}
// #endregion
