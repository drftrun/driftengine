/**
 * DriftLight for a whole city: every street lamp summed offline into one dense volume, written into
 * the world's file, and handed to the renderer when the file streams in.
 *
 * A snippet, typechecked with the examples and quoted by the manual's DriftLight chapter.
 */
import { streamDrft, writeDrft } from '@driftengine/drft';
import type { DrftSource } from '@driftengine/drft';
import { bakeDenseField } from '@driftengine/core';
import type { DenseLightVolume, PointLightSource, RendererApi } from '@driftengine/core';

// #region bake
/** Offline, in a build script: sum every lamp over two kilometres at eight metres a sample. */
export function bakeCityLight(lamps: readonly PointLightSource[]): DenseLightVolume {
  return bakeDenseField(lamps, 'smooth', null, [-1000, 0, -1000, 1000, 128, 1000], 8);
}

/** And store it in the world's file, as one `LVOL` chunk. */
export function writeWorld(world: DrftSource, lamps: readonly PointLightSource[]): ArrayBuffer {
  return writeDrft({ ...world, lightVolume: bakeCityLight(lamps) });
}
// #endregion

// #region load
/** In the game: the volume arrives with the file, and the lamps it summed are marked as summed. */
export async function openCity(
  renderer: RendererApi,
  url: string,
  lamps: PointLightSource[],
): Promise<void> {
  for (const lamp of lamps) lamp.inLightField = true;
  await streamDrft(await fetch(url), {
    onLightVolume: (volume) => renderer.createWorldLightField(volume, { fadeSec: 0 }),
  });
}
// #endregion
