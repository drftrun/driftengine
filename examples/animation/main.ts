/**
 * A figure walking a circle round a lantern: it idles, walks or runs as the switch says, its feet
 * keeping pace with the ground, and its right hand reaches for the lantern as it passes.
 *
 * Everything is built here: the skeleton, a mesh skinned to it a piece a bone, and three clips as
 * keyframes. A blend tree crossfades the clips over one speed parameter; the walk and the run keep
 * distance as their clock and the idle keeps time. The animation logic is a DriftScript module
 * through `drift/animation`: it eases the pace, samples the tree, and solves the arm's two-bone
 * reach.
 */
import { BlendTree, Skeleton, createPose } from '@driftengine/animation';
import type { AnimationClip, JointTrack, Pose } from '@driftengine/animation';
import { MeshBuilder, computeLightMatrix, createEnvironment, srgbColor } from '@driftengine/core';
import type { Vec3 } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as rigScript from './rig.drs';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.56, 0.62, 0.7);

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region skeleton
/** Seventeen joints in a relaxed standing pose, each with its parent and a name. */
const JOINTS: [string, number, number, number, number][] = [
  ['hips', -1, 0, 1.0, 0],
  ['spine', 0, 0, 1.25, 0],
  ['chest', 1, 0, 1.5, 0],
  ['neck', 2, 0, 1.68, 0],
  ['head', 3, 0, 1.82, 0],
  ['leftShoulder', 2, 0.22, 1.55, 0],
  ['leftElbow', 5, 0.25, 1.27, 0],
  ['leftHand', 6, 0.27, 1.0, 0],
  ['rightShoulder', 2, -0.22, 1.55, 0],
  ['rightElbow', 8, -0.25, 1.27, 0],
  ['rightHand', 9, -0.27, 1.0, 0],
  ['leftHip', 0, 0.1, 0.95, 0],
  ['leftKnee', 11, 0.1, 0.52, 0],
  ['leftFoot', 12, 0.1, 0.08, 0],
  ['rightHip', 0, -0.1, 0.95, 0],
  ['rightKnee', 14, -0.1, 0.52, 0],
  ['rightFoot', 15, -0.1, 0.08, 0],
];
/** The inverse of each joint's place in the bind pose: here only a translation, undone. */
const inverseBind = new Float32Array(JOINTS.length * 16);
JOINTS.forEach(([, , x, y, z], j) => {
  inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1], j * 16);
});
const skeleton = new Skeleton(
  JOINTS.map(([name, parent]) => ({ name, parent })),
  inverseBind,
);
/** The bind pose as each joint relative to its parent, which a clip leaves where it does not reach. */
const bind = createPose(JOINTS.length);
JOINTS.forEach(([, parent, x, y, z], j) => {
  const [, , px, py, pz] = JOINTS[parent] ?? ['', -1, 0, 0, 0];
  bind.translation.set(parent < 0 ? [x, y, z] : [x - px, y - py, z - pz], j * 3);
});
// #endregion

// #region mesh
/** A piece of the body a bone, each bound rigidly to the joint the bone hangs from. */
const SKIN: Vec3 = [0.85, 0.66, 0.52];
const CLOTH: Vec3 = [0.3, 0.42, 0.62];
const body = new MeshBuilder();
body.setJoint(0).addBox([0, 1.0, 0], [0.17, 0.1, 0.11], CLOTH);
body.setJoint(1).addBox([0, 1.2, 0], [0.16, 0.13, 0.1], CLOTH);
body.setJoint(2).addBox([0, 1.45, 0], [0.21, 0.14, 0.12], CLOTH);
body.setJoint(3).addCapsule([0, 1.68, 0], 0.045, 0.05, SKIN);
body.setJoint(4).addSphere([0, 1.86, 0], 0.13, SKIN, 0, 16, 10);
for (const [shoulder, side] of [
  [5, 1],
  [8, -1],
] as const) {
  body.setJoint(shoulder).addCapsule([side * 0.235, 1.41, 0], 0.055, 0.11, CLOTH);
  body.setJoint(shoulder + 1).addCapsule([side * 0.26, 1.14, 0], 0.05, 0.1, SKIN);
  body.setJoint(shoulder + 2).addSphere([side * 0.27, 0.97, 0], 0.055, SKIN);
}
for (const [hip, side] of [
  [11, 1],
  [14, -1],
] as const) {
  body.setJoint(hip).addCapsule([side * 0.1, 0.74, 0], 0.075, 0.15, CLOTH);
  body.setJoint(hip + 1).addCapsule([side * 0.1, 0.3, 0], 0.06, 0.16, [0.25, 0.25, 0.28]);
  body.setJoint(hip + 2).addBox([side * 0.1, 0.04, 0.05], [0.06, 0.04, 0.11], [0.2, 0.18, 0.16]);
}
const figure = renderer.createMesh(body.build());
// #endregion

