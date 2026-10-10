/**
 * A street at dusk under three weathers: clear, rain and storm. Rain falls as streaks on the wind,
 * the ground darkens and shines as it gets wet, fog thickens and hugs the ground, and in a storm
 * lightning strikes beyond the rooftops and debris blows through.
 *
 * The weather is a DriftScript module, `weather.drs`: it eases everything toward what the switch
 * asks for, so a storm rolls in and the road dries afterwards, and it decides when lightning
 * strikes. This page draws what it says. Every moving part answers to one wind, sampled once a
 * frame: the rain's lean, the clouds' drift and the debris.
 */
import {
  BoltPool,
  MeshBuilder,
  RainField,
  SceneNode,
  Spline,
  advanceWindField,
  buildFilmPatch,
  createEnvironment,
  createWindField,
  hashToUnit,
  srgbColor,
} from '@driftengine/core';
import type { Camera, SkyColors, Vec3, WindProfile } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as weatherScript from './weather.drs';

const stage = await openStage({ outputTransform: 'aces', outputExposure: 1.3, sceneSamples: 4 });
const { renderer, camera } = stage;

// #region script
/** The weather, hosted. Its record lives here, so an edited script carries on from the sky it had. */
const weather = hostScript(weatherScript);
/* A variant is `{ tag }`; the page takes the script's own from its `Sky` export. */
interface SkyVariant {
  tag: 'Clear' | 'Rain' | 'Storm';
}
interface Weather {
  kind: SkyVariant;
  fog: number;
  gloom: number;
  wetness: number;
  rain: number;
  wind: number;
  strikes: number;
  flash: number;
}
const sky = exported<() => Weather>(weather, 'createWeather')();
type Advance = (sky: Weather, dt: number) => boolean;
if (import.meta.hot) {
  import.meta.hot.accept('./weather.drs', (next) => {
    if (next !== undefined)
      patchModule(weather, next as Record<string, unknown>, { Weather: [sky] });
  });
}
const Sky = exported<Record<SkyVariant['tag'], SkyVariant>>(weather, 'Sky');
/* The switch's word for each sky, which the address bar keeps. */
const KINDS: Record<string, SkyVariant> = { clear: Sky.Clear, rain: Sky.Rain, storm: Sky.Storm };
sky.kind = KINDS[flag('weather', 'rain')] ?? Sky.Rain;
// #endregion

// #region switches
/** The weather is the script's to ease toward; the fog's curve is the environment's, at once. */
controls([
  {
    key: 'weather',
    label: 'weather',
    value: sky.kind.tag.toLowerCase(),
    options: Object.keys(KINDS).map((w) => ({ text: w, value: w })),
    change: (value) => {
      sky.kind = KINDS[value] ?? sky.kind;
    },
  },
  {
    key: 'fog',
    label: 'fog',
    value: flag('fog', 'exponential'),
    options: ['exponential', 'linear'].map((f) => ({ text: f, value: f })),
    change: (value) => {
      env.fogMode = value === 'linear' ? 'linear' : 'exponential';
    },
  },
]);
// #endregion

// #region fog
/** Dense near the ground and thinning with height; or a clear near field and a wall of grey. */
const env = createEnvironment({
  directionalDir: [-0.3, 0.35, -0.6],
  directionalColor: [0.5, 0.48, 0.52],
  ambient: [0.16, 0.18, 0.22],
  ambientGround: [0.06, 0.06, 0.07],
  fogColor: [0.24, 0.26, 0.3],
  fogDensity: 0.003,
  fogHeightFalloff: 0.08,
  fogBaseY: 0,
  fogMode: flag('fog', 'exponential') === 'linear' ? 'linear' : 'exponential',
  fogNear: 12,
  fogFar: 110,
  wetness: 0,
  nightFactor: 1,
  emissiveGain: 1.2,
});
// #endregion

// #region wind
/** One wind for everything. It gusts and wanders, and repeats exactly every forty seconds. */
const profile: WindProfile = {
  directionX: 1,
  directionZ: 0.3,
  baseSpeed: 3,
  gustSpeed: 1.5,
  directionWander: 0.3,
  cycleSeconds: 40,
  phase: 0,
};
const wind = createWindField();
// #endregion

// #region rain
/** Drops around the viewer, drawn as streaks along their motion. */
const rain = new RainField({
  count: 2400,
  radiusM: 14,
  heightM: 12,
  speedMps: 11,
  streakSec: 0.05,
});
const drops = renderer.createLines(rain.segments.capacity, 'rain');
const RAIN_COLOUR: Vec3 = [0.5, 0.55, 0.62];
// #endregion

// #region lightning
/** Arcs from the clouds to the ground, re-drawn many times a second while they live. */
const bolts = new BoltPool({ capacity: 3, nodes: 33, lifeSec: 0.4, jitter: 0.08, restrikeHz: 16 });
const boltBatch = renderer.createBolts(bolts.segments.capacity, 'lightning');
// #endregion

const debris = renderer.createWindStreaks();

/** The street: a wet road between two rows of blocks with lit windows. */
const street = new MeshBuilder();
street.setRoughness(0.5);
street.addBox([0, -0.1, -30], [30, 0.1, 60], [0.2, 0.2, 0.21]);
for (let i = 0; i < 9; i += 1) {
  for (const side of [-1, 1]) {
    const tall = 6 + hashToUnit(i * 2 + side) * 14;
    const z = -i * 9;
    street.addBox([side * 9, tall / 2, z], [3.5, tall / 2, 4], [0.36, 0.34, 0.33]);
    for (let floor = 1; floor < tall / 3; floor += 1)
      if (hashToUnit(i * 31 + floor * 7 + side) > 0.45)
        street.addBox([side * 5.45, floor * 3, z], [0.05, 0.6, 1.6], [1, 0.75, 0.45], 1);
  }
}
const streetMesh = renderer.createMesh(street.build());
const still = new SceneNode();
still.updateWorld();
const IDENTITY = still.worldMatrix;

