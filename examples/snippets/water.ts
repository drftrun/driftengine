/**
 * Bodies of water other than the sea: a fountain basin, a canal, and a tank the weather cannot reach.
 *
 * A snippet, typechecked with the examples and quoted by the manual's water chapter.
 */
import { seaStateForWind } from '@driftengine/core';
import type { WaterBody } from '@driftengine/core';

// #region basin
/** A fountain basin: clear enough to see the tiles, a little mirror, and only a breath of wave. */
export const basin: WaterBody = {
  level: 0.6,
  deepColor: [0.05, 0.12, 0.14],
  shallowColor: [0.2, 0.32, 0.3],
  density: 0.25,
  mirror: 0.35,
  waveScale: 0.12,
  bounds: { centreX: 0, centreZ: 0, halfM: 2.5 },
};
// #endregion

// #region channel
/** A canal three metres across and forty long, running north-east. */
export const canal: WaterBody = {
  level: -0.4,
  deepColor: [0.03, 0.06, 0.05],
  shallowColor: [0.08, 0.14, 0.1],
  density: 0.8,
  waveScale: 0.3,
  bounds: { centreX: 20, centreZ: -10, halfX: 1.5, halfZ: 20, forwardX: 1, forwardZ: -1 },
};
// #endregion

// #region tank
/** A flooded corridor: the wind never reaches it, so it says how stirred it is itself. */
export const tank: WaterBody = {
  level: -1,
  deepColor: [0.02, 0.03, 0.03],
  shallowColor: [0.06, 0.08, 0.07],
  density: 0.9,
  agitation: 0.15,
  bounds: { centreX: 0, centreZ: 40, halfX: 2, halfZ: 12 },
};

/** The sea state the renderer would use for a wind, for gameplay that wants the same answer. */
export const choppy = seaStateForWind(8);
// #endregion
