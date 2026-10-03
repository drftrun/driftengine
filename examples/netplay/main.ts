/**
 * Two players, one match, over a link this page makes worse on purpose.
 *
 * Both peers run in this page: the left pitch is your screen, where you steer cyan, and the right
 * pitch is the other player's, where a bot steers magenta. Each peer has its own world and its own
 * session, and they share nothing but the messages they send each other over a loopback network the
 * strip slows down and loses packets on. Every tick each peer predicts what the other is holding,
 * and when the real input arrives and the guess was wrong it rewinds and replays. `pitch.drs` holds
 * the rules both peers run.
 */
import {
  ActionMap,
  InputSource,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
} from '@driftengine/core';
import type { MeshHandle, Vec3 } from '@driftengine/core';
import { World, buildSchedule, runSchedule } from '@driftengine/entities';
import type { ComponentType, Entity, Schedule, WorldSnapshot } from '@driftengine/entities';
import {
  InputLog,
  LockstepSession,
  LoopbackNetwork,
  RewindLoop,
  worldSnapshotter,
} from '@driftengine/network';
import type { Impairment } from '@driftengine/network';
import { bindModule, registerEntityModule } from '@driftengine/script';
import type { ComponentRegistry } from '@driftengine/script';
import { loadModule, patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';
import * as pitchScript from './pitch.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera, canvas } = stage;

// #region script
/* The rules, registered once: their components become stores both worlds use, and their systems
   one schedule both peers step. A save rebuilds the schedule and keeps every store. */
const pitch = loadModule(pitchScript as Record<string, unknown>);
const registry: ComponentRegistry = new Map();
let schedule: Schedule = buildSchedule(registerEntityModule(pitch, registry).systems);
const bound = bindModule(pitch, { entities: { components: registry, prefabs: new Map() } });
if (!bound.bound) throw new Error(bound.reason);
if (import.meta.hot) {
  import.meta.hot.accept('./pitch.drs', (next) => {
    if (next === undefined) return;
    patchModule(pitch, next as Record<string, unknown>);
    schedule = buildSchedule(registerEntityModule(pitch, registry).systems);
  });
}

function component(name: string): ComponentType {
  const type = registry.get(name);
  if (type === undefined) throw new Error(`pitch.drs declares no ${name}`);
  return type;
}
const Pilot = component('Pilot');
const Craft = component('Craft');
const Ball = component('Ball');
const Score = component('Score');
// #endregion

// #region input
/* An input is bytes the game chooses. This one is a single byte, a bit for each of four keys. */
const LEFT = 1;
const RIGHT = 2;
const UP = 4;
const DOWN = 8;

function decode(bits: number): { x: number; z: number } {
  return {
    x: (bits & RIGHT ? 1 : 0) - (bits & LEFT ? 1 : 0),
    z: (bits & DOWN ? 1 : 0) - (bits & UP ? 1 : 0),
  };
}
// #endregion

// #region peer
/* One peer: its own world, the inputs every participant sent it, and a rewind loop that can put
   the world back to any of the last `depth` ticks and step it forward again. */
const FIXED_DT = 1 / 60;
const PARTICIPANTS = 2;

interface Peer {
  readonly world: World;
  readonly crafts: readonly Entity[];
  readonly ball: Entity;
  readonly score: Entity;
  readonly inputs: InputLog;
  readonly loop: RewindLoop<WorldSnapshot>;
}

function makePeer(): Peer {
  const world = new World();
  const crafts = [world.create(), world.create()];
  world.add(crafts[0] as Entity, Craft, { z: 3 });
  world.add(crafts[1] as Entity, Craft, { z: -3 });
  for (const craft of crafts) world.add(craft, Pilot, {});
  const ball = world.create();
  world.add(ball, Ball, {});
  const score = world.create();
  world.add(score, Score, {});

  const inputs = new InputLog({ participants: PARTICIPANTS, depth: 64, inputBytes: 1 });
  const held = new Uint8Array(1);
  /* One tick: each participant's input for it, from the log, into its pilot, then the rules. A
     rewind calls this again for every tick it replays, with the inputs it now knows. */
  const step = (_dt: number, tick: number): void => {
    for (let participant = 0; participant < PARTICIPANTS; participant += 1) {
      inputs.into(participant, tick, held);
      const { x, z } = decode(held[0] ?? 0);
      const pilot = crafts[participant] as Entity;
      world.write(pilot, Pilot, 'x', x);
      world.write(pilot, Pilot, 'z', z);
    }
    runSchedule(world, schedule, tick);
  };
  const loop = new RewindLoop({
    step,
    snapshotter: worldSnapshotter(world),
    inputs,
    fixedDt: FIXED_DT,
    depth: 24,
  });
  return { world, crafts, ball, score, inputs, loop };
}
// #endregion

// #region link
/* The link both peers share. Everything about it is decided by the strip: how late a packet is,
   how much later some are than others, and how many never arrive. It runs on the simulation's
   clock, so one setting gives the same match every time it is played the same way. */
let latency = Number(flag('latency', '60'));
let loss = Number(flag('loss', '5'));
let redundancy = Number(flag('redundancy', '4'));
let inputDelay = Number(flag('delay', '2'));

function impairment(): Impairment {
  return { latencyMs: latency, jitterMs: latency / 3, loss: loss / 100 };
}
// #endregion

// #region session
/* A match: a network, two peers and a lockstep session each. Changing the link starts a new one. */
interface Match {
  readonly net: LoopbackNetwork;
  readonly peers: readonly [Peer, Peer];
  readonly sessions: readonly [LockstepSession<WorldSnapshot>, LockstepSession<WorldSnapshot>];
  tick: number;
}

function startMatch(): Match {
  const net = new LoopbackNetwork();
  const peers = [makePeer(), makePeer()] as const;
  const sessions = peers.map(
    (peer, self) =>
      new LockstepSession({
        transport: net.open({ self, seed: 11 + self, impairment: impairment() }),
        loop: peer.loop,
        inputs: peer.inputs,
        self,
        participants: PARTICIPANTS,
        inputDelay,
        redundancy,
      }),
  ) as unknown as Match['sessions'];
  return { net, peers, sessions, tick: 0 };
}
let match = startMatch();
// #endregion

/* Your keys, on the left peer. */
const input = new InputSource(canvas, ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
const actions = new ActionMap(input, {
  move: {
    stick: 'left',
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  restart: { keys: ['KeyR', 'Enter'], buttons: ['start'] },
});
const move = { x: 0, y: 0 };

/* A stick is a direction to the pitch, so it becomes the same four bits a key does. Up is
   negative, as on a gamepad. */
function yourInput(): number {
  actions.vector('move', move);
  return (
    (move.x < -0.3 ? LEFT : 0) |
    (move.x > 0.3 ? RIGHT : 0) |
    (move.y < -0.3 ? UP : 0) |
    (move.y > 0.3 ? DOWN : 0)
  );
}

/* The other player, on the right peer: a bot that gets behind the ball and pushes it toward your
   goal, deciding from its own peer's world. It is just another source of input to that peer. */
function botInput(peer: Peer): number {
  const { world, crafts, ball } = peer;
  const me = crafts[1] as Entity;
  const bx = world.read(ball, Ball, 'x') as number;
  const bz = world.read(ball, Ball, 'z') as number;
  const x = world.read(me, Craft, 'x') as number;
  const z = world.read(me, Craft, 'z') as number;
  const behind = z < bz - 0.4;
  const tx = behind ? bx : bx + (x < bx ? -1.2 : 1.2);
  const tz = behind ? bz : bz - 1.2;
  let bits = 0;
  if (tx < x - 0.2) bits |= LEFT;
  if (tx > x + 0.2) bits |= RIGHT;
  if (tz < z - 0.2) bits |= UP;
  if (tz > z + 0.2) bits |= DOWN;
  return bits;
}

// #region tick
/* One fixed step of the whole match: each peer reads what has arrived, publishes this tick's input,
   and advances, rewinding first if something it guessed turned out wrong. */
const yours = new Uint8Array(1);
const theirs = new Uint8Array(1);

function tick(): void {
  const [a, b] = match.sessions;
  a.poll();
  b.poll();
  yours[0] = yourInput();
  theirs[0] = botInput(match.peers[1]);
  a.submit(match.tick, yours);
  b.submit(match.tick, theirs);
  if (a.status === 'running') a.advance(FIXED_DT, match.tick);
  if (b.status === 'running') b.advance(FIXED_DT, match.tick);
  match.net.advance(1000 * FIXED_DT);
  match.tick += 1;
}
// #endregion

controls([
  {
    key: 'latency',
    label: 'latency',
    value: String(latency),
    options: ['0', '60', '150'].map((ms) => ({ text: `${ms} ms`, value: ms })),
    change: (value) => {
      latency = Number(value);
      match = startMatch();
    },
  },
  {
    key: 'loss',
    label: 'loss',
    value: String(loss),
    options: ['0', '5', '20'].map((pc) => ({ text: `${pc}%`, value: pc })),
    change: (value) => {
      loss = Number(value);
      match = startMatch();
    },
  },
  {
    key: 'redundancy',
    label: 'inputs a packet',
    value: String(redundancy),
    options: ['1', '4'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      redundancy = Number(value);
      match = startMatch();
    },
  },
  {
    key: 'delay',
    label: 'input delay',
    value: String(inputDelay),
    options: ['0', '2', '6'].map((n) => ({ text: `${n} ticks`, value: n })),
    change: (value) => {
      inputDelay = Number(value);
      match = startMatch();
    },
  },
]);

/* The pitch: a floor, a low wall with a gap at each end, and a goal mouth in each team's colour. */
const CYAN: Vec3 = [0.2, 0.85, 0.95];
const MAGENTA: Vec3 = [0.95, 0.3, 0.8];
const SEPARATION = 5.6;
const pitchMesh = new MeshBuilder()
  .addBox([0, -0.1, 0], [4.3, 0.1, 6.3], [0.2, 0.24, 0.22])
  .addBox([-4.25, 0.2, 0], [0.08, 0.2, 6.3], [0.4, 0.38, 0.36])
  .addBox([4.25, 0.2, 0], [0.08, 0.2, 6.3], [0.4, 0.38, 0.36]);
for (const end of [-1, 1]) {
  pitchMesh.addBox([-2.9, 0.2, end * 6.25], [1.4, 0.2, 0.08], [0.4, 0.38, 0.36]);
  pitchMesh.addBox([2.9, 0.2, end * 6.25], [1.4, 0.2, 0.08], [0.4, 0.38, 0.36]);
  pitchMesh.addBox([0, 0.004, end * 6.1], [1.5, 0.004, 0.12], end > 0 ? CYAN : MAGENTA);
}
pitchMesh.addBox([0, 0.003, 0], [4, 0.003, 0.02], [0.32, 0.36, 0.34]);
const pitchDraw = renderer.createMesh(pitchMesh.build());
const craftMeshes = [CYAN, MAGENTA].map((colour) =>
  renderer.createMesh(
    new MeshBuilder().addCylinder([0, 0, 0], 0.45, 0.16, 'y', colour, 0, 32, 0.4).build(),
  ),
);
const ballMesh = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.3, [0.95, 0.93, 0.85], 0, 24, 16, 0.6).build(),
);

const env = createEnvironment({
  directionalDir: [0.35, 0.85, 0.4],
  directionalColor: [1.5, 1.45, 1.35],
  ambient: [0.35, 0.37, 0.44],
  ambientGround: [0.12, 0.12, 0.13],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.55;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1,
  0,
  14,
  renderer.shadowMapSize,
  lightMatrix,
);
const readout = createReadout(renderer, 4);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const pitchModels = [-SEPARATION, SEPARATION].map((x) => {
  const model = new Float32Array(IDENTITY);
  model[12] = x;
  return model;
});
const model = new Float32Array(IDENTITY);
let time = 0;

function place(x: number, y: number, z: number): Float32Array {
  model.set(IDENTITY);
  model[12] = x;
  model[13] = y;
  model[14] = z;
  return model;
}

function drawPeer(
  peer: Peer,
  offset: number,
  draw: (mesh: MeshHandle, at: Float32Array) => void,
): void {
  const { world, crafts, ball } = peer;
  crafts.forEach((craft, index) => {
    draw(
      craftMeshes[index] as MeshHandle,
      place(
        offset + (world.read(craft, Craft, 'x') as number),
        0.16,
        world.read(craft, Craft, 'z') as number,
      ),
    );
  });
  draw(
    ballMesh,
    place(
      offset + (world.read(ball, Ball, 'x') as number),
      0.3,
      world.read(ball, Ball, 'z') as number,
    ),
  );
}

function status(side: string, index: 0 | 1): string {
  const session = match.sessions[index];
  const { replays, replayedTicks } = match.peers[index].loop.stats;
  const depth = replays === 0 ? 0 : replayedTicks / replays;
  if (session.status === 'halted') return `${side}: HALTED. ${session.reason.toUpperCase()}`;
  return `${side}: CONFIRMED TICK ${session.confirmed}  REWOUND ${replays} TIMES, ${depth.toFixed(1)} TICKS EACH`;
}

stage.run({
  simulate(dt) {
    time += dt;
    if (actions.consumePress('restart')) match = startMatch();
    tick();
  },
  render() {
    /* High and steep, so both pitches fit between the readout above and the strip below. */
    camera.fovYDeg = 46;
    camera.position[0] = 0;
    camera.position[1] = 27;
    camera.position[2] = 7.5;
    camera.lookAt(0, 0, 0.9);

    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      for (const at of pitchModels) sink.mesh(pitchDraw, at);
      drawPeer(match.peers[0], -SEPARATION, (mesh, at) => sink.mesh(mesh, at));
      drawPeer(match.peers[1], SEPARATION, (mesh, at) => sink.mesh(mesh, at));
    });
    renderer.endShadowPass();
    renderer.beginFrame([0.11, 0.12, 0.15]);
    renderer.bindMeshPass(camera, env);
    for (const at of pitchModels) renderer.drawMesh(pitchDraw, at);
    drawPeer(match.peers[0], -SEPARATION, (mesh, at) => renderer.drawMesh(mesh, at));
    drawPeer(match.peers[1], SEPARATION, (mesh, at) => renderer.drawMesh(mesh, at));

    const { world, score } = match.peers[0];
    readout.set(
      0,
      `YOU (CYAN, WASD) ${world.read(score, Score, 'cyan')} : ${world.read(score, Score, 'magenta')} BOT (MAGENTA)   R RESTARTS`,
    );
    readout.set(1, status('YOUR SCREEN', 0));
    readout.set(2, status('THEIR SCREEN', 1));
    readout.set(
      3,
      `LINK ${latency} MS, ${loss}% LOST, ${redundancy} INPUTS A PACKET, ${inputDelay} TICKS OF INPUT DELAY`,
    );
    readout.draw(time);
    renderer.endFrame();
  },
});
