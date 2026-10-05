/**
 * A courtyard at night, lit by nothing but its fixtures: lamps on posts that cast, a spot that
 * throws a window frame through a cookie, a downlight shaped by a photometric profile, and a lit
 * window in the back wall that is a rectangle of light.
 *
 * The block circling the middle is the one caster that moves, so its shadows come from the live
 * maps while the pillars' come from maps baked once. Switch shadows off in the strip and every
 * fixture lights straight through the stone. Both switches are quality options, so each builds a
 * new renderer in place, and the block and the camera carry on from where they were.
 */
import {
  DEFAULT_POINT_LIGHT_VIEW_RANGE,
  MeshBuilder,
  SceneNode,
  createAreaLightBuffer,
  createEnvironment,
  createPointLightBuffer,
  selectAreaLights,
  selectPointLights,
} from '@driftengine/core';
import type {
  AreaLightSource,
  PhotometricProfile,
  PointLightSource,
  ShadowCasters,
} from '@driftengine/core';
import type { RendererApi } from '@driftengine/core';
import { controls, flag, openScene } from '../common/stage';
import type { SceneHooks } from '../common/stage';

// #region lamps
/** Two lamps on posts, one of them flickering, and a downlight aimed at the floor between pillars. */
const lamps: PointLightSource[] = [
  {
    x: -6,
    y: 2.7,
    z: 1.5,
    r: 2.4,
    g: 1.5,
    b: 0.7,
    radius: 10,
    flicker: 0,
    shadowNear: 0.2,
    sourceRadius: 0.08,
  },
  {
    x: 6,
    y: 2.7,
    z: 1.5,
    r: 2.4,
    g: 1.3,
    b: 0.55,
    radius: 10,
    flicker: 0.3,
    shadowNear: 0.2,
    sourceRadius: 0.08,
  },
  {
    x: 0,
    y: 4.5,
    z: -2,
    r: 4.5,
    g: 3.6,
    b: 2.6,
    radius: 9,
    flicker: 0,
    shadowNear: 0.2,
    sourceRadius: 0.05,
    dirX: 0,
    dirY: -1,
    dirZ: 0,
    coneInnerDeg: 70,
    coneOuterDeg: 85,
    iesProfile: 0,
  },
];
// #endregion

// #region spot
/** A spot high over the camera's shoulder, aimed down at the floor in front of the pillars. */
const SPOT = lamps.length;
lamps.push({
  x: 0,
  y: 7,
  z: 7,
  r: 4,
  g: 3.8,
  b: 3.4,
  radius: 16,
  flicker: 0,
  shadowNear: 0.2,
  sourceRadius: 0.04,
  dirX: 0,
  dirY: -1,
  dirZ: -0.55,
  coneInnerDeg: 18,
  coneOuterDeg: 24,
});
// #endregion

// #region profile
/**
 * A photometric profile built in code: intensity that falls to nothing sixty degrees off the aim.
 * The downlight asked for row 0 of the atlas with `iesProfile: 0`.
 */
function downlight(): PhotometricProfile {
  const steps = 19;
  const verticalAngles = new Float32Array(steps);
  const candela = new Float32Array(steps);
  for (let i = 0; i < steps; i += 1) {
    const degrees = (i / (steps - 1)) * 180;
    const t = Math.max(0, 1 - degrees / 60);
    verticalAngles[i] = degrees;
    candela[i] = 1000 * t * t;
  }
  return { verticalAngles, horizontalAngles: new Float32Array([0]), candela, maxCandela: 1000 };
}
// #endregion

// #region cookie
/** A cookie is any image the spot projects: here a window frame, white panes and black bars. */
function windowFrame(): HTMLCanvasElement {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const paint = canvas.getContext('2d');
  if (paint === null) return canvas;
  paint.fillStyle = '#000';
  paint.fillRect(0, 0, size, size);
  paint.fillStyle = '#fff';
  const pane = size / 3;
  const bar = size / 16;
  for (let row = 0; row < 2; row += 1)
    for (let column = 0; column < 2; column += 1)
      paint.fillRect(
        size / 6 + column * (pane + bar),
        size / 6 + row * (pane + bar),
        pane - bar,
        pane - bar,
      );
  return canvas;
}
// #endregion

// #region window
/** The lit window: a rectangle that emits along `right × up`, which here is into the courtyard. */
const windows: AreaLightSource[] = [
  {
    x: 0,
    y: 2.4,
    z: -5.8,
    r: 2.4,
    g: 3.2,
    b: 4.8,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    upX: 0,
    upY: 1,
    upZ: 0,
    halfWidth: 2.2,
    halfHeight: 1.1,
    castsShadow: true,
    shadowRange: 18,
    shadowNear: 0.2,
  },
];
const windowBuffer = createAreaLightBuffer();
selectAreaLights(windows, windowBuffer);
// #endregion

const env = createEnvironment({
  directionalColor: [0, 0, 0],
  ambient: [0.025, 0.028, 0.04],
  ambientGround: [0.012, 0.012, 0.016],
  nightFactor: 1,
  emissiveGain: 2,
});
const blockNode = new SceneNode();
const fixed = new SceneNode();
fixed.updateWorld();
let time = 0;
let shadedAt = 0;

