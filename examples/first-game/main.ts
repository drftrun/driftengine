/**
 * A complete small 3D game: walk an arena, push crates out of the way, and gather every orb
 * before the clock runs out.
 *
 * The manual's "Your first game" chapter is built from this file, one region at a time. It uses
 * only what a consumer installs: `@driftengine/core` for the renderer, the loop, input and physics,
 * `@driftengine/audio` for one sound that is synthesised, so the game needs no asset at all, and
 * DriftScript for the round's rules, which live in `round.drs` and reload while the game runs.
 */
import { AudioGraph, toneBuffer } from '@driftengine/audio';
import {
  ActionMap,
  BODY_DYNAMIC,
  BODY_STATIC,
  Camera,
  CharacterController,
  DEFAULT_TEXT_STYLE,
  InputSource,
  MeshBuilder,
  PhysicsWorld,
  SceneNode,
  TouchControls,
  boxShape,
  computeLightMatrix,
  createEnvironment,
  createRenderer,
  damp,
  lerp,
  mulberry32,
  startLoop,
} from '@driftengine/core';
import type { ShadowCasters, Vec3 } from '@driftengine/core';
import { bindModule } from '@driftengine/script';
import { loadModule, patchModule } from 'driftscript';
import * as roundScript from './round.drs';

// #region rules
/** Half the arena's width, in metres. */
const ARENA = 12;
const ORB_COUNT = 8;
/** The same seed lays out the same rounds, in the same order, on every machine. */
const SEED = 2026;
// #endregion

// #region renderer
const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('the page must carry <canvas id="stage">');

const { renderer, backend } = await createRenderer(canvas, {
  maxDevicePixelRatio: 1.75,
  directionalShadows: true,
});

const readout = document.querySelector('#backend');
if (readout !== null) readout.textContent = backend;

renderer.resize();
addEventListener('resize', () => renderer.resize());
// #endregion

// #region environment
const SKY: Vec3 = [0.56, 0.68, 0.84];

const ENV = createEnvironment({
  directionalDir: [0.35, 0.8, 0.45],
  directionalColor: [1, 0.95, 0.86],
  ambient: [0.34, 0.38, 0.46],
  ambientGround: [0.14, 0.12, 0.1],
  // The emissive master switch. At 0 nothing glows, whatever emissiveGain says.
  nightFactor: 1,
  emissiveGain: 1.6,
  fogColor: SKY,
  fogDensity: 0.01,
  fogHeightFalloff: 0.06,
  fogBaseY: 0,
});
// #endregion

// #region level
const world = new PhysicsWorld({ substeps: 4 });
const level = new MeshBuilder();
const footprints: { x: number; z: number; hx: number; hz: number }[] = [];

/** One box, in the picture and in the physics from the same numbers, so the two cannot disagree. */
function solid(
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  color: Vec3,
): void {
  level.addBox([x, y, z], [hx, hy, hz], color);
  world.addBody({ type: BODY_STATIC, shape: boxShape(hx, hy, hz), x, y, z, friction: 0.8 });
  footprints.push({ x, z, hx, hz });
}

const GRASS: Vec3 = [0.4, 0.5, 0.36];
const WALL: Vec3 = [0.62, 0.6, 0.56];
const STONE: Vec3 = [0.5, 0.52, 0.58];

solid(0, -0.5, 0, ARENA, 0.5, ARENA, GRASS);
for (const side of [-1, 1]) {
  solid(side * (ARENA + 0.5), 0.75, 0, 0.5, 0.75, ARENA + 1, WALL);
  solid(0, 0.75, side * (ARENA + 0.5), ARENA, 0.75, 0.5, WALL);
}
// Two tiers, each low enough to jump onto, with an orb waiting on top.
solid(-6, 0.4, -6, 2.6, 0.4, 2.6, STONE);
solid(-6, 1.2, -6, 1.4, 0.4, 1.4, STONE);
solid(6, 1.5, -5, 0.6, 1.5, 0.6, STONE);
solid(5, 1.5, 6, 0.6, 1.5, 0.6, STONE);

const levelMesh = renderer.createMesh(level.build());
const PLATFORM_TOP = 1.6;
// #endregion

// #region crates
const CRATE = 0.5;
const crateMesh = renderer.createMesh(
  new MeshBuilder().addBox([0, 0, 0], [CRATE, CRATE, CRATE], [0.74, 0.52, 0.3]).build(),
);

