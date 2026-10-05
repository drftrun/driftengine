/**
 * Lights beyond the courtyard example: a measured fixture read from its file, a city's worth of
 * fixed lamps, a buffer wide enough for clustered shading, a character's own light on a channel of
 * its own, and more rectangles than the fixed four.
 *
 * A snippet, typechecked with the examples and quoted by the manual's lights chapter.
 */
import { readIesProfile } from '@driftengine/assets';
import {
  DEFAULT_POINT_LIGHT_VIEW_RANGE,
  MAX_CLUSTERED_LIGHTS,
  createAreaLightBuffer,
  createLightGrid,
  createPointLightBuffer,
  selectAreaLights,
  selectGridLights,
} from '@driftengine/core';
import type {
  AreaLightSource,
  Environment,
  PointLightBuffer,
  PointLightSource,
  RendererApi,
  SurfaceMaterial,
  SurfaceTextureHandle,
} from '@driftengine/core';

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

// #region channels
/** The channel a character's own lights are on. The stage's lights stay on 1, the default. */
export const CHARACTER_LIGHTS = 2;

/**
 * After the selection, each chosen light's channel from the source it came from: the key light on
 * the character's channel, everything else on the stage's.
 */
export function lightChannels(env: Environment, chosen: PointLightBuffer, keyLight: number): void {
  const channels = env.lightChannels;
  if (channels === undefined) return;
  for (let slot = 0; slot < chosen.count; slot += 1) {
    channels[slot] = chosen.sourceIndex[slot] === keyLight ? CHARACTER_LIGHTS : 1;
  }
}

/** The character takes the stage's light and its own; the floor, naming nothing, the stage's. */
export const characterMaterial: SurfaceMaterial<SurfaceTextureHandle> = {
  lightChannels: 1 | CHARACTER_LIGHTS,
};
// #endregion

// #region rectangles
/**
 * A row of ceiling panels, more than the fixed four. With `clusteredLights` on, the rectangles past
 * `maxAreaLights` are shaded through the froxel table, each out to its `range`.
 */
export function ceilingPanels(env: Environment, count: number): void {
  const panels: AreaLightSource[] = [];
  for (let i = 0; i < count; i += 1) {
    panels.push({
      x: -10 + i * 2,
      y: 3.5,
      z: 0,
      r: 6,
      g: 6,
      b: 5.4,
      /* It emits along right x up, which is straight down. */
      rightX: 1,
      rightY: 0,
      rightZ: 0,
      upX: 0,
      upY: 0,
      upZ: 1,
      halfWidth: 0.6,
      halfHeight: 0.15,
      range: 6,
    });
  }
  const buffer = createAreaLightBuffer(count);
  selectAreaLights(panels, buffer);
  env.areaLights = buffer;
}
// #endregion
