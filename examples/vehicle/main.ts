/**
 * A car on a ring of cones, with a ramp to jump. The car is a raycast vehicle: a chassis body and
 * four wheels that are rays, each on a spring, gripping by a tyre curve the page supplies.
 *
 * The driver is a DriftScript module: the keys or a stick through `drift/input`, or a lap of the
 * ring the car drives by itself until a key is pressed. W and S or the arrows drive, A and D steer,
 * Space brakes. Switch the tyres to ice to drive on a curve with a fifth of the grip.
 */
import {
  ActionMap,
  InputSource,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  srgbColor,
} from '@driftengine/core';
import type { MeshHandle } from '@driftengine/core';
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  PhysicsWorld,
  Vehicle,
  boxShape,
  cylinderShape,
  defaultTyreCurve,
} from '@driftengine/physics';
import type { VehicleOptions } from '@driftengine/physics';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as driveScript from './drive.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera, canvas } = stage;

// #region world
/** Flat ground, a ring of cones the car laps inside, and a ramp across the ring. */
const world = new PhysicsWorld({ substeps: 4 });
world.addBody({ type: BODY_STATIC, shape: boxShape(60, 0.5, 60), y: -0.5, friction: 0.9 });
const cones: [number, number][] = [];
for (let i = 0; i < 36; i += 1) {
  const a = (i / 36) * Math.PI * 2;
  for (const r of [14, 22]) cones.push([Math.cos(a) * r, Math.sin(a) * r]);
}
for (const [x, z] of cones) {
  world.addBody({ type: BODY_STATIC, shape: cylinderShape(0.2, 0.35), x, y: 0.35, z });
}
/* Rising twelve degrees toward +z, the way the lap runs past it, so the car jumps off its end. */
const rampTilt = (12 * Math.PI) / 360;
world.addBody({
  type: BODY_STATIC,
  shape: boxShape(3, 0.3, 2.5),
  x: 18,
  y: 0.25,
  z: 0,
  qx: -Math.sin(rampTilt),
  qw: Math.cos(rampTilt),
});
// #endregion

// #region car
/**
 * The chassis, a box of about 1,200 kilograms, and four wheels: the front ones steer, all drive.
 *
 * It starts on the line through the middle of the ramp, facing it, so the first press of W goes
 * straight up and off the end. Seven metres short of the ramp the chassis clears the outer ring of
 * cones by almost a metre; started at twelve, it overlapped one and came to rest propped on it with
 * two wheels in the air, and no key moved it.
 */
const chassis = world.addBody({
  type: BODY_DYNAMIC,
  shape: boxShape(0.9, 0.35, 2),
  x: 18,
  y: 1.2,
  z: -7,
  density: 240,
});
const WHEELS = [
  { x: -0.85, y: -0.2, z: 1.3, steers: true, driven: true },
  { x: 0.85, y: -0.2, z: 1.3, steers: true, driven: true },
  { x: -0.85, y: -0.2, z: -1.3, driven: true },
  { x: 0.85, y: -0.2, z: -1.3, driven: true },
];
const TYRES: Record<string, Pick<VehicleOptions, 'longitudinal' | 'lateral'>> = {
  tarmac: { longitudinal: defaultTyreCurve(1.2), lateral: defaultTyreCurve(1.4) },
  ice: { longitudinal: defaultTyreCurve(0.25), lateral: defaultTyreCurve(0.3) },
};
let tyres = flag('tyres', 'tarmac');
let car = new Vehicle(chassis, { wheels: WHEELS, ...TYRES[tyres] });
// #endregion

const input = new InputSource(canvas, ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const actions = new ActionMap(input, {
  move: {
    stick: 'left',
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  brake: { keys: ['Space'], buttons: ['faceDown'] },
});

// #region script
/** The driver, hosted, and the pedals it sets each tick. */
const driver = hostScript(driveScript);
interface Pedals {
  throttle: number;
  brake: number;
  steer: number;
}
const pedals = exported<() => Pedals>(driver, 'createPedals')();
type Drive = (pedals: Pedals, actions: ActionMap) => void;
type Lap = (pedals: Pedals, x: number, z: number, heading: number, radius: number) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./drive.drs', (next) => {
    if (next !== undefined)
      patchModule(driver, next as Record<string, unknown>, { Pedals: [pedals] });
  });
}
// #endregion

controls([
  {
    key: 'tyres',
    label: 'tyres',
    value: tyres,
    options: ['tarmac', 'ice'].map((t) => ({ text: t, value: t })),
    change: (value) => {
      tyres = value;
      /* The curves are the vehicle's options: a new vehicle takes over the same chassis. */
      car = new Vehicle(chassis, { wheels: WHEELS, ...TYRES[tyres] });
    },
  },
]);

/** The chassis's matrix, from its body, and the way it points as a heading about y. */
const model = new Float32Array(16);
function chassisMatrix(): Float32Array {
  const b = world.bodies;
  const x = b.rotX[chassis] ?? 0;
  const y = b.rotY[chassis] ?? 0;
  const z = b.rotZ[chassis] ?? 0;
  const w = b.rotW[chassis] ?? 1;
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
    b.posX[chassis] ?? 0,
    b.posY[chassis] ?? 0,
    b.posZ[chassis] ?? 0,
    1,
  ]);
  return model;
}
const heading = (): number => Math.atan2(model[8] ?? 0, model[10] ?? 1);

