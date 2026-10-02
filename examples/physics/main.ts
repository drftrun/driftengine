/**
 * A wall of crates, a ramp with wheels, capsules, balls and a rock rolling down it, and a cannon
 * firing at the wall every two and a half seconds.
 *
 * Every body is a rigid body in one `PhysicsWorld`, stepped on the fixed clock. The cannon is a
 * DriftScript module that moves and fires one pooled ball through `drift/physics`, choosing its
 * aim from the shot's number, so the same ticks fire the same shots. The readout's fingerprint is
 * the world's state as one number: a replay of the same ticks reaches the same one.
 *
 * The wall is stacked again every fifteen seconds. The switches are the world's options, so
 * changing one builds the world again from the start.
 */
import { MeshBuilder, computeLightMatrix, createEnvironment } from '@driftengine/core';
import type { MeshData, MeshHandle, Vec3 } from '@driftengine/core';
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  PhysicsWorld,
  boxShape,
  capsuleShape,
  cylinderShape,
  fingerprintBodies,
  hullShape,
  sphereShape,
} from '@driftengine/physics';
import type { FrictionModel } from '@driftengine/physics';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as cannonScript from './cannon.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

/** Each body, the mesh it is drawn with. */
const drawnAs: MeshHandle[] = [];
const mesh = (builder: MeshBuilder): MeshHandle => renderer.createMesh(builder.build());
const CRATE = mesh(new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [0.72, 0.55, 0.36]));
const WHEEL = mesh(
  new MeshBuilder().addCylinder([0, 0, 0], 0.6, 0.2, 'y', [0.2, 0.2, 0.22], 0, 24),
);
const PILL = mesh(new MeshBuilder().addCapsule([0, 0, 0], 0.3, 0.4, [0.3, 0.55, 0.85]));
const BALL = mesh(new MeshBuilder().addSphere([0, 0, 0], 0.45, [0.85, 0.3, 0.25], 0, 20, 10));
const SHOT = mesh(new MeshBuilder().addSphere([0, 0, 0], 0.35, [0.15, 0.15, 0.16], 0, 20, 10));
/** A rock: four points, and the hull through them, drawn face by face from the same points. */
const ROCK_POINTS = [0.6, -0.25, 0, -0.4, -0.25, 0.5, -0.3, -0.25, -0.5, 0, 0.45, 0];
const ROCK = renderer.createMesh(tetrahedron(ROCK_POINTS, [0.5, 0.48, 0.45]));

function tetrahedron(points: readonly number[], colour: Vec3): MeshData {
  const corner = (i: number): Vec3 => [
    points[i * 3] ?? 0,
    points[i * 3 + 1] ?? 0,
    points[i * 3 + 2] ?? 0,
  ];
  const faces = [
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [2, 0, 3],
  ];
  const positions = new Float32Array(36);
  const normals = new Float32Array(36);
  faces.forEach((face, f) => {
    const [a, b, c] = face.map(corner) as [Vec3, Vec3, Vec3];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
    [a, b, c].forEach((p, k) => {
      positions.set(p, (f * 3 + k) * 3);
      normals.set(
        n.map((x) => x / length),
        (f * 3 + k) * 3,
      );
    });
  });
  return {
    positions,
    normals,
    colors: new Float32Array(36).map((_, i) => colour[i % 3] ?? 1),
    emissive: new Float32Array(12),
    indices: Uint32Array.from({ length: 12 }, (_, i) => i),
  };
}

// #region world
/** The ground, a ramp, a wall of crates and things to roll down the ramp. */
let world = new PhysicsWorld();
let ball = 0;

function build(friction: FrictionModel, substeps: number): void {
  world = new PhysicsWorld({ frictionModel: friction, substeps });
  drawnAs.length = 0;
  world.addBody({ type: BODY_STATIC, shape: boxShape(30, 0.5, 30), y: -0.5, friction: 0.8 });
  /* A ramp turned twenty degrees about z, falling toward the wall. */
  const half = (20 * Math.PI) / 360;
  world.addBody({
    type: BODY_STATIC,
    shape: boxShape(5, 0.25, 2.5),
    x: 9,
    y: 1.6,
    qz: Math.sin(half),
    qw: Math.cos(half),
  });

  const body = (desc: Parameters<PhysicsWorld['addBody']>[0], drawn: MeshHandle): number => {
    const index = world.addBody(desc);
    drawnAs[index] = drawn;
    return index;
  };
  /* The wall: six crates along the bottom, one fewer each row up. */
  for (let row = 0; row < 6; row += 1) {
    for (let i = 0; i < 6 - row; i += 1) {
      body(
        {
          type: BODY_DYNAMIC,
          shape: boxShape(0.5, 0.5, 0.5),
          x: 0,
          y: 0.5 + row,
          z: i - (5 - row) / 2,
          friction: 0.6,
          density: 120,
        },
        CRATE,
      );
    }
  }
  /* Down the ramp: wheels standing on their rims, capsules lying across it, balls and a rock. */
  const quarter = Math.SQRT1_2;
  for (let i = 0; i < 3; i += 1) {
    body(
      {
        type: BODY_DYNAMIC,
        shape: cylinderShape(0.6, 0.2),
        x: 12,
        y: 4.2,
        z: i * 1.4 - 1.4,
        qx: quarter,
        qw: quarter,
      },
      WHEEL,
    );
  }
  body(
    {
      type: BODY_DYNAMIC,
      shape: capsuleShape(0.3, 0.4),
      x: 11,
      y: 4.2,
      z: 2,
      qx: quarter,
      qw: quarter,
    },
    PILL,
  );
  body(
    { type: BODY_DYNAMIC, shape: sphereShape(0.45), x: 13, y: 5, z: 0.6, restitution: 0.3 },
    BALL,
  );
  body({ type: BODY_DYNAMIC, shape: hullShape(ROCK_POINTS), x: 10.5, y: 4.4, z: -2 }, ROCK);
  /* The cannon's ball, parked out of the way until the script fires it. */
  ball = body(
    { type: BODY_DYNAMIC, shape: sphereShape(0.35), x: -14, y: 0.35, z: 0, density: 7800 },
    SHOT,
  );
}
// #endregion

