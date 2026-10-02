/**
 * Lights beyond the courtyard example: a measured fixture read from its file, a city's worth of
 * fixed lamps, and a buffer wide enough for clustered shading.
 *
 * A snippet, typechecked with the examples and quoted by the manual's lights chapter.
 */
import { readIesProfile } from '@driftengine/assets';
import {
  DEFAULT_POINT_LIGHT_VIEW_RANGE,
  MAX_CLUSTERED_LIGHTS,
  createLightGrid,
  createPointLightBuffer,
  selectGridLights,
} from '@driftengine/core';
import type { PointLightBuffer, PointLightSource, RendererApi } from '@driftengine/core';

// #region file
/** Load a manufacturer's LM-63 file and hand it to the renderer as row 0 of the atlas. */
export async function loadFixture(renderer: RendererApi, url: string): Promise<void> {
  const text = await (await fetch(url)).text();
  renderer.setIesProfiles([readIesProfile(text)]);
}
// #endregion

// #region grid
/** Thousands of street lamps that never move, bucketed once into twenty-metre cells. */
export function streetLighting(lamps: readonly PointLightSource[], shaded: number) {
  const grid = createLightGrid(lamps, 20);
  const chosen = createPointLightBuffer(shaded);
  return {
    chosen,
    /** The same choice `selectPointLights` makes, looking only at the cells near the eye. */
    choose(x: number, y: number, z: number, time: number): PointLightBuffer {
      selectGridLights(grid, x, y, z, chosen, time, DEFAULT_POINT_LIGHT_VIEW_RANGE);
      return chosen;
    },
  };
}
// #endregion

// #region clustered
/**
 * With `clusteredLights: true` a fragment shades only the lights in its own froxel, so the buffer
 * can be far wider than the sixteen the plain path binds.
 */
export const crowded = createPointLightBuffer(MAX_CLUSTERED_LIGHTS);
// #endregion
