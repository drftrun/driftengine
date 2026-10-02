/**
 * A day in a minute and a half over a ring of standing stones: the sun rising and setting where it
 * would at forty degrees north in June, clouds drifting, the moon and stars at night, and two lamps
 * that come on at dusk.
 *
 * The sky's position comes from the celestial clock, its colours from a daylight palette, and the
 * exposure eases toward what the palette says the eye would settle on.
 */
import {
  MeshBuilder,
  SceneNode,
  celestialStateAt,
  computeLightMatrix,
  createCelestialState,
  createDaylightPalette,
  createDaylightState,
  createEnvironment,
  createPointLightBuffer,
  easeExposure,
  moonIllumination,
  resolveDaylight,
  selectPointLights,
} from '@driftengine/core';
import type { PointLightSource, ShadowCasters, SkyColors } from '@driftengine/core';
import { flagNumber, openStage } from '../common/stage';

const stage = await openStage({ outputTransform: 'aces', directionalShadows: true });
const { renderer, camera } = stage;

// #region clock
/** A site names where the sky is: forty degrees north, on the meridian, keeping UTC. */
const SITE = { latitudeDeg: 40, longitudeDeg: 0, utcOffsetHours: 0 };
/** Midsummer, and a day that lasts ninety seconds, starting before sunrise or at `?hour=`. */
const MIDSUMMER = Date.UTC(2026, 5, 21);
const DAY_SECONDS = 90;
const START_HOUR = flagNumber('hour', 3.5);
/** Where the world's north points, as an angle in the xz plane from +x toward +z: here, -z. */
const NORTH = -Math.PI / 2;

const celestial = createCelestialState();

function hourAt(seconds: number): number {
  return (START_HOUR + (seconds / DAY_SECONDS) * 24) % 24;
}
// #endregion

// #region palette
/** The day's light, keyed by how much day there is: night, the warm edge of dusk, and noon. */
const palette = createDaylightPalette([
  {
    at: 0,
    sunColor: [0, 0, 0],
    moonColor: [0.16, 0.2, 0.3],
    skyTop: [0.004, 0.006, 0.016],
    skyHorizon: [0.02, 0.03, 0.06],
    skyDeep: [0.01, 0.012, 0.02],
    ambient: [0.02, 0.025, 0.04],
    ambientGround: [0.01, 0.01, 0.014],
    fogColor: [0.02, 0.025, 0.04],
    fogDensity: 0.01,
    shadowStrength: 0.5,
    emissiveGain: 2,
    exposure: 2.4,
  },
  {
    at: 0.35,
    sunColor: [1.6, 0.8, 0.4],
    moonColor: [0, 0, 0],
    skyTop: [0.12, 0.16, 0.32],
    skyHorizon: [0.9, 0.5, 0.3],
    skyDeep: [0.2, 0.15, 0.15],
    ambient: [0.18, 0.16, 0.2],
    ambientGround: [0.08, 0.06, 0.05],
    fogColor: [0.5, 0.36, 0.3],
    fogDensity: 0.008,
    shadowStrength: 0.7,
    emissiveGain: 1,
    exposure: 1.4,
  },
  {
    at: 1,
    sunColor: [2, 1.9, 1.7],
    moonColor: [0, 0, 0],
    skyTop: [0.18, 0.36, 0.78],
    skyHorizon: [0.62, 0.74, 0.9],
    skyDeep: [0.3, 0.34, 0.4],
    ambient: [0.3, 0.36, 0.48],
    ambientGround: [0.14, 0.12, 0.1],
    fogColor: [0.6, 0.7, 0.85],
    fogDensity: 0.005,
    shadowStrength: 0.9,
    emissiveGain: 0,
    exposure: 1,
  },
]);
const light = createDaylightState();
// #endregion

