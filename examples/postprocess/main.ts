/**
 * The post chain: ambient occlusion, bloom, and the grade that makes bloom mean anything.
 *
 * Ambient occlusion is chosen when the renderer is built, because it decides what is allocated,
 * so its switch builds a new renderer in place and the lamp carries on circling. Bloom has a
 * ceiling chosen at build time and a dial that moves per frame, so its switch is the dial.
 *
 * **Bloom and `hdrScene` belong together.** `hdrScene` keeps the scene's real brightness to
 * the end of the frame instead of clipping it into 0..1 as each surface is shaded, and bloom
 * reads its threshold *in scene units*. Without the range, a lamp and a white wall arrive at
 * the composite as the same colour and a threshold of 1 finds nothing at all — so the lamp
 * below is emissive, and it only blooms once the range is kept.
 */
import { MeshBuilder, SceneNode, createEnvironment, srgbColor } from '@driftengine/core';
import type { RendererApi } from '@driftengine/core';
import { controls, flag, openScene } from '../common/stage';
import type { SceneHooks } from '../common/stage';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.04, 0.045, 0.07);

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

const still = new SceneNode();
still.updateWorld();
const lampNode = new SceneNode();
let turn = 0;
let previousTurn = 0;
/** Bloom is a dial: the ceiling below is fixed, and this is how much of it the frame takes. */
let bloomShare = flag('bloom', 'off') === 'on' ? 1 : 0;

// #region quality
/**
 * Ambient occlusion decides what the renderer allocates, so its switch builds a new renderer.
 * Bloom's ceiling is set once with the range it needs, and its switch moves the dial.
 */
const quality = (ao: string) => ({
  ambientOcclusion: ao === 'on' ? 1 : 0,
  ambientOcclusionRadius: 0.6,
  hdrScene: true,
  bloom: 0.9,
  bloomThreshold: 1.2,
  outputTransform: 'aces' as const,
  directionalShadows: true,
});
// #endregion

/** What one renderer draws. */
function build(renderer: RendererApi): SceneHooks {
  /*
   * Corners are what ambient occlusion is about: it darkens where surfaces meet and light
   * cannot easily reach. A single object floating in space would show almost nothing, so this
   * is a huddle of boxes standing on a slab, which is all contact.
   */
  const solids = new MeshBuilder();
  solids.addBox([0, -0.25, 0], [9, 0.25, 9], [0.34, 0.36, 0.4]);
  solids.addBox([-2.2, 1, -1.4], [1, 1, 1], [0.7, 0.72, 0.78]);
  solids.addBox([0.4, 0.7, 0.6], [0.7, 0.7, 0.7], [0.66, 0.5, 0.42]);
  solids.addBox([2.4, 1.4, -0.8], [0.5, 1.4, 0.5], [0.55, 0.6, 0.7]);
  const huddle = renderer.createMesh(solids.build());

  // #region lamp
  /** Emissive, so it is brighter than 1 in scene units and is the only thing bloom can find. */
  const lampMesh = new MeshBuilder();
  lampMesh.addBox([0, 0, 0], [0.35, 0.35, 0.35], [1, 0.82, 0.55], 1.6);
  const lamp = renderer.createMesh(lampMesh.build());
  // #endregion

  return {
    simulate(dt) {
      previousTurn = turn;
      turn += dt * 0.6;
    },
    render(alpha) {
      const angle = previousTurn + (turn - previousTurn) * alpha;
      /* A short orbit high over the huddle, so the lamp is never behind a box and bloom always
       * has something to find: an example whose subject hides half the time teaches nothing. */
      lampNode.setPosition(Math.sin(angle) * 1.7, 2.9, Math.cos(angle) * 1.7 + 0.6);
      lampNode.updateWorld();

      renderer.setBloom(bloomShare);
      renderer.beginFrame(CLEAR);
      renderer.bindMeshPass(scene.camera, DUSK);
      renderer.drawMesh(huddle, still.worldMatrix);
      renderer.drawMesh(lamp, lampNode.worldMatrix);
      renderer.endFrame();
    },
  };
}

const scene = await openScene(quality(flag('ao', 'off')), build);

const onOff = [
  { text: 'off', value: 'off' },
  { text: 'on', value: 'on' },
];
controls([
  {
    key: 'ao',
    label: 'ambient occlusion',
    value: flag('ao', 'off'),
    options: onOff,
    change: (value) => scene.rebuild(quality(value)),
  },
  {
    key: 'bloom',
    label: 'bloom',
    value: flag('bloom', 'off'),
    options: onOff,
    change: (value) => {
      bloomShare = value === 'on' ? 1 : 0;
    },
  },
]);

scene.camera.position[0] = 7.5;
scene.camera.position[1] = 4.2;
scene.camera.position[2] = 7.5;
scene.camera.lookAt(0, 1, 0);