let friction: FrictionModel = flag('friction', 'box') === 'elliptical' ? 'elliptical' : 'box';
let substeps = Number(flag('substeps', '4'));
build(friction, substeps);
let tick = 0;

controls([
  {
    key: 'friction',
    label: 'friction',
    value: friction,
    options: ['box', 'elliptical'].map((f) => ({ text: f, value: f })),
    change: (value) => {
      friction = value === 'elliptical' ? 'elliptical' : 'box';
      build(friction, substeps);
      tick = 0;
    },
  },
  {
    key: 'substeps',
    label: 'substeps',
    value: String(substeps),
    options: ['1', '4', '8'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      substeps = Number(value);
      build(friction, substeps);
      tick = 0;
    },
  },
]);

// #region script
/** The cannon, hosted, and called once a tick with the world it fires into. */
const cannon = hostScript(cannonScript);
type Fire = (world: PhysicsWorld, ball: number, tick: number) => boolean;
if (import.meta.hot) {
  import.meta.hot.accept('./cannon.drs', (next) => {
    if (next !== undefined) patchModule(cannon, next as Record<string, unknown>, {});
  });
}
// #endregion

// #region draw
/** A body's model matrix, from its position and the quaternion the world integrates. */
const model = new Float32Array(16);
function placed(body: number): Float32Array {
  const b = world.bodies;
  const x = b.rotX[body] ?? 0;
  const y = b.rotY[body] ?? 0;
  const z = b.rotZ[body] ?? 0;
  const w = b.rotW[body] ?? 1;
  model[0] = 1 - 2 * (y * y + z * z);
  model[1] = 2 * (x * y + z * w);
  model[2] = 2 * (x * z - y * w);
  model[4] = 2 * (x * y - z * w);
  model[5] = 1 - 2 * (x * x + z * z);
  model[6] = 2 * (y * z + x * w);
  model[8] = 2 * (x * z + y * w);
  model[9] = 2 * (y * z - x * w);
  model[10] = 1 - 2 * (x * x + y * y);
  model[12] = b.posX[body] ?? 0;
  model[13] = b.posY[body] ?? 0;
  model[14] = b.posZ[body] ?? 0;
  model[15] = 1;
  return model;
}
// #endregion

const ground = mesh(new MeshBuilder().addBox([0, -0.5, 0], [30, 0.5, 30], [0.36, 0.4, 0.32]));
const ramp = mesh(new MeshBuilder().addBox([0, 0, 0], [5, 0.25, 2.5], [0.55, 0.52, 0.48]));
const rampModel = new Float32Array(16);
const angle = (20 * Math.PI) / 180;
rampModel.set([
  Math.cos(angle),
  Math.sin(angle),
  0,
  0,
  -Math.sin(angle),
  Math.cos(angle),
  0,
  0,
  0,
  0,
  1,
  0,
  9,
  1.6,
  0,
  1,
]);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const env = createEnvironment({
  directionalDir: [-0.35, 0.75, 0.55],
  directionalColor: [1.8, 1.7, 1.55],
  ambient: [0.32, 0.35, 0.42],
  ambientGround: [0.14, 0.13, 0.12],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
const readout = createReadout(renderer, 2);
const SKY: Vec3 = [0.58, 0.64, 0.72];
let time = 0;

stage.run({
  simulate(dt) {
    time += dt;
    tick += 1;
    /* Every fifteen seconds the wall is stacked again. */
    if (tick % 900 === 0) build(friction, substeps);
    exported<Fire>(cannon, 'fire')(world, ball, tick);
    world.step(dt);
  },
  render() {
    camera.fovYDeg = 50;
    camera.position[0] = -13 + Math.sin(time * 0.1) * 3;
    camera.position[1] = 6;
    camera.position[2] = 11;
    camera.lookAt(2, 1.5, 0);
    env.shadowDepthSpan = computeShadow();
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => drawAll((mesh, matrix) => sink.mesh(mesh, matrix)));
    renderer.endShadowPass();
    renderer.beginFrame(SKY);
    renderer.bindMeshPass(camera, env);
    drawAll((mesh, matrix) => renderer.drawMesh(mesh, matrix));
    let awake = 0;
    for (let i = 0; i < world.bodies.count; i += 1) if (!world.sleeping(i)) awake += 1;
    readout.set(0, `TICK ${tick}  ${awake} OF ${world.bodies.count} BODIES AWAKE`);
    readout.set(1, `FINGERPRINT ${fingerprintBodies(world.bodies).slice(0, 12)}`);
    readout.draw(time);
    renderer.endFrame();
  },
});

function drawAll(draw: (mesh: MeshHandle, matrix: Float32Array) => void): void {
  draw(ground, IDENTITY);
  draw(ramp, rampModel);
  for (let body = 0; body < drawnAs.length; body += 1) {
    const drawn = drawnAs[body];
    if (drawn !== undefined) draw(drawn, placed(body));
  }
}

function computeShadow(): number {
  return computeLightMatrix(env.directionalDir, 2, 1, 0, 18, renderer.shadowMapSize, lightMatrix);
}