const env = createEnvironment({ fogHeightFalloff: 0.02 });
const sky: SkyColors = {
  top: [0, 0, 0],
  horizon: [0, 0, 0],
  deep: [0, 0, 0],
  sunDir: [0, 1, 0],
  sunColor: [1.8, 1.6, 1.3],
  sunAngularRadius: 0.02,
  moonDir: [0, -1, 0],
  moonColor: [0.9, 0.92, 1],
  moonAngularRadius: 0.03,
  moonPhase: 0,
  nightFactor: 0,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

/** The set: a low hill and a ring of stones, with two lamps at the gap. */
const set = new MeshBuilder();
set.addBox([0, -0.5, 0], [60, 0.5, 60], [0.32, 0.36, 0.22]);
for (let i = 0; i < 12; i += 1) {
  if (i === 0) continue;
  const a = (i / 12) * Math.PI * 2;
  const tall = 1.6 + ((i * 7) % 5) * 0.25;
  set.addBox([Math.cos(a) * 7, tall, Math.sin(a) * 7], [0.45, tall, 0.3], [0.55, 0.53, 0.5]);
}
const lamps: PointLightSource[] = [];
for (const side of [-1, 1]) {
  const x = 7;
  const z = side * 1.6;
  set.addCylinder([x, 1, z], 0.05, 1, 'y', [0.1, 0.1, 0.1]);
  set.addSphere([x, 2.1, z], 0.12, [1, 0.7, 0.4], 1);
  lamps.push({
    x,
    y: 2.1,
    z,
    r: 0,
    g: 0,
    b: 0,
    radius: 9,
    flicker: 0.15,
    shadowNear: 0.2,
    sourceRadius: 0.1,
    castsShadow: false,
  });
}
const setMesh = renderer.createMesh(set.build());
const still = new SceneNode();
still.updateWorld();
const casters: ShadowCasters = (sink) => sink.mesh(setMesh, still.worldMatrix);
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
const chosen = createPointLightBuffer(renderer.shadedLights);

let time = 0;
let exposure = 1;
let shownAt = 0;

stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    // #region frame
    const hour = hourAt(time);
    celestialStateAt(MIDSUMMER + hour * 3_600_000, NORTH, celestial, SITE);
    resolveDaylight(celestial.dayFactor, palette, light);

    /* Whichever body is up lights the world; the sky draws both and hides what has set. */
    const body = celestial.dayFactor > 0.5 ? celestial.sunDir : celestial.moonDir;
    env.directionalDir = body;
    const moonlight = moonIllumination(celestial.moonPhase);
    for (let c = 0; c < 3; c += 1)
      env.directionalColor[c] = light.sunColor[c] + light.moonColor[c] * moonlight;
    env.ambient = light.ambient;
    env.ambientGround = light.ambientGround;
    env.fogColor = light.fogColor;
    env.fogDensity = light.fogDensity;
    env.shadowStrength = light.shadowStrength;
    env.emissiveGain = light.emissiveGain;
    env.nightFactor = celestial.nightFactor;

    sky.top = light.skyTop;
    sky.horizon = light.skyHorizon;
    sky.deep = light.skyDeep;
    sky.sunDir = celestial.sunDir;
    sky.moonDir = celestial.moonDir;
    sky.moonPhase = celestial.moonPhase;
    sky.nightFactor = celestial.nightFactor;
    sky.cloudOffsetX = time * 1.5;
    sky.cloudOffsetZ = time * 0.6;

    exposure = easeExposure(exposure, light.exposure, time - shownAt, 1.5);
    renderer.setOutputExposure(exposure);
    shownAt = time;
    // #endregion

    /* The lamps follow the night on a steeper curve, so they are off all afternoon. */
    const lit = Math.min(1, celestial.nightFactor * celestial.nightFactor * 1.4);
    for (const lamp of lamps) {
      lamp.r = 3 * lit;
      lamp.g = 1.9 * lit;
      lamp.b = 0.9 * lit;
    }

    camera.fovYDeg = 55;
    camera.far = 600;
    camera.position[0] = -13;
    camera.position[1] = 2.2;
    camera.position[2] = 4;
    camera.lookAt(4, 5.2, -2);

    selectPointLights(lamps, camera.position[0], 2, camera.position[2], chosen, time);
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;

    env.shadowDepthSpan = computeLightMatrix(
      body,
      0,
      1,
      0,
      14,
      renderer.shadowMapSize,
      lightMatrix,
    );
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();

    // #region draw
    renderer.beginFrame(sky.horizon);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(setMesh, still.worldMatrix);
    /* Last, so it fills only what the world left empty. */
    renderer.drawSky(camera, sky, env);
    renderer.endFrame();
    // #endregion
  },
});