const crates: number[] = [];
for (const [x, z] of [
  [2, -1],
  [3.1, -1.2],
  [2.5, 0.1],
  [-3, 5],
]) {
  crates.push(
    world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(CRATE, CRATE, CRATE),
      x,
      y: CRATE,
      z,
      friction: 0.6,
    }),
  );
}

/** Position and rotation per crate, before and after the last step, for drawing between them. */
const crateBefore = new Float32Array(crates.length * 7);
const crateAfter = new Float32Array(crates.length * 7);

function recordCrates(out: Float32Array): void {
  const b = world.bodies;
  for (let i = 0; i < crates.length; i += 1) {
    const body = crates[i];
    const o = i * 7;
    out[o] = b.posX[body];
    out[o + 1] = b.posY[body];
    out[o + 2] = b.posZ[body];
    out[o + 3] = b.rotX[body];
    out[o + 4] = b.rotY[body];
    out[o + 5] = b.rotZ[body];
    out[o + 6] = b.rotW[body];
  }
}
// #endregion

// #region player
const player = new CharacterController({ maxSpeed: 7, jumpSpeed: 7, pushStrength: 2 });
const START: Vec3 = [0, 1.2, 7];

const playerMesh = renderer.createMesh(
  new MeshBuilder()
    .addCapsule([0, 0, 0], player.radius, player.halfHeight, [0.92, 0.88, 0.82])
    .build(),
);

/** Where the player was before the last step, for the same reason the crates keep one. */
const playerBefore = { x: 0, y: 0, z: 0 };
// #endregion

// #region orbs
interface Orb {
  x: number;
  y: number;
  z: number;
  taken: boolean;
}

const random = mulberry32(SEED);
const orbs: Orb[] = [];
const orbMesh = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.32, [1, 0.78, 0.36], 1).build(),
);

function blocked(x: number, z: number): boolean {
  return footprints.some(
    (f) => f.hx < ARENA && Math.abs(x - f.x) < f.hx + 0.8 && Math.abs(z - f.z) < f.hz + 0.8,
  );
}

/** Lay out a round. Called between rounds, never per frame, so building the list is fine here. */
function scatter(): void {
  orbs.length = 0;
  while (orbs.length < ORB_COUNT - 1) {
    const x = (random() * 2 - 1) * (ARENA - 1.5);
    const z = (random() * 2 - 1) * (ARENA - 1.5);
    if (!blocked(x, z)) orbs.push({ x, y: 0.9, z, taken: false });
  }
  orbs.push({ x: -6, y: PLATFORM_TOP + 0.9, z: -6, taken: false });
}
// #endregion