// #region puddles
/** Puddles down the middle of the road: feathered patches lying a centimetre above it. */
const roadLine = new Spline(
  [8, -20, -50, -80].map((z) => ({ x: 0, y: 0, z, bankRad: 0, widthM: 8 })),
);
const puddles = [
  { fromM: 4, toM: 16, centreM: -1.2, halfWidthM: 1.6, seed: 3 },
  { fromM: 22, toM: 40, centreM: 1.4, halfWidthM: 2.2, seed: 8 },
  { fromM: 48, toM: 60, centreM: -0.4, halfWidthM: 1.8, seed: 13 },
  { fromM: 66, toM: 84, centreM: 0.8, halfWidthM: 2.4, seed: 21 },
].map((patch) =>
  renderer.createMesh(
    buildFilmPatch(roadLine, { ...patch, liftM: 0.012, color: [0.012, 0.014, 0.018] }),
  ),
);
/** They mirror across the road's own plane, a little roughened by the stone under them. */
const wet = { reflectionStrength: 0.7, reflectionPlaneY: 0, roughness: 0.25 };
// #endregion

const heavens: SkyColors = {
  top: srgbColor(0.05, 0.06, 0.08),
  horizon: srgbColor(0.22, 0.24, 0.28),
  deep: srgbColor(0.1, 0.1, 0.12),
  sunDir: [0, -1, 0],
  sunColor: [0, 0, 0],
  sunAngularRadius: 0.02,
  moonDir: [0, -1, 0],
  moonColor: [0, 0, 0],
  moonAngularRadius: 0.03,
  moonPhase: 0,
  nightFactor: 0,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};
const ambient = env.ambient.slice() as Vec3;
const CLEAR_FOG: Vec3 = [0.24, 0.26, 0.3];
const STORM_FOG: Vec3 = [0.13, 0.14, 0.17];

let time = 0;
let shownAt = 0;

/** What a camera sees of the world: the street and the sky. */
function drawWorld(view: Camera): void {
  renderer.bindMeshPass(view, env);
  renderer.drawMesh(streetMesh, IDENTITY);
  renderer.drawSky(view, heavens, env);
}

stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    const dt = time - shownAt;
    shownAt = time;

    camera.fovYDeg = 60;
    camera.far = 300;
    camera.position[0] = Math.sin(time * 0.1) * 1.5;
    camera.position[1] = 1.7;
    camera.position[2] = 8 - ((time * 1.2) % 40);
    camera.lookAt(camera.position[0] * 0.5, 2.6, camera.position[2] - 20);
    const [x, y, z] = camera.position;

    // #region frame
    /* The script moves the weather on, and says whether lightning strikes this frame. */
    const strikes = exported<Advance>(weather, 'advance')(sky, dt);
    env.fogDensity = sky.fog;
    env.wetness = sky.wetness;
    env.fogFar = 110 - sky.gloom * 40;
    for (let c = 0; c < 3; c += 1) {
      env.fogColor[c] = CLEAR_FOG[c] + (STORM_FOG[c] - CLEAR_FOG[c]) * sky.gloom;
      env.ambient[c] = ambient[c] + sky.flash * 0.9;
    }
    wet.reflectionStrength = 0.7 * sky.wetness;

    profile.baseSpeed = sky.wind;
    profile.gustSpeed = sky.wind * 0.45;
    advanceWindField(wind, profile, time, dt, 1);
    heavens.cloudOffsetX = wind.driftX;
    heavens.cloudOffsetZ = wind.driftZ;
    rain.update(dt, x, y, z, wind.velocityX, wind.velocityZ);
    /* How hard it rains is how many of the drops are drawn. */
    rain.segments.count = Math.floor(rain.segments.count * sky.rain);

    if (strikes) {
      const n = sky.strikes;
      const bx = (hashToUnit(n) - 0.5) * 12;
      const bz = z - 45 - hashToUnit(n + 99) * 20;
      bolts.strike(bx, 70, bz, bx + (hashToUnit(n + 7) - 0.5) * 20, 0, bz, n);
    }
    bolts.update(dt);
    // #endregion

    renderer.beginFrame(heavens.horizon);
    // #region reflect
    /* The street mirrored across the road, for the puddles to show. */
    const wetEnough = sky.wetness > 0.02;
    const mirrored = wetEnough ? renderer.beginPlanarReflection(camera, 0, heavens.horizon) : null;
    if (mirrored !== null) {
      drawWorld(mirrored);
      renderer.endPlanarReflection();
    }
    drawWorld(camera);
    if (wetEnough)
      for (const puddle of puddles) renderer.drawFilm(puddle, camera, time, env, 0.16, wet);
    // #endregion
    // #region draw
    if (rain.segments.count > 0)
      renderer.drawLines(drops, rain.segments, IDENTITY, camera, env, RAIN_COLOUR, 0.006, 0.7, 0.4);
    renderer.drawBolts(
      boltBatch,
      bolts.segments,
      camera,
      env,
      time,
      [1, 1, 1.3],
      [0.45, 0.55, 1],
      0.9,
      3,
    );
    renderer.drawWindStreaks(debris, camera, wind, time, [0.35, 0.33, 0.3], env);
    // #endregion
    renderer.endFrame();
  },
});
