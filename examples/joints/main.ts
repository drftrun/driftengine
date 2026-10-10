/**
 * Bodies held together by joints: a bridge of planks hinged end to end, a door on a motor, a lamp
 * swinging from a hook, and a chain that snaps when it carries too much.
 *
 * Balls drop onto the bridge and into the chain's basket. Open and shut the door, and make the
 * chain breakable to watch a joint give way.
 */
import { MeshBuilder, computeLightMatrix, createEnvironment, srgbColor } from '@driftengine/core';
import type { MeshHandle, Vec3 } from '@driftengine/core';
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  JOINT_DISTANCE,
  JOINT_REVOLUTE,
  JOINT_SPHERICAL,
  PhysicsWorld,
  boxShape,
  sphereShape,
} from '@driftengine/physics';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';

/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.56, 0.62, 0.7);

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

const drawn: { body: number; mesh: MeshHandle }[] = [];
const box = (hx: number, hy: number, hz: number, colour: Vec3): MeshHandle =>
  renderer.createMesh(new MeshBuilder().addBox([0, 0, 0], [hx, hy, hz], colour).build());
const PLANK = box(0.38, 0.06, 0.9, [0.6, 0.45, 0.3]);
const POST = box(0.2, 1.6, 1.1, [0.42, 0.4, 0.38]);
const DOOR = box(0.9, 1.1, 0.06, [0.55, 0.32, 0.22]);
const LINK = box(0.08, 0.2, 0.08, [0.3, 0.3, 0.33]);
const BASKET = box(0.5, 0.08, 0.5, [0.35, 0.35, 0.38]);
const LAMP = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.3, [1, 0.85, 0.5], 1.4, 16, 8).build(),
);
const BALL = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.22, [0.3, 0.55, 0.9], 0, 16, 8).build(),
);

let world = new PhysicsWorld();
let door = -1;
let doorHinge = -1;
let chainJoints: number[] = [];
let balls: number[] = [];

const add = (desc: Parameters<PhysicsWorld['addBody']>[0], mesh: MeshHandle | null): number => {
  const body = world.addBody(desc);
  if (mesh !== null) drawn.push({ body, mesh });
  return body;
};

// #region bridge
/** Twelve planks between two posts, each hinged to the next about the axis across the bridge. */
function bridge(): void {
  const left = add({ type: BODY_STATIC, shape: boxShape(0.2, 1.6, 1.1), x: -5.4, y: 1.6 }, POST);
  const right = add({ type: BODY_STATIC, shape: boxShape(0.2, 1.6, 1.1), x: 5.4, y: 1.6 }, POST);
  let previous = left;
  let anchorX = 0.2;
  for (let i = 0; i < 12; i += 1) {
    const plank = add(
      {
        type: BODY_DYNAMIC,
        shape: boxShape(0.38, 0.06, 0.9),
        x: -4.8 + i * 0.84,
        y: 3,
        density: 400,
      },
      PLANK,
    );
    world.addJoint({
      type: JOINT_REVOLUTE,
      bodyA: previous,
      bodyB: plank,
      anchorAX: anchorX,
      anchorAY: previous === left ? 1.4 : 0,
      anchorBX: -0.42,
      axisZ: 1,
    });
    previous = plank;
    anchorX = 0.42;
  }
  world.addJoint({
    type: JOINT_REVOLUTE,
    bodyA: previous,
    bodyB: right,
    anchorAX: 0.42,
    anchorBX: -0.2,
    anchorBY: 1.4,
    axisZ: 1,
  });
}
// #endregion

// #region door
/** A door on a hinge with a motor, limited to swing from shut to a little past a right angle. */
function hingedDoor(): void {
  const frame = add(
    { type: BODY_STATIC, shape: boxShape(0.1, 1.2, 0.1), x: -2, y: 1.2, z: -4 },
    null,
  );
  door = add(
    { type: BODY_DYNAMIC, shape: boxShape(0.9, 1.1, 0.06), x: -1.05, y: 1.2, z: -4, density: 300 },
    DOOR,
  );
  doorHinge = world.addJoint({
    type: JOINT_REVOLUTE,
    bodyA: frame,
    bodyB: door,
    anchorBX: -0.95,
    axisY: 1,
    /* Angular limits are sines of half angles: shut, and open to 110 degrees. */
    lower: 0,
    upper: Math.sin((110 * Math.PI) / 360),
    motorSpeed: 0,
    motorMaxForce: 400,
  });
}
// #endregion

// #region lamp
/** A lamp on a cord: a distance joint holds it two metres from its hook, and it swings. */
function lamp(): void {
  const hook = add({ type: BODY_STATIC, shape: sphereShape(0.05), x: 3, y: 5.5, z: -4 }, null);
  const shade = add({ type: BODY_DYNAMIC, shape: sphereShape(0.3), x: 4.2, y: 4, z: -4 }, LAMP);
  world.addJoint({ type: JOINT_DISTANCE, bodyA: hook, bodyB: shade, length: 2 });
}
// #endregion

