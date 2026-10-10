/**
 * A character to walk about a valley: across a bridge or down under it, up a flight of steps, off
 * a slab too steep to stand on, into a pond, and into crates that move when pushed.
 *
 * The character is a `CharacterController`, a kinematic capsule swept through the physics world.
 * It stands on the bodies, the steps, the slab, the crates and the bridge's piers, and on a ground
 * surface beside them: the valley's heightfield, and the bridge deck as a second field that is only
 * there over its span, so the deck and the path beneath it are both a floor. The controls are a
 * DriftScript module reading the input actions.
 *
 * WASD or the arrows walk, Space jumps, Q and E turn the camera. Until a key is pressed, the
 * character walks a circuit of its own.
 */
import {
  ActionMap,
  InputSource,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  heightSurface,
  srgbColor,
} from '@driftengine/core';
import type { MeshHandle, WaterBody } from '@driftengine/core';
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  CharacterController,
  PhysicsWorld,
  applyBuoyancy,
  boxShape,
  createBuoyancy,
} from '@driftengine/physics';
import type { ControllerOptions } from '@driftengine/physics';
import { Terrain, heightfieldPatch } from '@driftengine/terrain';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as controlsScript from './controls.drs';

const stage = await openStage({
  water: true,
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera, canvas } = stage;

// #region ground
/** A valley along z, a pond dug into its west bank, and a bridge deck across it at z = 0. */
const smooth = (t: number): number => t * t * (3 - 2 * t);
function valley(x: number, z: number): number {
  const bank = 2.6 * smooth(Math.min(1, Math.max(0, (Math.abs(x) - 1.5) / 4.5)));
  const pond = 1.6 * Math.max(0, 1 - Math.hypot(x + 12, z - 9) / 4);
  return bank - pond;
}
const SIDE = 81;
const terrain = new Terrain({
  width: SIDE,
  depth: SIDE,
  spacingM: 0.5,
  heights: Float32Array.from({ length: SIDE * SIDE }, (_, i) =>
    valley((i % SIDE) * 0.5 - 20, Math.floor(i / SIDE) * 0.5 - 20),
  ),
  origin: [-20, 0, -20],
});
/* Level with the banks where it meets them: a body walks from one field onto the other only where
   the two are at one height. */
const DECK_Y = 2.6;
const deck = (x: number, z: number): number =>
  Math.abs(x) < 6.5 && Math.abs(z) < 1.5 ? DECK_Y : Number.NaN;

/** Two fields: whichever is nearer the height a body is at is the floor it stands on. */
const ground = heightSurface([(x, z) => terrain.heightAt(x, z), deck]);
// #endregion

// #region bodies
/** What the character collides with as bodies: the piers, a flight of steps, a slab and crates. */
const world = new PhysicsWorld();
const solid: {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  qz?: number;
}[] = [
  { x: -2, y: 1.2, z: 0, hx: 0.4, hy: 1.2, hz: 1.2 },
  { x: 2, y: 1.2, z: 0, hx: 0.4, hy: 1.2, hz: 1.2 },
];
for (let step = 0; step < 8; step += 1) {
  solid.push({
    x: 10 + step * 0.6,
    y: 2.6 + (step + 1) * 0.125,
    z: -8,
    hx: 0.3,
    hy: (step + 1) * 0.125,
    hz: 1.2,
  });
}
solid.push({ x: 16, y: 3.6, z: -8, hx: 1.5, hy: 1, hz: 2 });
for (const box of solid) {
  world.addBody({
    type: BODY_STATIC,
    shape: boxShape(box.hx, box.hy, box.hz),
    x: box.x,
    y: box.y,
    z: box.z,
  });
}
/* A slab falling fifty degrees from the platform's edge toward +z: too steep to stand on, so a
   character who walks off the platform onto it slides down to the bank. */
const tilt = (50 * Math.PI) / 360;
world.addBody({
  type: BODY_STATIC,
  shape: boxShape(1.4, 0.15, 1.3),
  x: 16,
  y: 3.6,
  z: -5.15,
  qx: Math.sin(tilt),
  qw: Math.cos(tilt),
});
const crates: number[] = [];
for (let i = 0; i < 4; i += 1) {
  crates.push(
    world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.4, 0.4, 0.4),
      x: -9 + i * 1.1,
      y: 3.1,
      z: -6,
      density: 150,
    }),
  );
}
// #endregion