// #region clips
/** A rotation about x as a quaternion: positive swings a hanging limb forward. */
const pitch = (a: number): number[] => [-Math.sin(a / 2), 0, 0, Math.cos(a / 2)];

/** A looping clip from keys spread evenly over its duration, a joint's angles at a time. */
function clip(
  name: string,
  durationSec: number,
  angles: Record<number, number[]>,
  bob: number[],
): AnimationClip {
  const tracks: JointTrack[] = [];
  for (const [joint, keys] of Object.entries(angles)) {
    const times = Float32Array.from(keys, (_, i) => (i / (keys.length - 1)) * durationSec);
    tracks.push({
      joint: Number(joint),
      path: 'rotation',
      times,
      values: Float32Array.from(keys.flatMap(pitch)),
    });
  }
  const times = Float32Array.from(bob, (_, i) => (i / (bob.length - 1)) * durationSec);
  tracks.push({
    joint: 0,
    path: 'translation',
    times,
    values: Float32Array.from(bob.flatMap((y) => [0, y, 0])),
  });
  return { name, durationSec, tracks };
}
/** One way, back through the middle, and the other way: a leg or an arm across a stride. */
const swing = (a: number): number[] => [a, 0, -a, 0, a];
/** A stride a second: legs and arms swing opposite, a knee folds as its foot passes, the hips dip. */
const WALK = clip(
  'walk',
  1,
  {
    11: swing(0.45),
    14: swing(-0.45),
    12: [0, -0.15, 0, -0.6, 0],
    15: [0, -0.6, 0, -0.15, 0],
    5: swing(-0.35),
    8: swing(0.35),
  },
  [1.0, 0.97, 1.0, 0.97, 1.0],
);
// #endregion
const RUN = clip(
  'run',
  0.7,
  {
    11: swing(0.8),
    14: swing(-0.8),
    12: [-0.2, -0.3, -0.2, -1.2, -0.2],
    15: [-0.2, -1.2, -0.2, -0.3, -0.2],
    5: swing(-0.7),
    8: swing(0.7),
    6: [0.9, 0.9, 0.9, 0.9, 0.9],
    9: [0.9, 0.9, 0.9, 0.9, 0.9],
    /* A lean into the run: the spine points up, so forward is the other sign. */
    1: [-0.15, -0.15, -0.15, -0.15, -0.15],
  },
  [0.95, 1.0, 0.95, 1.0, 0.95],
);
const IDLE = clip(
  'idle',
  3,
  { 2: [0, 0.03, 0, 0.03, 0], 5: [0, 0.04, 0, 0.04, 0], 8: [0, 0.04, 0, 0.04, 0] },
  [1, 1.005, 1, 1.005, 1],
);

// #region tree
/** Idle, walk and run over one speed parameter. The walk and run take distance as their clock. */
const tree = new BlendTree(
  {
    kind: 'oneDimensional',
    parameter: 'speed',
    children: [
      { at: 0, node: { kind: 'clip', clip: IDLE } },
      { at: 1.4, node: { kind: 'clip', clip: WALK, clock: 'walkClock' } },
      { at: 4, node: { kind: 'clip', clip: RUN, clock: 'runClock' } },
    ],
  },
  JOINTS.length,
  bind,
);
const pose = createPose(JOINTS.length);
// #endregion

// #region script
/** The rig's logic, hosted, and its record of the pace. */
const rig = hostScript(rigScript);
interface Gait {
  wanted: number;
  speed: number;
  travelled: number;
  reaching: boolean;
  reached: boolean;
}
const gait = exported<() => Gait>(rig, 'createGait')();
type Animate = (
  gait: Gait,
  tree: BlendTree,
  skeleton: Skeleton,
  pose: Pose,
  at: number,
  dt: number,
  x: number,
  y: number,
  z: number,
) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./rig.drs', (next) => {
    if (next !== undefined) patchModule(rig, next as Record<string, unknown>, { Gait: [gait] });
  });
}
// #endregion