// #region chain
/** Links joined at their ends, and a basket at the bottom. Breakable, each joint gives way above a load. */
function chain(breakable: boolean): void {
  const ceiling = add(
    { type: BODY_STATIC, shape: boxShape(0.3, 0.05, 0.3), x: 7.5, y: 5.6, z: 2 },
    null,
  );
  chainJoints = [];
  let previous = ceiling;
  let anchorY = -0.05;
  for (let i = 0; i < 8; i += 1) {
    const link = add(
      {
        type: BODY_DYNAMIC,
        shape: boxShape(0.08, 0.2, 0.08),
        x: 7.5,
        y: 5.35 - i * 0.42,
        z: 2,
        density: 800,
      },
      LINK,
    );
    chainJoints.push(
      world.addJoint({
        type: JOINT_SPHERICAL,
        bodyA: previous,
        bodyB: link,
        anchorAY: anchorY,
        anchorBY: 0.21,
        breakImpulse: breakable ? 60 : Infinity,
      }),
    );
    previous = link;
    anchorY = -0.21;
  }
  const basket = add(
    { type: BODY_DYNAMIC, shape: boxShape(0.5, 0.08, 0.5), x: 7.5, y: 1.85, z: 2, density: 300 },
    BASKET,
  );
  world.addJoint({
    type: JOINT_SPHERICAL,
    bodyA: previous,
    bodyB: basket,
    anchorAY: -0.21,
    anchorBY: 0.1,
  });
}
// #endregion

let doorOpen = flag('door', 'open') === 'open';
let breakable = flag('chain', 'strong') === 'breakable';
function build(): void {
  world = new PhysicsWorld({ substeps: 6 });
  drawn.length = 0;
  add({ type: BODY_STATIC, shape: boxShape(14, 0.5, 10), y: -0.5 }, null);
  bridge();
  hingedDoor();
  lamp();
  chain(breakable);
  balls = Array.from({ length: 10 }, (_, i) =>
    add(
      { type: BODY_DYNAMIC, shape: sphereShape(0.22), x: 0, y: -20 - i, z: 0, density: 900 },
      BALL,
    ),
  );
}
build();

controls([
  {
    key: 'door',
    label: 'door',
    value: doorOpen ? 'open' : 'shut',
    options: ['open', 'shut'].map((d) => ({ text: d, value: d })),
    change: (value) => {
      doorOpen = value === 'open';
    },
  },
  {
    key: 'chain',
    label: 'chain',
    value: breakable ? 'breakable' : 'strong',
    options: ['strong', 'breakable'].map((c) => ({ text: c, value: c })),
    change: (value) => {
      breakable = value === 'breakable';
      build();
    },
  },
]);

const ground = box(14, 0.5, 10, [0.38, 0.42, 0.34]);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const groundModel = new Float32Array(IDENTITY);
groundModel[13] = -0.5;
const model = new Float32Array(16);
function placed(body: number): Float32Array {
  const b = world.bodies;
  const x = b.rotX[body] ?? 0;
  const y = b.rotY[body] ?? 0;
  const z = b.rotZ[body] ?? 0;
  const w = b.rotW[body] ?? 1;
  model.set([
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    b.posX[body] ?? 0,
    b.posY[body] ?? 0,
    b.posZ[body] ?? 0,
    1,
  ]);
  return model;
}

const env = createEnvironment({
  directionalDir: [-0.35, 0.8, 0.5],
  directionalColor: [1.7, 1.6, 1.45],
  ambient: [0.3, 0.33, 0.4],
  ambientGround: [0.13, 0.12, 0.11],
  nightFactor: 0.5,
  emissiveGain: 1.4,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  1,
  2,
  -1,
  12,
  renderer.shadowMapSize,
  lightMatrix,
);
const readout = createReadout(renderer, 1);
let time = 0;
let tick = 0;

stage.run({
  simulate(dt) {
    time += dt;
    tick += 1;
    /* The motor drives toward open or shut; the limits stop it at either end. */
    world.joints.motorSpeed[doorHinge] = doorOpen ? -1.5 : 1.5;
    /* A ball every second and a half, onto the bridge or into the basket, from a fixed pattern. */
    if (tick % 90 === 0) {
      const drop = tick / 90;
      const ball = balls[drop % balls.length] ?? 0;
      const onBridge = drop % 3 !== 2;
      world.setPosition(
        ball,
        onBridge ? ((drop * 37) % 80) / 10 - 4 : 7.5,
        onBridge ? 6 : 4,
        onBridge ? 0 : 2,
      );
      world.setVelocity(ball, 0, 0, 0);
    }
    world.step(dt);
  },
  render() {
    camera.fovYDeg = 50;
    camera.position[0] = Math.sin(time * 0.1) * 4;
    camera.position[1] = 6;
    camera.position[2] = 13;
    camera.lookAt(1, 2.2, -0.5);
    const drawAll = (draw: (mesh: MeshHandle, matrix: Float32Array) => void): void => {
      draw(ground, groundModel);
      for (const thing of drawn) draw(thing.mesh, placed(thing.body));
    };
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => drawAll((mesh, matrix) => sink.mesh(mesh, matrix)));
    renderer.endShadowPass();
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    drawAll((mesh, matrix) => renderer.drawMesh(mesh, matrix));
    const broken = chainJoints.filter((joint) => world.joints.broken[joint] === 1).length;
    readout.set(0, `${world.joints.count} JOINTS  ${broken} BROKEN`);
    readout.draw(time);
    renderer.endFrame();
  },
});