// #region controller
/** Two feels for one character: quick to turn and short in the air, or slow to stop and floaty. */
const FEELS: Record<string, ControllerOptions> = {
  snappy: { acceleration: 60, deceleration: 50, airControl: 0.4, jumpSpeed: 7, gravity: -24 },
  floaty: { acceleration: 12, deceleration: 6, airControl: 0.8, jumpSpeed: 6, gravity: -11 },
};
let feel = flag('feel', 'snappy');
let player = new CharacterController({
  ...FEELS[feel],
  coyoteTicks: 6,
  jumpBufferTicks: 6,
  ground,
});
player.teleport(-8, 4, 4);
// #endregion

// #region water
/** The pond: falling in costs speed on every axis, and a drop settles instead of sinking fast. */
const POND = { x: -12, z: 9, half: 3.4, level: 1.8 };
const sea = createBuoyancy({ level: POND.level, drag: 3, sinkSpeed: -1.2 });
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
  turn: { stick: 'right', up: [], down: [], left: ['KeyQ'], right: ['KeyE'] },
  jump: { keys: ['Space'], buttons: ['faceDown'] },
});

// #region script
/** The controls, hosted, and the wish they fill each tick. */
const controlsModule = hostScript(controlsScript);
interface Wish {
  x: number;
  z: number;
  jump: boolean;
}
const wish = exported<() => Wish>(controlsModule, 'createWish')();
type Steer = (wish: Wish, actions: ActionMap, yaw: number, speed: number) => void;
type Seek = (
  wish: Wish,
  fx: number,
  fz: number,
  tx: number,
  tz: number,
  speed: number,
  jump: boolean,
) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./controls.drs', (next) => {
    if (next !== undefined)
      patchModule(controlsModule, next as Record<string, unknown>, { Wish: [wish] });
  });
}
// #endregion

controls([
  {
    key: 'feel',
    label: 'feel',
    value: feel,
    options: ['snappy', 'floaty'].map((f) => ({ text: f, value: f })),
    change: (value) => {
      feel = value;
      /* The feel is the controller's options, so a new controller takes over where the old one stood. */
      const { x, y, z } = player;
      player = new CharacterController({
        ...FEELS[feel],
        coyoteTicks: 6,
        jumpBufferTicks: 6,
        ground,
      });
      player.teleport(x, y, z);
    },
  },
]);

/** The circuit the character walks until somebody takes the keys: across, down, under and back. */
const CIRCUIT: [number, number, boolean][] = [
  [-8, 0, false],
  [8, 0, false],
  [8.6, -8, false],
  [15.5, -8, false],
  [16, -2, false],
  [8, -3, false],
  [0, -5, false],
  [0, 6, false],
  [-10, 8, false],
  [-8, 3, true],
];
let leg = 0;
let playing = false;
const turn = { x: 0, y: 0 };
let yaw = 0.6;

let time = 0;
stage.run({
  simulate(dt) {
    time += dt;
    actions.vector('turn', turn);
    yaw -= turn.x * dt * 1.8;
    if (actions.down('jump') || actions.axis('move', 'x') !== 0 || actions.axis('move', 'y') !== 0)
      playing = true;
    if (playing) {
      exported<Steer>(controlsModule, 'steer')(wish, actions, yaw, player.maxSpeed);
    } else {
      const [tx, tz, jump] = CIRCUIT[leg] ?? [0, 0, false];
      exported<Seek>(controlsModule, 'seek')(
        wish,
        player.x,
        player.z,
        tx,
        tz,
        player.maxSpeed * 0.8,
        jump,
      );
      if (Math.hypot(tx - player.x, tz - player.z) < 0.8) leg = (leg + 1) % CIRCUIT.length;
    }
    player.move(world, dt, { moveX: wish.x, moveZ: wish.z, jump: wish.jump });
    if (Math.abs(player.x - POND.x) < POND.half && Math.abs(player.z - POND.z) < POND.half)
      applyBuoyancy(sea, player.y, player, dt);
    world.step(dt);
  },
  render: drawFrame,
});

