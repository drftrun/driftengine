/**
 * A dark room with one window, a shaft of sun with dust in it, and a brazier burning in the corner.
 *
 * Three ways light shows in the air: a volume of light drawn inside a hull, which the window's
 * shadow cuts to the window's shape; plumes of fire and smoke; and, when switched on in the strip,
 * a medium filling the whole room, which carries the sun from the window across everything. The
 * medium is a DriftScript module, `air.drs`, which fills and clears the room when the switch moves.
 */
import {
  MeshBuilder,
  SceneNode,
  buildLightVolume,
  computeLightMatrix,
  createEnvironment,
  createPointLightBuffer,
  selectPointLights,
  srgbColor,
} from '@driftengine/core';
import type { PointLightSource, RendererApi, ShadowCasters, Vec3 } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as airScript from './air.drs';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0, 0, 0);

const stage = await openStage({
  directionalShadows: true,
  /* The ceiling's shadow falls seven metres from it; the default of six would dissolve it. */
  directionalShadowMaxDistance: 16,
  outputTransform: 'aces',
  outputExposure: 1.2,
  sceneSamples: 4,
  /* The march's ceiling. Nothing runs while the air's density is 0. */
  globalMediumSteps: 48,
});
const { renderer, camera } = stage;

// #region script
/** The air, hosted: its record lives here, so an edited script carries on from it. */
const air = hostScript(airScript);
interface Air {
  wanted: number;
}
const airState = exported<() => Air>(air, 'createAir')();
type Breathe = (air: Air, renderer: RendererApi, dt: number) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./air.drs', (next) => {
    if (next !== undefined) patchModule(air, next as Record<string, unknown>, { Air: [airState] });
  });
}

controls([
  {
    key: 'medium',
    label: 'global medium',
    value: flag('medium', 'off'),
    options: [
      { text: 'off', value: 'off' },
      { text: 'on', value: 'on' },
    ],
    change: (value) => {
      airState.wanted = value === 'on' ? 1 : 0;
    },
  },
]);
airState.wanted = flag('medium', 'off') === 'on' ? 1 : 0;
// #endregion

/** Where the sun is, pointing at it: outside the east wall, well above the window. */
const SUN: Vec3 = [0.8, 0.5, 0.33];
const env = createEnvironment({
  directionalDir: SUN,
  directionalColor: [3.2, 2.8, 2.2],
  ambient: [0.015, 0.016, 0.02],
  ambientGround: [0.01, 0.009, 0.008],
  nightFactor: 1,
  emissiveGain: 1.5,
});

/** The room: floor, ceiling, three plain walls, and an east wall built around a window. */
const room = new MeshBuilder();
const PLASTER: Vec3 = [0.6, 0.56, 0.5];
room.addBox([0, -0.1, 0], [6, 0.1, 6], [0.45, 0.38, 0.3]);
room.addBox([0, 4.1, 0], [6, 0.1, 6], PLASTER);
room.addBox([-6.1, 2, 0], [0.1, 2, 6], PLASTER);
room.addBox([0, 2, -6.1], [6, 2, 0.1], PLASTER);
room.addBox([0, 2, 6.1], [6, 2, 0.1], PLASTER);
room.addBox([6.1, 0.75, 0], [0.1, 0.75, 6], PLASTER);
room.addBox([6.1, 3.65, 0], [0.1, 0.35, 6], PLASTER);
room.addBox([6.1, 2.3, -3.85], [0.1, 1, 2.15], PLASTER);
room.addBox([6.1, 2.3, 3.85], [0.1, 1, 2.15], PLASTER);
room.addBox([6.1, 2.3, 0], [0.1, 1, 0.06], [0.2, 0.18, 0.16]);
room.addBox([-1, 0.35, 4.5], [0.45, 0.35, 0.45], [0.18, 0.17, 0.16]);
room.addBox([-1, 0.75, 4.5], [0.35, 0.05, 0.35], [1, 0.5, 0.15], 1);
const roomMesh = renderer.createMesh(room.build());
const fixed = new SceneNode();
fixed.updateWorld();

