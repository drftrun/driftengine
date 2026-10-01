/**
 * The sky over the city and the light it gives, at the city's hour: the sun, the moon and the stars
 * where they stand at 36° north on the 215th day of the year, the reference's own site; the daylight
 * a palette of how far the sun is up; height fog at the reference's numbers.
 *
 * **Two nights, on purpose.** The sky's night is the sun's: stars come out as it sets. The city's is
 * its timetable (`nightAt`): lamps and windows come on over its dusk ramp whatever the sky is doing,
 * which is what a city's lighting does. The two agree at the ends and part a little between.
 *
 * **Colours from the reference where it states them**: its sun tint and strength, its moon's tint,
 * its fog's colour and falloff. Where it does not — the palette's sky and ambient — they are chosen
 * to read as its captures do, and are the first thing a side-by-side comparison should correct.
 *
 * **Rain closes the sky.** The schedule rains every night, and the reference's rainy midnight is a
 * low overcast lit from below by the city — one even mauve, (67, 51, 58) on screen, with no star and
 * no moon in it — where a clear palette drew a black sky full of stars over a downpour. So the sky's
 * colours go toward that overcast as the rain thickens, by night, or toward a day's grey cloud, and
 * the stars, the moon's disc and its light go behind it. The overcast's colour is chosen against
 * the reference's capture, through this frame's own tone curve.
 *
 * Nothing here reads a clock: the hour is handed in, and the instant built from it is the same on
 * every machine because the site names its meridian.
 */
import {
  celestialStateAt,
  createCelestialState,
  createDaylightPalette,
  createDaylightState,
  moonIllumination,
  resolveDaylight,
} from '../../packages/core/src/index';
import type {
  Camera,
  CelestialSite,
  Environment,
  RendererApi,
  SkyColors,
  Vec3,
} from '../../packages/core/src/index';

import { nightAt } from './clock';

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

const SITE: CelestialSite = { latitudeDeg: 36, longitudeDeg: 0, dayOfYear: 215 };
/** The instant of the year's first midnight the city's hours are counted from, UTC. */
const YEAR = Date.UTC(2026, 0, 1);
const MS_PER_HOUR = 3_600_000;
const DAY_OF_YEAR = 215;
/** The sun's azimuth relative to the world's axes: the scripts' `north_offset`, 0. */
const NORTH = 0;

/** The reference's sun: its tint, 255 214 176, at its directional strength 1.5, linear. */
const SUN: Vec3 = [1.5, 1.01, 0.65];
/** Its moon's tint, 180 196 255, dimmed to moonlight. */
const MOON: Vec3 = [0.07, 0.085, 0.15];
/** Its height fog's colour, 58 40 74, linear, and a day haze. */
const NIGHT_FOG: Vec3 = [0.042, 0.021, 0.069];
const DAY_FOG: Vec3 = [0.55, 0.6, 0.68];
/** Its height fog: density, falloff, the height it thins from. */
const FOG_DENSITY = 0.0035;
const FOG_FALLOFF = 0.055;
const FOG_BASE_Y = -3;
/** How many of the lit windows stay lit latest: the scripts' late share. */
const LATE_WINDOWS = 0.35;
/** The overcast by night, lit from below by the city, and by day, a rain cloud's grey. */
const OVERCAST_NIGHT: Vec3 = [0.125, 0.089, 0.107];
const OVERCAST_DAY: Vec3 = [0.42, 0.44, 0.48];
/** How much rain closes the sky: the lightest drizzle starts it, a third of full rain closes it. */
const OVERCAST_FROM = 0.03;
const OVERCAST_TO = 0.35;
/** The moon's own tint, as the sky draws its disc: 180 196 255. */
const MOON_DISC: Vec3 = [0.46, 0.55, 1];

const PALETTE = createDaylightPalette([
  {
    at: 0,
    sunColor: [0, 0, 0],
    moonColor: MOON,
    skyTop: [0.004, 0.005, 0.012],
    skyHorizon: [0.03, 0.02, 0.05],
    skyDeep: [0.002, 0.002, 0.006],
    /* A city's night is not dark: its own lights come back off the haze over it. */
    ambient: [0.05, 0.038, 0.06],
    ambientGround: [0.03, 0.022, 0.026],
    fogColor: NIGHT_FOG,
    fogDensity: FOG_DENSITY,
    shadowStrength: 0.4,
    emissiveGain: 1,
    exposure: 1,
  },
  {
    at: 1,
    sunColor: SUN,
    moonColor: [0, 0, 0],
    skyTop: [0.18, 0.32, 0.62],
    skyHorizon: [0.62, 0.66, 0.72],
    skyDeep: [0.3, 0.32, 0.36],
    ambient: [0.34, 0.37, 0.44],
    ambientGround: [0.16, 0.15, 0.14],
    fogColor: DAY_FOG,
    fogDensity: FOG_DENSITY,
    shadowStrength: 0.9,
    emissiveGain: 0,
    exposure: 1,
  },
]);

