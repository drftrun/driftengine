/**
 * The hour's light: the sun or the moon, the sky, the ambient, the exposure and the air, resolved
 * from the site's clock and the palette into the environment and sky the frame draws with.
 *
 * One object holding the environment and the sky, rewritten in place every frame, so the scene
 * allocates nothing to change the hour.
 */
import {
  celestialStateAt,
  createCelestialState,
  createDaylightState,
  createEnvironment,
  easeExposure,
  moonIllumination,
  resolveDaylight,
} from '../../packages/core/src/index';
import type { Environment, SkyColors, Vec3 } from '../../packages/core/src/index';
import { NORTH, SITE, instantOf } from './clock';
import { PALETTE } from './palette';

/** How long the eye takes to close half the distance to a new exposure, in seconds. */
const ADAPT_HALF_LIFE_SEC = 1.5;
/** Below this elevation the moon is the key light. Both are dark either side of it. */
const MOON_BELOW_DEG = -5;
/**
 * The fires and candles are lit as the sun goes from 3° up to 2° under, which is the palette's
 * first lamps: about three seconds of the loop.
 */
const LIT_FROM_DEG = 3;
const LIT_OVER_DEG = 5;
/**
 * The sun's light at the ground goes out between these, and its disc in the sky does not.
 *
 * A setting sun is behind the far side's roof long before it reaches the horizon, and what little
 * clears it has come through forty air masses. The palette gives the disc its colour to the
 * horizon and beyond, which is right for the sky and was wrong for the light: a sun 2° under
 * still lit the courtyard at half its horizon strength. Put out by a tenth of a degree, because
 * that is where the scene's shadow gives way; what would make it wrong is a site with a sea
 * horizon, where the last of the sun really does reach the ground.
 */
const SUN_GONE_DEG = 0.1;
const SUN_FULL_DEG = 2;

/**
 * How much the courtyard's air scatters, by the sun's elevation: the shafts through the arches.
 *
 * **Clear air until the sun is under 15°**, then rising to a thousandth at 5°, and nothing once it
 * has set, since the medium scatters the sun alone. Per metre. It rose from 40° until 2026-09-26, and
 * then from 20° to three thousandths, and both read as fog: the courtyard seen down the upper gallery
 * at seven in the evening went milky grey. The place is sharp to the far wall at any hour the sun is
 * up in every photograph of it. What would make this wrong is a shaft that fogs out the far wall.
 *
 * The haze also stopped hard beside every pier that stood nearer than it, which was taken for the
 * density and was not: the dirt decal's sheets wrote depth where they overhang a corner, and the
 * march ended at them. See `BLENDED` in `packs.ts`.
 */
function hazeAt(elevationDeg: number): number {
  if (elevationDeg <= 0) return 0;
  const low = Math.min(1, Math.max(0, (15 - elevationDeg) / 10));
  const setting = Math.min(1, elevationDeg / 3);
  return 0.001 * low * setting;
}

export class SponzaLight {
  readonly env: Environment;
  readonly sky: SkyColors;
  private readonly celestial = createCelestialState();
  private readonly daylight = createDaylightState();
  /** The exposure the eye has reached, eased toward the hour's. */
  exposure = 0;
  /** The sun's elevation, in degrees. */
  elevationDeg = 0;
  /** How lit the fires are, 0 by day and 1 from the palette's first lamps. */
  lit = 0;
  /** The air's density. See `hazeAt`. */
  haze = 0;

  constructor() {
    this.env = createEnvironment({
      directionalDir: [0, 1, 0],
      directionalColor: [0, 0, 0],
      ambient: [0, 0, 0],
      ambientGround: [0, 0, 0],
      emissiveGain: 0,
      nightFactor: 0,
      fogColor: [0, 0, 0],
      fogDensity: 0,
      fogHeightFalloff: 0.02,
      fogBaseY: 0,
    });
    this.sky = {
      top: [0, 0, 0],
      horizon: [0, 0, 0],
      deep: [0, 0, 0],
      sunDir: this.celestial.sunDir,
      sunColor: [0, 0, 0],
      sunAngularRadius: 0.0047,
      moonDir: this.celestial.moonDir,
      moonColor: [0.66, 0.71, 0.86],
      moonAngularRadius: 0.014,
      moonPhase: 0,
      nightFactor: 0,
      cloudOffsetX: 0,
      cloudOffsetZ: 0,
    };
  }

  /**
   * The light at `hour` into the environment and the sky. `adapted` starts the eye at the hour's
   * exposure, which a held hour wants; otherwise it eases there over `dtSec`.
   */
  apply(hour: number, dtSec: number, adapted: boolean): void {
    const state = this.celestial;
    celestialStateAt(instantOf(hour), NORTH, state, SITE);
    const elevationDeg = (Math.asin(state.sunDir[1]) * 180) / Math.PI;
    const light = resolveDaylight(elevationDeg, PALETTE, this.daylight);
    const env = this.env;
    const sky = this.sky;

    const moonUp = Math.min(1, Math.max(0, state.moonDir[1] * 5));
    const moonlit = moonIllumination(state.moonPhase) * moonUp;
    const byMoon = elevationDeg < MOON_BELOW_DEG;
    const dir = byMoon ? state.moonDir : state.sunDir;
    const color = byMoon ? light.moonColor : light.sunColor;
    const scale = byMoon
      ? moonlit
      : Math.min(1, Math.max(0, (elevationDeg - SUN_GONE_DEG) / (SUN_FULL_DEG - SUN_GONE_DEG)));
    for (let c = 0; c < 3; c++) {
      env.directionalDir[c] = dir[c] as number;
      env.directionalColor[c] = (color[c] as number) * scale;
      env.ambient[c] = light.ambient[c] as number;
      (env.ambientGround as Vec3)[c] = light.ambientGround[c] as number;
      (env.fogColor as Vec3)[c] = light.fogColor[c] as number;
      sky.top[c] = light.skyTop[c] as number;
      sky.horizon[c] = light.skyHorizon[c] as number;
      sky.deep[c] = light.skyDeep[c] as number;
      (sky.sunColor as Vec3)[c] = light.sunColor[c] as number;
    }
    env.fogDensity = light.fogDensity;
    env.shadowStrength = light.shadowStrength;
    env.emissiveGain = light.emissiveGain;
    env.nightFactor = state.nightFactor;
    sky.nightFactor = state.nightFactor;
    sky.moonPhase = state.moonPhase;

    this.exposure =
      adapted || this.exposure === 0
        ? light.exposure
        : easeExposure(this.exposure, light.exposure, dtSec, ADAPT_HALF_LIFE_SEC);
    this.elevationDeg = elevationDeg;
    this.lit = Math.min(1, Math.max(0, (LIT_FROM_DEG - elevationDeg) / LIT_OVER_DEG));
    this.haze = hazeAt(elevationDeg);
  }
}