/** What one renderer draws, and the fixtures it uploads. */
function build(renderer: RendererApi): SceneHooks {
  /* The profile and the cookie are assets: uploaded once per renderer. */
  renderer.setIesProfiles([downlight()]);
  renderer.setSpotCookies([windowFrame()]);

  /** Everything that never moves, as one mesh: floor, back wall, pillars, posts and fixtures. */
  const yard = new MeshBuilder();
  yard.addBox([0, -0.1, 0], [14, 0.1, 10], [0.42, 0.4, 0.38]);
  yard.addBox([0, 3, -6.2], [14, 3, 0.2], [0.5, 0.46, 0.42]);
  for (const x of [-4.5, -1.5, 1.5, 4.5])
    yard.addCylinder([x, 1.6, -3], 0.35, 1.6, 'y', [0.62, 0.58, 0.52], 0, 16);
  for (const lamp of lamps.slice(0, 2)) {
    yard.addCylinder([lamp.x, 1.25, lamp.z], 0.06, 1.25, 'y', [0.12, 0.12, 0.13], 0, 8);
    yard.addSphere([lamp.x, lamp.y, lamp.z], 0.07, [1, 0.75, 0.45], 1);
  }
  yard.addBox([0, 4.65, -2], [0.2, 0.08, 0.2], [0.85, 0.9, 1], 1);
  yard.addBox([0, 2.4, -5.98], [2.2, 1.1, 0.02], [0.75, 0.85, 1], 1);
  const courtyard = renderer.createMesh(yard.build());
  const block = renderer.createMesh(
    new MeshBuilder().addBox([0, 0.6, 0], [0.6, 0.6, 0.6], [0.7, 0.68, 0.64]).build(),
  );

  // #region casters
  /** The two caster lists: baked once and kept, and drawn again every frame. */
  const still: ShadowCasters = (sink) => sink.mesh(courtyard, fixed.worldMatrix);
  const moving: ShadowCasters = (sink) => sink.mesh(block, blockNode.worldMatrix);

  /** Size the shadow array once, for every lamp and every rectangle that casts. */
  renderer.prepareStaticPointShadows(lamps, windows);
  // #endregion

  // #region select
  /** Sized from the renderer, so the shader shades the nearest lights and never an arbitrary few. */
  const chosen = createPointLightBuffer(renderer.shadedLights);

  function chooseLights(focusX: number, focusZ: number): void {
    const eye = scene.camera.position;
    selectPointLights(
      lamps,
      eye[0],
      eye[1],
      eye[2],
      chosen,
      time,
      DEFAULT_POINT_LIGHT_VIEW_RANGE,
      focusX,
      0.6,
      focusZ,
    );
    env.lightCount = chosen.count;
    env.lightPositions = chosen.positions;
    env.lightColors = chosen.colors;
    env.lightRadii = chosen.radii;
    env.lightSourceRadii = chosen.sourceRadii;
    env.lightWeights = chosen.weights;
    env.lightDirections = chosen.directions;
    env.lightConeCos = chosen.coneCos;
    env.lightIesProfiles = chosen.iesProfiles;
    env.lightFalloffExponents = chosen.falloffExponents;
    env.activeLightWorldIndices = chosen.sourceIndex;
    for (let slot = 0; slot < chosen.count; slot += 1) {
      const spot = chosen.sourceIndex[slot] === SPOT;
      /* The cookie's tile, and which way is up in it: a cookie with no axis is not projected. */
      env.lightCookies[slot] = spot ? 0 : -1;
      env.lightIesAxes[slot * 3] = spot ? 1 : 0;
    }
    env.areaLights = windowBuffer;
  }
  // #endregion

  return {
    simulate(dt) {
      time += dt;
    },
    render() {
      const { camera } = scene;
      const blockX = Math.cos(time * 0.4) * 3.2;
      const blockZ = 0.5 + Math.sin(time * 0.4) * 2.2;
      blockNode.setPosition(blockX, 0, blockZ);
      blockNode.setRotationAxisAngle(0, 1, 0, time * 0.6);
      blockNode.updateWorld();

      camera.fovYDeg = 55;
      camera.position[0] = Math.sin(time * 0.08) * 4;
      camera.position[1] = 5.5;
      camera.position[2] = 13;
      camera.lookAt(0, 1.2, -1.5);

      // #region shadows
      chooseLights(blockX, blockZ);
      renderer.updatePointShadows(
        lamps,
        chosen.sourceIndex,
        chosen.count,
        blockX,
        0.6,
        blockZ,
        time - shadedAt,
        still,
        moving,
        chosen.shadowIndex,
        chosen.shadowCount,
        windows,
      );
      shadedAt = time;
      // #endregion

      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      renderer.drawMesh(courtyard, fixed.worldMatrix);
      renderer.drawMesh(block, blockNode.worldMatrix);
      renderer.endFrame();
    },
  };
}

// #region quality
/** Point shadows and the falloff curve both change what the lit shader is built with. */
const quality = (shadows: string, falloff: string) => {
  windows[0].castsShadow = shadows === 'on';
  return {
    pointShadows: shadows === 'on',
    directionalShadows: false,
    pointLightFalloff:
      falloff === 'inverseSquare' ? ('inverseSquare' as const) : ('smooth' as const),
    outputTransform: 'aces' as const,
    sceneSamples: 4,
  };
};
const settings = { shadows: flag('shadows', 'on'), falloff: flag('falloff', 'smooth') };
const scene = await openScene(quality(settings.shadows, settings.falloff), build);

controls([
  {
    key: 'shadows',
    label: 'pointShadows',
    value: settings.shadows,
    options: [
      { text: 'on', value: 'on' },
      { text: 'off', value: 'off' },
    ],
    change: (value) => {
      settings.shadows = value;
      return scene.rebuild(quality(settings.shadows, settings.falloff));
    },
  },
  {
    key: 'falloff',
    label: 'pointLightFalloff',
    value: settings.falloff,
    options: [
      { text: 'smooth', value: 'smooth' },
      { text: 'inverseSquare', value: 'inverseSquare' },
    ],
    change: (value) => {
      settings.falloff = value;
      return scene.rebuild(quality(settings.shadows, settings.falloff));
    },
  },
]);
// #endregion