const terrainMesh = renderer.createMesh(
  heightfieldPatch(terrain, { x: 0, z: 0, cells: SIDE - 1, color: [0.34, 0.46, 0.27] }),
);
const deckMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, DECK_Y - 0.1, 0], [6.5, 0.1, 1.5], [0.6, 0.56, 0.5]).build(),
);
const solidMesh = renderer.createMesh(
  solid
    .reduce(
      (builder, box) =>
        builder.addBox([box.x, box.y, box.z], [box.hx, box.hy, box.hz], [0.62, 0.6, 0.57]),
      new MeshBuilder(),
    )
    .build(),
);
const slabMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [1.4, 0.15, 1.3], [0.5, 0.45, 0.42]).build(),
);
/* The same fifty degrees about x, as the matrix's three columns and its position. */
const angle = (50 * Math.PI) / 180;
const slabModel = Float32Array.of(
  ...[1, 0, 0, 0],
  ...[0, Math.cos(angle), Math.sin(angle), 0],
  ...[0, -Math.sin(angle), Math.cos(angle), 0],
  ...[16, 3.6, -5.15, 1],
);
const crateMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [0.4, 0.4, 0.4], [0.72, 0.55, 0.36]).build(),
);
const body = renderer.createMesh(
  new MeshBuilder()
    .addCapsule([0, 0, 0], player.radius, player.halfHeight, [0.95, 0.5, 0.2])
    .build(),
);
const pond = renderer.createWater();
const pondBody: WaterBody = {
  level: POND.level,
  deepColor: srgbColor(0.05, 0.12, 0.14),
  shallowColor: srgbColor(0.15, 0.3, 0.3),
  density: 0.6,
  waveScale: 0.1,
  bounds: { centreX: POND.x, centreZ: POND.z, halfM: POND.half },
};

const SKY = srgbColor(0.62, 0.7, 0.8);
const env = createEnvironment({
  directionalDir: [-0.4, 0.7, 0.45],
  directionalColor: [1.8, 1.7, 1.5],
  ambient: [0.32, 0.36, 0.44],
  ambientGround: [0.14, 0.13, 0.12],
  fogColor: SKY,
  fogDensity: 0.01,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const model = new Float32Array(IDENTITY);
const readout = createReadout(renderer, 1);
const STATES = ['STANDING', 'IN THE AIR', 'SLIDING'];
const focus = { x: player.x, y: player.y, z: player.z };

function drawAll(draw: (mesh: MeshHandle, matrix: Float32Array) => void): void {
  draw(terrainMesh, IDENTITY);
  draw(deckMesh, IDENTITY);
  draw(solidMesh, IDENTITY);
  draw(slabMesh, slabModel);
  for (const crate of crates) {
    const b = world.bodies;
    const x = b.rotX[crate] ?? 0;
    const y = b.rotY[crate] ?? 0;
    const z = b.rotZ[crate] ?? 0;
    const w = b.rotW[crate] ?? 1;
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
      b.posX[crate] ?? 0,
      b.posY[crate] ?? 0,
      b.posZ[crate] ?? 0,
      1,
    ]);
    draw(crateMesh, model);
  }
  model.set(IDENTITY);
  model[12] = player.x;
  model[13] = player.y;
  model[14] = player.z;
  draw(body, model);
}

function drawFrame(): void {
  /* The camera follows behind and above, easing so a jump does not jerk it. */
  focus.x += (player.x - focus.x) * 0.1;
  focus.y += (player.y - focus.y) * 0.1;
  focus.z += (player.z - focus.z) * 0.1;
  camera.fovYDeg = 55;
  camera.position[0] = focus.x + Math.sin(yaw) * 9;
  camera.position[1] = focus.y + 5;
  camera.position[2] = focus.z + Math.cos(yaw) * 9;
  camera.lookAt(focus.x, focus.y + 0.8, focus.z);

  env.shadowDepthSpan = computeLightMatrix(
    env.directionalDir,
    focus.x,
    focus.y,
    focus.z,
    18,
    renderer.shadowMapSize,
    lightMatrix,
  );
  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters((sink) => drawAll((mesh, matrix) => sink.mesh(mesh, matrix)));
  renderer.endShadowPass();
  renderer.beginFrame(SKY);
  renderer.bindMeshPass(camera, env);
  drawAll((mesh, matrix) => renderer.drawMesh(mesh, matrix));
  renderer.drawSky(
    camera,
    {
      top: srgbColor(0.25, 0.42, 0.72),
      horizon: SKY,
      deep: srgbColor(0.3, 0.34, 0.4),
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
    },
    env,
  );
  renderer.drawWater(pond, camera, time, pondBody, env, 0.5, 0.3);
  readout.set(0, `${STATES[player.state] ?? ''}  ${playing ? 'YOURS' : 'WALKING ITSELF'}`);
  readout.draw(time);
  renderer.endFrame();
}
