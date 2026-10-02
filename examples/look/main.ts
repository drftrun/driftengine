/**
 * A colonnade at dusk, a figure halfway down it, and a camera that every few seconds whips round.
 *
 * Everything here happens after the scene is drawn: the tone curve and the eye's exposure, a colour
 * grade built in code, a vignette and film grain, a fade in from black, focus on the figure, and
 * motion blur on the whip pan. The lens is a DriftScript module, `lens.drs`; the grade and the
 * film look are TypeScript, since a script reaches the render dials and not those. Every switch in
 * the strip changes the running scene.
 */
import { MeshBuilder, SceneNode, createEnvironment, identityGradeLut } from '@driftengine/core';
import type { ColourGradeLut, RendererApi } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as lensScript from './lens.drs';

// #region quality
/** The ceilings: what each effect may cost. The per-frame dials below say how much of it to use. */
const stage = await openStage({
  outputTransform: 'aces',
  hdrScene: true,
  bloom: 0.35,
  bloomThreshold: 1.1,
  depthOfField: 0.02,
  cameraMotionBlur: 1,
  sceneSamples: 4,
});
// #endregion
const { renderer, camera } = stage;

// #region script
/** The lens, hosted: its record lives here, so a patched module carries on from it. */
const lens = hostScript(lensScript);
interface Lens {
  focusing: number;
  blurring: number;
}
const lensState = exported<() => Lens>(lens, 'createLens')();
type Present = (lens: Lens, renderer: RendererApi, turnRate: number, dt: number) => void;

if (import.meta.hot) {
  import.meta.hot.accept('./lens.drs', (next) => {
    if (next !== undefined)
      patchModule(lens, next as Record<string, unknown>, { Lens: [lensState] });
  });
}
// #endregion

const onOff = [
  { text: 'off', value: 'off' },
  { text: 'on', value: 'on' },
];
// #region switches
/** Each switch changes the running frame: a dial the lens reads, or a grade set once. */
controls([
  {
    key: 'grade',
    label: 'grade',
    value: flag('grade', 'warm'),
    options: ['none', 'warm', 'cool'].map((g) => ({ text: g, value: g })),
    change: (value) => applyGrade(value),
  },
  {
    key: 'focus',
    label: 'focus',
    value: flag('focus', 'on'),
    options: onOff,
    change: (value) => {
      lensState.focusing = value === 'on' ? 1 : 0;
    },
  },
  {
    key: 'blur',
    label: 'motion blur',
    value: flag('blur', 'on'),
    options: onOff,
    change: (value) => {
      lensState.blurring = value === 'on' ? 1 : 0;
    },
  },
]);
lensState.focusing = flag('focus', 'on') === 'on' ? 1 : 0;
lensState.blurring = flag('blur', 'on') === 'on' ? 1 : 0;
// #endregion

// #region grade
/**
 * A grade is a lookup table over display colours. Start from the identity and bend it: here every
 * colour leans warmer or cooler, the highlights more than the shadows.
 */
function gradeLut(look: 'warm' | 'cool'): ColourGradeLut {
  const lut = identityGradeLut(17);
  const warm = look === 'warm' ? 1 : -1;
  for (let i = 0; i < lut.data.length; i += 4) {
    const r = lut.data[i] / 255;
    const g = lut.data[i + 1] / 255;
    const b = lut.data[i + 2] / 255;
    const light = (r + g + b) / 3;
    const tilt = (0.3 + light) * 0.07 * warm;
    lut.data[i] = Math.round(Math.min(1, Math.max(0, r + tilt)) * 255);
    lut.data[i + 1] = Math.round(Math.min(1, Math.max(0, g + tilt * 0.3)) * 255);
    lut.data[i + 2] = Math.round(Math.min(1, Math.max(0, b - tilt)) * 255);
  }
  return lut;
}
const grades = { warm: gradeLut('warm'), cool: gradeLut('cool') };
function applyGrade(name: string): void {
  renderer.setColourGrade(name === 'warm' ? grades.warm : name === 'cool' ? grades.cool : null);
}
applyGrade(flag('grade', 'warm'));
// #endregion

const env = createEnvironment({
  directionalDir: [-0.6, 0.25, -0.4],
  directionalColor: [1.6, 1.1, 0.7],
  ambient: [0.14, 0.15, 0.22],
  ambientGround: [0.06, 0.05, 0.05],
  fogColor: [0.3, 0.27, 0.3],
  fogDensity: 0.01,
  nightFactor: 1,
  emissiveGain: 3,
});

/** Two rows of columns down a long floor, a lamp on each, and a figure halfway along. */
const set = new MeshBuilder();
set.addBox([0, -0.1, -30], [5, 0.1, 40], [0.4, 0.37, 0.34]);
for (let i = 0; i < 14; i += 1)
  for (const x of [-3, 3]) {
    set.addCylinder([x, 2.5, -i * 5], 0.3, 2.5, 'y', [0.62, 0.58, 0.52], 0, 14);
    set.addSphere([x * 0.85, 4.2, -i * 5], 0.12, [1, 0.7, 0.4], 1);
  }
set.addCapsule([0, 0.9, -15], 0.3, 0.6, [0.25, 0.32, 0.5]);
const setMesh = renderer.createMesh(set.build());
const still = new SceneNode();
still.updateWorld();

let time = 0;
let shownAt = 0;
let yaw = 0;
let lastYaw = 0;

stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    const dt = time - shownAt;
    shownAt = time;

    /* Every eight seconds the camera whips aside and back over two seconds. */
    const phase = time % 8;
    const whip = phase > 6 ? Math.sin(((phase - 6) / 2) * Math.PI) : 0;
    yaw = whip * 0.7;
    const turnRate = Math.abs(yaw - lastYaw) / Math.max(dt, 1e-3);
    lastYaw = yaw;

    camera.fovYDeg = 50;
    camera.position[0] = 0.8;
    camera.position[1] = 1.6;
    camera.position[2] = 6;
    camera.lookAt(0.8 + Math.sin(yaw) * 20, 1.2, 6 - Math.cos(yaw) * 20);

    // #region dials
    /* The lens: exposure, focus on the figure, blur while turning, and the fade in. */
    exported<Present>(lens, 'present')(lensState, renderer, turnRate, dt);
    /* What a script does not reach: the eye's adaptation, the vignette and the grain. */
    renderer.setAutoExposure(0.6, dt);
    renderer.setVignette(0.35);
    renderer.setFilmGrain(0.025, Math.floor(time * 60));
    // #endregion

    renderer.beginFrame([0.3, 0.27, 0.3]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(setMesh, still.worldMatrix);
    renderer.endFrame();
  },
});