let playing = false;
let time = 0;
stage.run({
  simulate(dt) {
    time += dt;
    chassisMatrix();
    if (actions.down('brake') || actions.axis('move', 'x') !== 0 || actions.axis('move', 'y') !== 0)
      playing = true;
    if (playing) exported<Drive>(driver, 'drive')(pedals, actions);
    else
      exported<Lap>(driver, 'lap')(
        pedals,
        world.bodies.posX[chassis] ?? 0,
        world.bodies.posZ[chassis] ?? 0,
        heading(),
        18,
      );
    car.update(world, dt, pedals);
    world.step(dt);
  },
  render: drawFrame,
});

const ground = renderer.createMesh(
  new MeshBuilder().addBox([0, -0.5, 0], [60, 0.5, 60], [0.33, 0.36, 0.34]).build(),
);
const cone = renderer.createMesh(
  cones
    .reduce(
      (b, [x, z]) => b.addCylinder([x, 0.35, z], 0.2, 0.35, 'y', [1, 0.5, 0.15], 0, 8),
      new MeshBuilder(),
    )
    .build(),
);
const ramp = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [3, 0.3, 2.5], [0.6, 0.58, 0.54]).build(),
);
const rampModel = Float32Array.of(
  ...[1, 0, 0, 0],
  ...[0, Math.cos(rampTilt * 2), -Math.sin(rampTilt * 2), 0],
  ...[0, Math.sin(rampTilt * 2), Math.cos(rampTilt * 2), 0],
  ...[18, 0.25, 0, 1],
);
const body = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, 0, 0], [0.9, 0.35, 2], [0.85, 0.2, 0.18])
    .addBox([0, 0.5, -0.3], [0.75, 0.25, 0.9], [0.2, 0.25, 0.3])
    .build(),
);
const wheel = renderer.createMesh(
  new MeshBuilder().addCylinder([0, 0, 0], 0.35, 0.15, 'x', [0.12, 0.12, 0.13], 0, 16).build(),
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const wheelModel = new Float32Array(16);

/** A wheel hangs below its anchor by the travel it has left, in the chassis's own frame. */
function wheelMatrix(i: number): Float32Array {
  const w = WHEELS[i];
  const m = model;
  const lx = w?.x ?? 0;
  const ly = (w?.y ?? 0) - (0.3 - (car.compression[i] ?? 0));
  const lz = w?.z ?? 0;
  const steer = w?.steers === true ? Math.atan(pedals.steer * 0.6) : 0;
  const c = Math.cos(steer);
  const s = Math.sin(steer);
  /* The chassis's axes, the wheel turned about the chassis's up by its steering. */
  for (let k = 0; k < 3; k += 1) {
    wheelModel[k] = (m[k] ?? 0) * c - (m[8 + k] ?? 0) * s;
    wheelModel[4 + k] = m[4 + k] ?? 0;
    wheelModel[8 + k] = (m[k] ?? 0) * s + (m[8 + k] ?? 0) * c;
    wheelModel[12 + k] =
      (m[12 + k] ?? 0) + (m[k] ?? 0) * lx + (m[4 + k] ?? 0) * ly + (m[8 + k] ?? 0) * lz;
  }
  wheelModel[15] = 1;
  return wheelModel;
}

const env = createEnvironment({
  directionalDir: [-0.4, 0.75, 0.5],
  directionalColor: [1.8, 1.7, 1.5],
  ambient: [0.32, 0.35, 0.42],
  ambientGround: [0.13, 0.12, 0.11],
  fogColor: [0.62, 0.68, 0.76],
  fogDensity: 0.008,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
const readout = createReadout(renderer, 1);
const SKY = srgbColor(0.62, 0.68, 0.76);
const chase = { x: 18, y: 4, z: -16 };

function drawFrame(): void {
  chassisMatrix();
  const cx = world.bodies.posX[chassis] ?? 0;
  const cy = world.bodies.posY[chassis] ?? 0;
  const cz = world.bodies.posZ[chassis] ?? 0;
  /* Behind the car along its heading, eased so the camera trails through a turn. */
  const h = heading();
  chase.x += (cx - Math.sin(h) * 9 - chase.x) * 0.06;
  chase.y += (cy + 3.5 - chase.y) * 0.06;
  chase.z += (cz - Math.cos(h) * 9 - chase.z) * 0.06;
  camera.fovYDeg = 55;
  camera.far = 300;
  camera.position[0] = chase.x;
  camera.position[1] = chase.y;
  camera.position[2] = chase.z;
  camera.lookAt(cx, cy + 0.8, cz);

  const drawAll = (draw: (mesh: MeshHandle, matrix: Float32Array) => void): void => {
    draw(ground, IDENTITY);
    draw(cone, IDENTITY);
    draw(ramp, rampModel);
    draw(body, chassisMatrix());
    for (let i = 0; i < WHEELS.length; i += 1) draw(wheel, wheelMatrix(i));
  };
  env.shadowDepthSpan = computeLightMatrix(
    env.directionalDir,
    cx,
    cy,
    cz,
    16,
    renderer.shadowMapSize,
    lightMatrix,
  );
  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters((sink) => drawAll((mesh, matrix) => sink.mesh(mesh, matrix)));
  renderer.endShadowPass();
  renderer.beginFrame(SKY);
  renderer.bindMeshPass(camera, env);
  drawAll((mesh, matrix) => renderer.drawMesh(mesh, matrix));
  const vx = world.bodies.velX[chassis] ?? 0;
  const vz = world.bodies.velZ[chassis] ?? 0;
  const onGround = car.grounded.reduce((sum, g) => sum + g, 0);
  readout.set(
    0,
    `${Math.round(Math.hypot(vx, vz) * 3.6)} KM/H  ${onGround} WHEELS DOWN  ${playing ? 'YOURS' : 'DRIVING ITSELF'}`,
  );
  readout.draw(time);
  renderer.endFrame();
}