export class CitySky {
  private readonly celestial = createCelestialState();
  private readonly daylight = createDaylightState();
  /** The sky's colours, and the sun and moon it draws: the celestial state's own directions. */
  readonly colors: SkyColors = {
    top: [0, 0, 0],
    horizon: [0, 0, 0],
    deep: [0, 0, 0],
    sunDir: this.celestial.sunDir,
    /* The reference's sun disc, 255 222 190, and its angular radius. */
    sunColor: [1, 0.73, 0.52],
    sunAngularRadius: 0.02,
    moonDir: this.celestial.moonDir,
    /* Its moon's tint, scaled down behind the overcast each frame. */
    moonColor: [MOON_DISC[0], MOON_DISC[1], MOON_DISC[2]],
    moonAngularRadius: 0.014,
    moonPhase: 0,
    nightFactor: 1,
    cloudOffsetX: 0,
    cloudOffsetZ: 0,
  };

  /** Light `env` and colour the sky for `hour`, with the streets `wetness` wet and `rain` falling. */
  apply(hour: number, wetness: number, env: Environment, rain = 0): void {
    const when = YEAR + ((DAY_OF_YEAR - 1) * 24 + hour) * MS_PER_HOUR;
    celestialStateAt(when, NORTH, this.celestial, SITE);
    const state = this.celestial;
    const day = state.dayFactor;
    const dir = day > 0.5 ? state.sunDir : state.moonDir;
    env.directionalDir[0] = dir[0];
    env.directionalDir[1] = dir[1];
    env.directionalDir[2] = dir[2];
    const light = resolveDaylight(day, PALETTE, this.daylight);
    const clear = 1 - smoothstep(OVERCAST_FROM, OVERCAST_TO, rain);
    const moonlit = moonIllumination(state.moonPhase) * clear;
    for (let c = 0; c < 3; c++) {
      env.directionalColor[c] =
        (light.moonColor[c] as number) * moonlit + (light.sunColor[c] as number);
      env.ambient[c] = light.ambient[c] as number;
      (env.ambientGround as Vec3)[c] = light.ambientGround[c] as number;
      env.fogColor[c] = light.fogColor[c] as number;
      const cloud =
        (OVERCAST_NIGHT[c] as number) +
        ((OVERCAST_DAY[c] as number) - (OVERCAST_NIGHT[c] as number)) * day;
      this.colors.top[c] = cloud + ((light.skyTop[c] as number) - cloud) * clear;
      this.colors.horizon[c] = cloud + ((light.skyHorizon[c] as number) - cloud) * clear;
      this.colors.deep[c] = cloud + ((light.skyDeep[c] as number) - cloud) * clear;
      (this.colors.moonColor as Vec3)[c] = (MOON_DISC[c] as number) * clear;
    }
    env.fogDensity = FOG_DENSITY;
    env.fogHeightFalloff = FOG_FALLOFF;
    env.fogBaseY = FOG_BASE_Y;
    env.shadowStrength = light.shadowStrength;
    /* The stars go behind the overcast with the moon. */
    this.colors.nightFactor = state.nightFactor * clear;
    this.colors.moonPhase = state.moonPhase;
    /* The city's own night: its lamps, its windows and its signs. */
    const night = nightAt(hour);
    env.nightFactor = night;
    env.emissiveGain = night;
    env.litWindows = night;
    env.lateWindows = LATE_WINDOWS;
    env.wetness = wetness;
  }

  draw(renderer: RendererApi, camera: Camera, env: Environment): void {
    renderer.drawSky(camera, this.colors, env);
  }
}

/** The bloom threshold the night's signs and windows clear. */
export const BLOOM_THRESHOLD = 1.2;
/** How finely the threshold follows the light, in white levels: a step is a rewrite of the bloom. */
const BLOOM_STEP = 0.1;

/**
 * The bloom threshold for the light `env` is lit by: `BLOOM_THRESHOLD` times the most a white
 * surface facing the sun or moon takes from it and the sky, and never less than at night.
 *
 * **What an eye's exposure would do, which this frame has no auto-exposure to do.** A fixed
 * threshold chosen for the night's signs sat under the noon sun's white, 1.84: every pale street
 * and cream facade glowed by day, haloes the reference never draws, since it blooms only what
 * emits. Measured relative to the light, a lit surface never blooms, whatever its albedo, and
 * what still does by day is brighter than any lit white — a sun glint off glass or water.
 *
 * What it gives up: a sign lit by day — gated off with the city's night here anyway. What would
 * make it wrong is an emitter that must bloom at noon, which would need the threshold to know it.
 * Stepped by `BLOOM_STEP`, rounded up, so the day moves it a few times rather than every frame.
 */
export function bloomThreshold(env: Environment): number {
  let white = 0;
  for (let c = 0; c < 3; c++) {
    white = Math.max(white, (env.directionalColor[c] as number) + (env.ambient[c] as number));
  }
  return BLOOM_THRESHOLD * Math.max(1, Math.ceil(white / BLOOM_STEP) * BLOOM_STEP);
}
