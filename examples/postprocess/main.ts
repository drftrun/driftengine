/**
 * The post chain: ambient occlusion, bloom, and the grade that makes bloom mean anything.
 *
 * All three are chosen when the renderer is built, not per frame, which is why the switches
 * here reload the page. That is the real constraint and the example does not hide it: an
 * allocation-sized decision belongs outside the frame loop.
 *
 * **Bloom and `hdrScene` belong together.** `hdrScene` keeps the scene's real brightness to
 * the end of the frame instead of clipping it into 0..1 as each surface is shaded, and bloom
 * reads its threshold *in scene units*. Without the range, a lamp and a white wall arrive at
 * the composite as the same colour and a threshold of 1 finds nothing at all — so the lamp
 * below is emissive, and it only blooms once the range is kept.
 */
import { MeshBuilder, SceneNode, createEnvironment } from '@driftengine/core';
import { controls, flagNumber, openStage } from '../common/stage';

/**
 * Dusk rather than the shared daylight, and that is a requirement rather than a mood.
 *
 * The emissive term is gated on `nightFactor`: the shader multiplies it by exactly that, so a
 * lamp in an environment with `nightFactor: 0` emits nothing at all however high its own
 * emissive value is, and bloom then has nothing above the threshold to find. This is the
 * single easiest way to conclude that bloom is broken when it is working perfectly.
 */
const DUSK = createEnvironment({
  directionalDir: [0.4, 0.5, 0.35],
  directionalColor: [0.5, 0.52, 0.62],
  ambient: [0.1, 0.11, 0.16],
  ambientGround: [0.04, 0.04, 0.06],
  emissiveGain: 2,
  nightFactor: 1,
  fogColor: [0.1, 0.11, 0.16],
  fogDensity: 0.004,
  fogHeightFalloff: 0.03,
  fogBaseY: 0,
});

const bloom = flagNumber('bloom', 0);
const ao = flagNumber('ao', 0);

const stage = await openStage({
  ambientOcclusion: ao,
  ambientOcclusionRadius: 0.6,
  hdrScene: bloom > 0,
  bloom,
  bloomThreshold: 1.2,
  outputTransform: bloom > 0 ? 'aces' : 'none',
  directionalShadows: true,
});

controls([
  {
    label: 'ambient occlusion',
    options: [
      { text: 'off', query: `bloom=${bloom}&ao=0` },
      { text: 'on', query: `bloom=${bloom}&ao=1` },
    ],
  },
  {
    label: 'bloom',
    options: [
      { text: 'off', query: `bloom=0&ao=${ao}` },
      { text: 'on', query: `bloom=0.9&ao=${ao}` },
    ],
  },
]);

/*
 * Corners are what ambient occlusion is about — it darkens where surfaces meet and light
 * cannot easily reach. A single object floating in space would show almost nothing, so this
 * is a huddle of boxes standing on a slab, which is all contact.
 */
const solids = new MeshBuilder();
solids.addBox([0, -0.25, 0], [9, 0.25, 9], [0.34, 0.36, 0.4]);
solids.addBox([-2.2, 1, -1.4], [1, 1, 1], [0.7, 0.72, 0.78]);
solids.addBox([0.4, 0.7, 0.6], [0.7, 0.7, 0.7], [0.66, 0.5, 0.42]);
solids.addBox([2.4, 1.4, -0.8], [0.5, 1.4, 0.5], [0.55, 0.6, 0.7]);
const scene = stage.renderer.createMesh(solids.build());

/** Emissive, so it is brighter than 1 in scene units and is the only thing bloom can find. */
const lampMesh = new MeshBuilder();
lampMesh.addBox([0, 0, 0], [0.35, 0.35, 0.35], [1, 0.82, 0.55], 1.6);
const lamp = stage.renderer.createMesh(lampMesh.build());

const still = new SceneNode();
still.updateWorld();
const lampNode = new SceneNode();

let turn = 0;
let previousTurn = 0;

stage.camera.position[0] = 7.5;
stage.camera.position[1] = 4.2;
stage.camera.position[2] = 7.5;
stage.camera.lookAt(0, 1, 0);

stage.run({
  simulate(dt) {
    previousTurn = turn;
    turn += dt * 0.6;
  },
  render(alpha) {
    const angle = previousTurn + (turn - previousTurn) * alpha;
    /* A short orbit high over the huddle, so the lamp is never behind a box and bloom always
     * has something to find — an example whose subject hides half the time teaches nothing. */
    lampNode.setPosition(Math.sin(angle) * 1.7, 2.9, Math.cos(angle) * 1.7 + 0.6);
    lampNode.updateWorld();

    stage.renderer.beginFrame([0.04, 0.045, 0.07]);
    stage.renderer.bindMeshPass(stage.camera, DUSK);
    stage.renderer.drawMesh(scene, still.worldMatrix);
    stage.renderer.drawMesh(lamp, lampNode.worldMatrix);
    stage.renderer.endFrame();
  },
});