const casters: ShadowCasters = (sink) => sink.mesh(roomMesh, fixed.worldMatrix);
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 1;

// #region shaft
/**
 * A shaft through a window is a slice of a very wide cone whose apex is far out toward the sun.
 * The hull is round and wider than the window; the window's own shadow cuts it square.
 */
const REACH = 30;
const shaftHull = buildLightVolume({
  nearM: REACH,
  lengthM: REACH + 10,
  spread: 2.2 / REACH,
  color: [1, 0.86, 0.62],
});
const shaft = renderer.createMesh(shaftHull);

/** The hull opens along its own +Z, so its matrix turns +Z to the way sunlight travels. */
function aimAlong(out: Float32Array, at: Vec3, travel: Vec3): void {
  const [zx, zy, zz] = travel;
  const side = Math.hypot(zz, zx);
  const xx = zz / side;
  const xz = -zx / side;
  out.set([xx, 0, xz, 0, zy * xz, zz * xx - zx * xz, -zy * xx, 0, zx, zy, zz, 0, ...at, 1]);
}
const length = Math.hypot(...SUN);
const travel: Vec3 = [-SUN[0] / length, -SUN[1] / length, -SUN[2] / length];
const shaftModel = new Float32Array(16);
aimAlong(
  shaftModel,
  [6.1 - travel[0] * REACH, 2.3 - travel[1] * REACH, -travel[2] * REACH],
  travel,
);
// #endregion

// #region plumes
/** Fire adds light; smoke covers it. One batch each, placed once. */
const fire = renderer.createPlumes([{ x: -1, y: 0.8, z: 4.5, width: 0.35, height: 1.1 }], {
  material: 'fire',
  blend: 'additive',
  windResponse: 0.1,
});
const smoke = renderer.createPlumes(
  [
    { x: -1, y: 1.6, z: 4.5, width: 0.5, height: 1.4 },
    { x: -0.9, y: 2.6, z: 4.4, width: 0.8, height: 1.4 },
  ],
  { material: 'smoke', blend: 'alpha', windResponse: 1, tint: [0.35, 0.33, 0.32] },
);
// #endregion

/** The brazier also lights the room, so it has a flickering lamp of its own. */
const glow: PointLightSource[] = [
  {
    x: -1,
    y: 1.2,
    z: 4.5,
    r: 2.4,
    g: 1.1,
    b: 0.35,
    radius: 7,
    flicker: 0.4,
    shadowNear: 0.3,
    sourceRadius: 0.15,
    castsShadow: false,
  },
];
const chosen = createPointLightBuffer(renderer.shadedLights);

let time = 0;
let breathedAt = 0;

stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    camera.fovYDeg = 60;
    camera.position[0] = -4.5 + Math.sin(time * 0.1) * 0.8;
    camera.position[1] = 1.7;
    camera.position[2] = -4 + Math.cos(time * 0.13) * 0.6;
    camera.lookAt(1.5, 1.2, 2.2);

    env.shadowDepthSpan = computeLightMatrix(SUN, 0, 1, 0, 12, renderer.shadowMapSize, lightMatrix);
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();

    selectPointLights(glow, camera.position[0], 1.7, camera.position[2], chosen, time);
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;

    // #region medium
    /* The script eases the air toward what the switch asked for, and sets the medium. */
    exported<Breathe>(air, 'breathe')(airState, renderer, time - breathedAt);
    breathedAt = time;
    // #endregion

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(roomMesh, fixed.worldMatrix);
    // #region draw
    renderer.drawLightVolume(shaft, shaftModel, camera, 0.8, REACH + 10, 2.2 / REACH, {
      nearM: REACH,
      dust: 0.35,
      dustScaleM: 0.8,
      driftM: [time * 0.05, 0, time * 0.02],
      sunShadow: 1,
      env,
    });
    renderer.drawPlumes(smoke, camera, time, env, 0.2, 0);
    renderer.drawPlumes(fire, camera, time, env, 0.2, 0);
    // #endregion
    renderer.endFrame();
  },
});