// #region input
const input = new InputSource(canvas, ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const actions = new ActionMap(input, {
  move: {
    stick: 'left',
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  jump: { keys: ['Space'], buttons: ['faceDown'] },
  restart: { keys: ['KeyR', 'Enter'], buttons: ['start'] },
  pause: { keys: ['KeyP', 'Escape'], buttons: ['select'] },
});

/** A thumb stick on the left of a touch screen, and a tap or hold on the right. */
const touch = new TouchControls(input);
const move = { x: 0, y: 0 };
// #endregion

// #region sound
// A browser lets a page make sound only after a gesture, so the graph is made on the first press.
let sound: AudioGraph | null = null;
let soundAsked = false;
async function startSound(): Promise<void> {
  if (soundAsked) return;
  soundAsked = true;
  const graph = await AudioGraph.create({ stemCount: 0 });
  if (graph === null) return;
  graph.registry.register('orb', {
    urls: [],
    synth: (ctx) => toneBuffer(ctx, 0.2, 660, 1320, 3),
  });
  sound = graph;
  await graph.registry.load(graph.context);
}
addEventListener('pointerdown', () => void startSound());
addEventListener('keydown', () => void startSound());

function chime(): void {
  sound?.play(sound.registry.get('orb'), 0.45);
}
// #endregion

// #region script
/*
 * The round's rules are a DriftScript module. Loading it builds the module, binding it hands it
 * the engine capabilities it imports, which here is none, and `createRound` makes the record it
 * keeps the round in. The page owns that record and passes it to every rule.
 */
const roundModule = loadModule(roundScript as Record<string, unknown>);
const bound = bindModule(roundModule, {});
if (!bound.bound) throw new Error(bound.reason);

/* A variant reaches the page as its tag: `round.phase.tag` is `'Playing'`, `'Won'` or `'Lost'`. */
interface Round {
  remaining: number;
  gathered: number;
  total: number;
  phase: { tag: 'Playing' | 'Won' | 'Lost' };
}
/* Read through the module each call, so a rule patched by a save is the rule that runs. */
const rules = roundModule.exports as unknown as {
  createRound(): Round;
  start(round: Round, total: number): void;
  reaches(dx: number, dy: number, dz: number): boolean;
  gather(round: Round): void;
  tick(round: Round, dt: number): void;
};
const round = rules.createRound();

/* Saving `round.drs` replaces its functions and keeps `round` as it was: the clock carries on. */
if (import.meta.hot) {
  import.meta.hot.accept('./round.drs', (next) => {
    if (next !== undefined)
      patchModule(roundModule, next as Record<string, unknown>, { Round: [round] });
  });
}
// #endregion

// #region round
let paused = false;

function newRound(): void {
  scatter();
  rules.start(round, orbs.length);
  player.teleport(START[0], START[1], START[2]);
  playerBefore.x = player.x;
  playerBefore.y = player.y;
  playerBefore.z = player.z;
}
// #endregion

// #region simulate
function simulate(dt: number): void {
  if (round.phase.tag !== 'Playing') {
    if (actions.consumePress('restart') || touch.consumePrimaryPress()) newRound();
    return;
  }

  // Keys and the pad follow the stick convention, where up is negative. The touch stick reports
  // up as positive, so it is flipped here, once.
  actions.vector('move', move);
  if (touch.moveX !== 0 || touch.moveY !== 0) {
    move.x = touch.moveX;
    move.y = -touch.moveY;
  }

  playerBefore.x = player.x;
  playerBefore.y = player.y;
  playerBefore.z = player.z;
  player.move(world, dt, {
    moveX: move.x * player.maxSpeed,
    moveZ: move.y * player.maxSpeed,
    jump: actions.down('jump') || touch.primaryHeld,
  });

  recordCrates(crateBefore);
  world.step(dt);
  recordCrates(crateAfter);

  for (let i = 0; i < orbs.length; i += 1) {
    const orb = orbs[i];
    if (orb.taken) continue;
    const dx = orb.x - player.x;
    const dy = orb.y - player.y;
    const dz = orb.z - player.z;
    if (rules.reaches(dx, dy, dz)) {
      orb.taken = true;
      rules.gather(round);
      chime();
    }
  }

  if (player.y < -10) player.teleport(START[0], START[1], START[2]);

  rules.tick(round, dt);
}
// #endregion

// #region camera
const camera = new Camera();
camera.fovYDeg = 55;
const eye = { x: START[0], y: START[1] + 6, z: START[2] + 9 };

/** Ease toward a spot behind and above the player. Presentation only, so it runs on frame time. */
function follow(x: number, y: number, z: number, frameDt: number): void {
  eye.x = damp(eye.x, x, 5, frameDt);
  eye.y = damp(eye.y, y + 6, 5, frameDt);
  eye.z = damp(eye.z, z + 9, 5, frameDt);
  camera.position[0] = eye.x;
  camera.position[1] = eye.y;
  camera.position[2] = eye.z;
  camera.lookAt(x, y + 0.6, z);
  camera.updateMatrices(renderer.cssHeight > 0 ? renderer.cssWidth / renderer.cssHeight : 1);
}
// #endregion

// #region transforms
/** One node per thing that moves, built once, so a frame writes matrices and allocates nothing. */
const still = new SceneNode();
still.updateWorld();
const playerNode = new SceneNode();
const crateNodes = crates.map(() => new SceneNode());
const orbNodes = Array.from({ length: ORB_COUNT }, () => new SceneNode());
let clock = 0;

function placeEverything(alpha: number): void {
  playerNode.setPosition(
    lerp(playerBefore.x, player.x, alpha),
    lerp(playerBefore.y, player.y, alpha),
    lerp(playerBefore.z, player.z, alpha),
  );
  playerNode.updateWorld();

  for (let i = 0; i < crates.length; i += 1) placeCrate(crateNodes[i], i, alpha);

  for (let i = 0; i < orbs.length; i += 1) {
    const orb = orbs[i];
    orbNodes[i].setPosition(orb.x, orb.y + Math.sin(clock * 2.4 + i) * 0.12, orb.z);
    orbNodes[i].setRotationAxisAngle(0, 1, 0, clock * 1.5 + i);
    orbNodes[i].updateWorld();
  }
}

/** Position by lerp and rotation by normalised lerp. A step turns a crate very little, so that is enough. */
function placeCrate(node: SceneNode, i: number, alpha: number): void {
  const a = crateBefore;
  const b = crateAfter;
  const o = i * 7;
  // q and -q are the same rotation; flip one so the blend goes the short way round.
  const dot = a[o + 3] * b[o + 3] + a[o + 4] * b[o + 4] + a[o + 5] * b[o + 5] + a[o + 6] * b[o + 6];
  const sign = dot < 0 ? -1 : 1;
  const r = node.rotation;
  for (let k = 0; k < 4; k += 1) r[k] = lerp(a[o + 3 + k] * sign, b[o + 3 + k], alpha);
  const length = Math.hypot(r[0], r[1], r[2], r[3]);
  for (let k = 0; k < 4; k += 1) r[k] /= length;
  node.position[0] = lerp(a[o], b[o], alpha);
  node.position[1] = lerp(a[o + 1], b[o + 1], alpha);
  node.position[2] = lerp(a[o + 2], b[o + 2], alpha);
  node.markMoved();
  node.updateWorld();
}
// #endregion

// #region casters
/**
 * Everything in the world, said once. The shadow pass and the colour pass both draw from this,
 * so nothing can cast a shadow without being seen, or be seen without casting one.
 */
const casters: ShadowCasters = (sink) => {
  sink.mesh(levelMesh, still.worldMatrix);
  sink.mesh(playerMesh, playerNode.worldMatrix);
  for (let i = 0; i < crateNodes.length; i += 1) sink.mesh(crateMesh, crateNodes[i].worldMatrix);
  for (let i = 0; i < orbs.length; i += 1) {
    if (!orbs[i].taken) sink.mesh(orbMesh, orbNodes[i].worldMatrix);
  }
};

const lightMatrix = new Float32Array(16);
ENV.lightViewProj = lightMatrix;
ENV.shadowStrength = 0.8;
// #endregion

// #region render
function render(alpha: number, frameDt: number): void {
  // Input is sampled here, at the edge of the simulation: a step reads what this left behind.
  touch.tick(performance.now());
  // #region pause
  // Read here, not in simulate: while paused, simulate is not called at all.
  if (actions.consumePress('pause')) paused = !paused;
  // #endregion
  if (!paused) clock += frameDt;
  placeEverything(alpha);
  const at = playerNode.position;
  follow(at[0], at[1], at[2], frameDt);

  // The shadow map covers 16 metres around the player, which is everything the camera sees.
  ENV.shadowDepthSpan = computeLightMatrix(
    ENV.directionalDir,
    at[0],
    at[1],
    at[2],
    16,
    renderer.shadowMapSize,
    lightMatrix,
  );
  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters(casters);
  renderer.endShadowPass();

  renderer.beginFrame(SKY);
  renderer.bindMeshPass(camera, ENV);
  renderer.drawSceneCasters(casters);
  drawHud();
  renderer.endFrame();
}
// #endregion

// #region hud
const hud = renderer.createText();
let hudStyle: typeof DEFAULT_TEXT_STYLE = {
  ...DEFAULT_TEXT_STYLE,
  color: [1, 0.98, 0.92],
  glow: 0.7,
};
/** What the text last said, so a new string is built only when a number on it changes. */
const shown = { gathered: -1, seconds: -1, phase: '', paused: false };

function drawHud(): void {
  const seconds = Math.ceil(round.remaining);
  if (
    round.gathered !== shown.gathered ||
    seconds !== shown.seconds ||
    round.phase.tag !== shown.phase ||
    paused !== shown.paused
  ) {
    shown.gathered = round.gathered;
    shown.seconds = seconds;
    shown.phase = round.phase.tag;
    shown.paused = paused;
    renderer.setText(
      hud,
      paused
        ? 'PAUSED. PRESS P TO CARRY ON'
        : round.phase.tag === 'Won'
          ? 'ALL GATHERED. PRESS R OR TAP TO PLAY AGAIN'
          : round.phase.tag === 'Lost'
            ? 'OUT OF TIME. PRESS R OR TAP TO PLAY AGAIN'
            : `ORBS ${round.gathered}/${round.total}   TIME ${seconds}`,
    );
  }

  const width = renderer.cssWidth;
  const height = renderer.cssHeight;
  // The style is rebuilt only when a resize moves the cell size.
  const cell = Math.max(2, Math.round(Math.min(width, height) / 220));
  if (cell !== hudStyle.cellSize) hudStyle = { ...hudStyle, cellSize: cell };
  renderer.drawText(
    hud,
    width,
    height,
    Math.round(width / 2 - renderer.textWidth(hud, cell) / 2),
    Math.round(height * 0.08) + cell * 7,
    hudStyle,
    0,
  );
}
// #endregion

// #region loop
newRound();
startLoop({ simulate, render, shouldSimulate: () => !paused });
// #endregion
