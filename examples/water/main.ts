/**
 * The open sea under three winds, a stone pier on legs, and the light the waves throw up onto the
 * underside of its deck.
 *
 * The waves are built by the wind: in a calm the sea barely breathes, in a gale the crests steepen
 * and break. The pier is mirrored in the water by a planar reflection, and the caustics under its
 * deck follow the same crests the surface shows.
 */
import {
  MeshBuilder,
  SceneNode,
  advanceWindField,
  computeLightMatrix,
  createEnvironment,
  createWindField,
} from '@driftengine/core';
import type { ShadowCasters, SkyColors, Vec3, WaterBody, WindProfile } from '@driftengine/core';
import { controls, flag, openStage } from '../common/stage';

const SPEEDS: Record<string, number> = { calm: 0.8, breeze: 4, gale: 10 };

// #region quality
const stage = await openStage({
  water: true,
  waterReflections: true,
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
// #endregion
const { renderer, camera } = stage;

/** The switch sets where the wind is heading; the sea follows it over a few seconds. */
let targetSpeed = SPEEDS[flag('wind', 'breeze')] ?? 4;
controls([
  {
    key: 'wind',
    label: 'wind',
    value: flag('wind', 'breeze'),
    options: ['calm', 'breeze', 'gale'].map((w) => ({ text: w, value: w })),
    change: (value) => {
      targetSpeed = SPEEDS[value] ?? 4;
    },
  },
]);

const HORIZON: Vec3 = [0.62, 0.7, 0.78];
const env = createEnvironment({
  directionalDir: [-0.5, 0.45, -0.7],
  directionalColor: [2.2, 2.05, 1.85],
  ambient: [0.3, 0.36, 0.45],
  ambientGround: [0.12, 0.13, 0.14],
  fogColor: HORIZON,
  fogDensity: 0.004,
  fogHeightFalloff: 0.02,
});
const sky: SkyColors = {
  top: [0.2, 0.36, 0.66],
  horizon: HORIZON,
  deep: [0.3, 0.36, 0.42],
  sunDir: env.directionalDir,
  sunColor: [1.8, 1.6, 1.3],
  sunAngularRadius: 0.02,
  moonDir: [0, -1, 0],
  moonColor: [0, 0, 0],
  moonAngularRadius: 0.03,
  moonPhase: 0,
  nightFactor: 0,
  cloudOffsetX: 0,
  cloudOffsetZ: 0,
};

// #region sea
/** The sea: no bounds, so it is endless and follows the camera; dense, so it hides its floor. */
const sea = renderer.createWater();
const seaBody: WaterBody = {
  level: 0,
  deepColor: [0.03, 0.07, 0.1],
  shallowColor: [0.08, 0.16, 0.18],
  density: 0.95,
};
// #endregion

// #region caustics
/** The underside of the deck, two centimetres below it, as a sheet the water lights from below. */
const caustics = renderer.createCaustics([
  {
    spans: [
      { x0: -3, z0: 2, x1: 3, z1: 2, y: 1.58 },
      { x0: -3, z0: -40, x1: 3, z1: -40, y: 1.58 },
    ],
    waterY: 0,
  },
]);
// #endregion

/** The pier: a deck on legs, running out to sea, with a hut at the end. */
const pier = new MeshBuilder();
pier.addBox([0, 1.8, -19], [3, 0.2, 21], [0.5, 0.46, 0.4]);
for (let z = 0; z >= -38; z -= 6)
  for (const x of [-2.6, 2.6]) pier.addBox([x, -1, z], [0.25, 2.6, 0.25], [0.32, 0.28, 0.24]);
pier.addBox([0, 3.4, -36], [2, 1.4, 2], [0.7, 0.66, 0.6]);
pier.addBox([0, -4, 30], [60, 4, 20], [0.55, 0.5, 0.4]);
const pierMesh = renderer.createMesh(pier.build());
const still = new SceneNode();
still.updateWorld();
const casters: ShadowCasters = (sink) => sink.mesh(pierMesh, still.worldMatrix);
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.85;

const profile: WindProfile = {
  directionX: -0.6,
  directionZ: -1,
  baseSpeed: targetSpeed,
  gustSpeed: targetSpeed * 0.3,
  directionWander: 0.2,
  cycleSeconds: 30,
  phase: 0,
};
const wind = createWindField();

let time = 0;
let shownAt = 0;

/** Everything a camera sees above the water: the pier and the sky. */
function drawWorld(view: typeof camera): void {
  renderer.bindMeshPass(view, env);
  renderer.drawMesh(pierMesh, still.worldMatrix);
  renderer.drawSky(view, sky, env);
}

stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    const dt = time - shownAt;
    /* Wind builds a sea; it does not switch one. Ease toward the asked speed. */
    profile.baseSpeed += (targetSpeed - profile.baseSpeed) * Math.min(1, dt * 0.5);
    profile.gustSpeed = profile.baseSpeed * 0.3;
    advanceWindField(wind, profile, time, dt, 1);
    shownAt = time;
    sky.cloudOffsetX = wind.driftX;
    sky.cloudOffsetZ = wind.driftZ;

    camera.fovYDeg = 55;
    camera.far = 800;
    /* Low beside the pier, so the underside of the deck is in view. */
    camera.position[0] = 5 + Math.sin(time * 0.07) * 1.5;
    camera.position[1] = 0.7;
    camera.position[2] = -4;
    camera.lookAt(-1, 1.7, -14);

    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      0,
      0,
      -18,
      30,
      renderer.shadowMapSize,
      lightMatrix,
    );
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();

    // #region frame
    renderer.beginFrame(HORIZON);
    /* The world again, mirrored across the water's plane, for the next water draw to sample. */
    const mirrored = renderer.beginPlanarReflection(camera, seaBody.level, HORIZON);
    if (mirrored !== null) {
      drawWorld(mirrored);
      renderer.endPlanarReflection();
    }
    drawWorld(camera);
    renderer.drawWater(sea, camera, time, seaBody, env, wind.velocityX, wind.velocityZ);
    renderer.drawCaustics(caustics, camera, time, env, wind.velocityX, wind.velocityZ);
    renderer.endFrame();
    // #endregion
  },
});