const PACES: Record<string, number> = { idle: 0, walk: 1.4, run: 4 };
gait.wanted = PACES[flag('pace', 'walk')] ?? 1.4;
gait.reaching = flag('reach', 'on') === 'on';
controls([
  {
    key: 'pace',
    label: 'pace',
    value: flag('pace', 'walk'),
    options: ['idle', 'walk', 'run'].map((p) => ({ text: p, value: p })),
    change: (value) => {
      gait.wanted = PACES[value] ?? 1.4;
    },
  },
  {
    key: 'reach',
    label: 'reach',
    value: gait.reaching ? 'on' : 'off',
    options: ['on', 'off'].map((r) => ({ text: r, value: r })),
    change: (value) => {
      gait.reaching = value === 'on';
    },
  },
]);

/** The figure walks a circle round the origin; the lantern hangs just inside it, to its right. */
const RADIUS = 2.5;
const LANTERN: Vec3 = [-1.9, 1.75, 0];
let around = Math.PI / 2;
const model = new Float32Array(16);
const lanternLocal = new Float32Array(3);

const ground = renderer.createMesh(
  new MeshBuilder().addBox([0, -0.1, 0], [60, 0.1, 60], [0.36, 0.42, 0.33]).build(),
);
const post = renderer.createMesh(
  new MeshBuilder()
    .addCylinder([LANTERN[0] + 0.6, 1.05, 0], 0.04, 1.05, 'y', [0.25, 0.25, 0.27])
    .addBox([LANTERN[0] + 0.3, 2.08, 0], [0.32, 0.025, 0.025], [0.25, 0.25, 0.27])
    .addBox([LANTERN[0], 1.97, 0], [0.008, 0.1, 0.008], [0.2, 0.2, 0.2])
    .addSphere(LANTERN, 0.12, [1, 0.85, 0.5], 2, 14, 8)
    .build(),
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const env = createEnvironment({
  directionalDir: [0.45, 0.8, -0.4],
  directionalColor: [1.7, 1.6, 1.45],
  ambient: [0.32, 0.35, 0.42],
  ambientGround: [0.13, 0.12, 0.11],
  nightFactor: 0.6,
  emissiveGain: 1.2,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1,
  0,
  4.5,
  renderer.shadowMapSize,
  lightMatrix,
);
const readout = createReadout(renderer, 1);
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
    /* Counter-clockwise round the circle at the figure's own pace, facing the way it goes. */
    around += (gait.speed * dt) / RADIUS;
    const x = Math.cos(around) * RADIUS;
    const z = Math.sin(around) * RADIUS;
    const heading = Math.atan2(-Math.sin(around), Math.cos(around));
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    model.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 0, z, 1]);
    /* The lantern in the figure's own frame: the inverse of a turn and a move. */
    const dx = LANTERN[0] - x;
    const dz = LANTERN[2] - z;
    lanternLocal[0] = c * dx - s * dz;
    lanternLocal[1] = LANTERN[1];
    lanternLocal[2] = s * dx + c * dz;
    exported<Animate>(rig, 'animate')(
      gait,
      tree,
      skeleton,
      pose,
      time,
      dt,
      lanternLocal[0],
      lanternLocal[1],
      lanternLocal[2],
    );
  },
  render() {
    camera.fovYDeg = 40;
    camera.position[0] = 3;
    camera.position[1] = 3.2;
    camera.position[2] = -7.5;
    camera.lookAt(-0.6, 0.8, 0);
    skeleton.applyPose(pose);
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(ground, IDENTITY);
      sink.mesh(post, IDENTITY);
      sink.skinnedMesh(figure, model, skeleton.palette);
    });
    renderer.endShadowPass();
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(ground, IDENTITY);
    renderer.drawMesh(post, IDENTITY);
    // #region draw
    /* The palette is each joint's world matrix times its inverse bind; the mesh deforms by it. */
    renderer.setSkinPalette(skeleton.palette);
    renderer.drawMesh(figure, model);
    renderer.setSkinPalette(null);
    // #endregion
    readout.set(0, `${gait.speed.toFixed(1)} M/S${gait.reached ? '  REACHING' : ''}`);
    readout.draw(time);
    renderer.endFrame();
  },
});
