/**
 * A village square: three villagers go about their errands, run for the awning when it rains and go
 * back to exactly what they were doing when it stops, while a town crier walks the square deciding
 * for himself where to go next.
 *
 * The villagers run one behaviour tree each, which is data, so the page can say which step every
 * one of them is on. The crier is an agent session: a deterministic floor that always has something
 * for him to do, and, when a provider is switched on, a model asked ahead for the next thing, whose
 * answers arrive late or early and are acted on only if they still make sense. The village's day is
 * a DriftScript module: it advances the routines, watches them, and tells the crier when the weather
 * turns.
 */
import {
  AgentSession,
  DeterministicProvider,
  ToolRegistry,
  UNKNOWN_EXTENT,
  UtilityPolicy,
  applyCommand,
  navigationBridge,
} from '@driftengine/ai';
import type { AiEvent, Intent, NavigateArgs, PolicyOption } from '@driftengine/ai';
import {
  BehaviorRunner,
  MeshBuilder,
  NavPath,
  RUNNING,
  SUCCESS,
  buildBehaviorTree,
  buildNavGraph,
  computeLightMatrix,
  createEnvironment,
  createLineSegments,
  createNavSteer,
  hashToUnit,
} from '@driftengine/core';
import type { BehaviorSpec, BehaviorStatus, MeshHandle, NavGraph, Vec3 } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as villageScript from './village.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

/** Where things are on the square. */
const AWNING: Vec3 = [-9, 0, 0];
const WELL: Vec3 = [5, 0, 1];
const STALLS: Vec3[] = [
  [-5, 0, -8],
  [0, 0, -8],
  [5, 0, -8],
];
const HOMES: Vec3[] = [
  [12, 0, -5],
  [12, 0, 0],
  [12, 0, 5],
];

// #region tree
/**
 * One villager's day. The first branch is guarded by the rain: while it rains, shelter wins, and
 * the errand it interrupted is suspended where it was, not started again.
 */
const DAY: BehaviorSpec = {
  name: 'day',
  selector: [
    {
      name: 'out of the rain',
      whileTrue: 'raining',
      does: {
        name: 'shelter',
        sequence: [
          { name: 'run to the awning', action: 'toAwning' },
          { name: 'wait it out', action: 'waitOut' },
        ],
      },
    },
    {
      name: 'errands',
      sequence: [
        { name: 'walk to the stall', action: 'toStall' },
        { name: 'trade', action: 'trade' },
        { name: 'walk to the well', action: 'toWell' },
        { name: 'draw water', action: 'drawWater' },
        { name: 'walk home', action: 'toHome' },
        { name: 'rest', action: 'rest' },
      ],
    },
  ],
};
// #endregion

// #region tasks
/** A villager, and the verbs the tree calls by name. */
interface Villager {
  readonly name: string;
  readonly home: Vec3;
  readonly stall: Vec3;
  x: number;
  z: number;
  heading: number;
  /** Seconds left on each timed step, by name: kept while a step is suspended, cleared when done. */
  readonly timers: Map<string, number>;
}
let raining = flag('rain', 'dry') === 'raining';
const DT = 1 / 60;

function walkTo(v: Villager, target: Vec3, pace: number): BehaviorStatus {
  const dx = target[0] - v.x;
  const dz = target[2] - v.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.1) return SUCCESS;
  const step = Math.min(distance, pace * DT);
  v.x += (dx / distance) * step;
  v.z += (dz / distance) * step;
  v.heading = Math.atan2(dx, dz);
  return RUNNING;
}

/**
 * Spend a while at a place: walk back to it first, which is what a step resumed after the rain
 * needs, then count down a timer that is kept while the step is suspended.
 */
function spend(v: Villager, place: Vec3, step: string, seconds: number): BehaviorStatus {
  if (walkTo(v, place, 1.4) === RUNNING) return RUNNING;
  const left = (v.timers.get(step) ?? seconds) - DT;
  if (left > 0) {
    v.timers.set(step, left);
    return RUNNING;
  }
  v.timers.delete(step);
  return SUCCESS;
}

/** Where each villager stands at their stall, at the well and at their own door. */
const stallOf = (v: Villager): Vec3 => [v.stall[0], 0, v.stall[2] + 1.4];
const wellOf = (v: Villager): Vec3 => [
  WELL[0] - 1.2 + HOMES.indexOf(v.home) * 1.2,
  0,
  WELL[2] + 1.4,
];
const doorOf = (v: Villager): Vec3 => [v.home[0] - 1.6, 0, v.home[2]];

const tree = buildBehaviorTree(DAY, {
  actions: {
    toAwning: (v: Villager) =>
      walkTo(v, [AWNING[0], 0, AWNING[2] + (HOMES.indexOf(v.home) - 1) * 1.2], 3.2),
    waitOut: () => (raining ? RUNNING : SUCCESS),
    toStall: (v: Villager) => walkTo(v, stallOf(v), 1.4),
    trade: (v: Villager) => spend(v, stallOf(v), 'trade', 4),
    toWell: (v: Villager) => walkTo(v, wellOf(v), 1.4),
    drawWater: (v: Villager) => spend(v, wellOf(v), 'draw', 3),
    toHome: (v: Villager) => walkTo(v, doorOf(v), 1.4),
    rest: (v: Villager) => spend(v, doorOf(v), 'rest', 4),
  },
  conditions: { raining: () => raining },
});
// #endregion

const villagers: Villager[] = ['baker', 'smith', 'weaver'].map((name, at) => ({
  name,
  home: HOMES[at] as Vec3,
  stall: STALLS[at] as Vec3,
  x: (HOMES[at] as Vec3)[0] - 1.6,
  z: (HOMES[at] as Vec3)[2],
  heading: -Math.PI / 2,
  timers: new Map(),
}));
const routines = villagers.map(() => new BehaviorRunner<Villager>(tree));

// #region bridge
/**
 * The crier walks a grid of lanes, and the navigation bridge is the one tool he is given: walk to
 * a point, guarded by there being a route to it from where he is.
 */
const lanes: NavGraph = buildNavGraph(
  [-8, 0, -5, 0, 0, -5, 8, 0, -5, -8, 0, 3, 0, 0, 3, 8, 0, 3],
  [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
    { from: 3, to: 4 },
    { from: 4, to: 5 },
    { from: 0, to: 3 },
    { from: 1, to: 4 },
    { from: 2, to: 5 },
  ],
);
const crier = { x: 0, y: 0, z: 3, heading: 0, path: new NavPath(lanes, 16, { arriveM: 0.3 }) };
const world = { lanes, crier };
const tools = new ToolRegistry<typeof world>();
for (const tool of navigationBridge<typeof world>({
  graphOf: (w) => w.lanes,
  positionOf: (w, _id, out) => {
    out[0] = w.crier.x;
    out[1] = 0;
    out[2] = w.crier.z;
    return true;
  },
  pathOf: (w) => w.crier.path,
})) {
  tools.register(tool);
}
// #endregion

// #region floor
/** The floor: whichever corner is furthest from him, so he always has somewhere to go next. */
const CORNERS: Vec3[] = [
  [-8, 0, -5],
  [8, 0, -5],
  [-8, 0, 3],
  [8, 0, 3],
];
const floor = new UtilityPolicy(
  CORNERS.map((corner, at): PolicyOption => ({
    intent: {
      id: `walk to corner ${at + 1}`,
      priority: 1,
      toolIds: ['navigate@1'],
      args: [{ agentId: 'crier', x: corner[0], y: 0, z: corner[2] } satisfies NavigateArgs],
      expectedExtentMs: UNKNOWN_EXTENT,
      source: 'floor',
    },
    score: () => Math.hypot(corner[0] - crier.x, corner[2] - crier.z),
  })),
);
// #endregion

// #region session
/** A provider that answers after a stated number of ticks: a stand-in for a model, slow or quick. */
const PLACES: [string, Vec3][] = [
  ['the well', [8, 0, 3]],
  ['the stalls', [0, 0, -5]],
  ['the awning', [-8, 0, 3]],
];
function provider(latencyTicks: number): DeterministicProvider {
  return new DeterministicProvider((index: number) => {
    const [, at] = PLACES[index % PLACES.length] as [string, Vec3];
    const events: AiEvent[] = [
      {
        kind: 'toolCall',
        callId: `c${index}`,
        toolId: 'navigate@1',
        args: { agentId: 'crier', x: at[0], y: 0, z: at[2] },
      },
      { kind: 'done', reason: 'complete' },
    ];
    return { latencyTicks, events };
  });
}

let answering: DeterministicProvider | undefined;
let session = new AgentSession({ agentId: 'crier', policy: floor, tools, world });
function connect(latencyTicks: number | null): void {
  session.dispose('the provider changed');
  answering = latencyTicks === null ? undefined : provider(latencyTicks);
  session = new AgentSession({
    agentId: 'crier',
    policy: floor,
    provider: answering,
    tools,
    world,
  });
}
// #endregion

// #region script
/** The village's day, hosted with the routines it drives and the agents it may wake. */
const village = hostScript(villageScript, {
  behavior: {
    context: (routine) => villagers[routines.indexOf(routine as BehaviorRunner<Villager>)],
  },
  ai: { agents: { get: (id) => (id === 'crier' ? session : undefined) } },
});
interface Square {
  raining: boolean;
  wasRaining: boolean;
  holdFirst: boolean;
  sheltering: number;
  trading: number;
}
const square = exported<() => Square>(village, 'createSquare')();
type Day = (
  square: Square,
  first: BehaviorRunner<Villager>,
  second: BehaviorRunner<Villager>,
  third: BehaviorRunner<Villager>,
  crier: AgentSession,
) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./village.drs', (next) => {
    if (next !== undefined)
      patchModule(village, next as Record<string, unknown>, { Square: [square] });
  });
}
// #endregion

const LATENCY: Record<string, number | null> = { none: null, slow: 300, quick: 12 };
const chosenProvider = flag('model', 'none');
if (LATENCY[chosenProvider] !== undefined && LATENCY[chosenProvider] !== null) {
  connect(LATENCY[chosenProvider] as number);
}
square.holdFirst = flag('hold', 'nobody') === 'baker';
controls([
  {
    key: 'rain',
    label: 'weather',
    value: raining ? 'raining' : 'dry',
    options: ['dry', 'raining'].map((w) => ({ text: w, value: w })),
    change: (value) => {
      raining = value === 'raining';
    },
  },
  {
    key: 'model',
    label: 'crier asks',
    value: chosenProvider,
    options: ['none', 'slow', 'quick'].map((m) => ({
      text: m === 'none' ? 'nobody' : `a ${m} model`,
      value: m,
    })),
    change: (value) => connect(LATENCY[value] ?? null),
  },
  {
    key: 'hold',
    label: 'hold',
    value: square.holdFirst ? 'baker' : 'nobody',
    options: ['nobody', 'baker'].map((h) => ({ text: h, value: h })),
    change: (value) => {
      square.holdFirst = value === 'baker';
    },
  },
]);

// #region tick
let tick = 0;
let acting: Intent | null = null;
const steer = createNavSteer();
function stepCrier(): void {
  answering?.advance(tick);
  const intent = session.tick(tick, tick * 1000 * DT);
  if (intent !== acting) {
    /* A new intent: its tool calls run now, through the same guards a model's answer passes. */
    acting = intent;
    intent.toolIds.forEach((toolId, at) =>
      applyCommand(
        tools,
        world,
        {
          kind: 'command',
          toolId,
          args: intent.args[at],
          agentId: 'crier',
          issuedAtTick: tick,
          acceptedAtTick: tick,
        },
        tick,
      ),
    );
  }
  crier.path.steer(crier.x, 0, crier.z, steer);
  if (steer.arrived) {
    session.complete(tick * 1000 * DT);
    return;
  }
  const dx = steer.x - crier.x;
  const dz = steer.z - crier.z;
  const distance = Math.hypot(dx, dz) || 1;
  crier.x += (dx / distance) * 1.6 * DT;
  crier.z += (dz / distance) * 1.6 * DT;
  crier.heading = Math.atan2(dx, dz);
}
// #endregion

/* Drawing: the square, its stalls, well, awning and houses, the people, and the rain. */
const square3d = new MeshBuilder().addBox([0, -0.1, 0], [16, 0.1, 12], [0.56, 0.53, 0.48]);
square3d.addBox([0, -0.3, 0], [60, 0.2, 60], [0.3, 0.38, 0.24]);
for (const [x, , z] of STALLS) {
  square3d.addBox([x, 0.5, z], [1.2, 0.5, 0.6], [0.5, 0.35, 0.22]);
  square3d.addBox([x, 1.9, z + 0.2], [1.4, 0.05, 0.9], [0.75, 0.25, 0.2]);
  for (const sx of [-1.2, 1.2])
    square3d.addCylinder([x + sx, 1, z + 0.9], 0.04, 0.9, 'y', [0.35, 0.3, 0.25]);
}
square3d.addCylinder([WELL[0], 0.4, WELL[2]], 0.8, 0.4, 'y', [0.55, 0.55, 0.58], 0, 20);
square3d.addCylinder([WELL[0], 0.82, WELL[2]], 0.6, 0.02, 'y', [0.15, 0.22, 0.3], 0, 20);
square3d.addBox([AWNING[0], 2.4, AWNING[2]], [1.6, 0.06, 2.6], [0.25, 0.4, 0.62]);
for (const [sx, sz] of [
  [-1.4, -2.4],
  [1.4, -2.4],
  [-1.4, 2.4],
  [1.4, 2.4],
] as const) {
  square3d.addCylinder([AWNING[0] + sx, 1.2, AWNING[2] + sz], 0.06, 1.2, 'y', [0.3, 0.28, 0.25]);
}
for (const [x, , z] of HOMES) {
  square3d.addBox([x + 1.6, 1.3, z], [1.6, 1.3, 2.1], [0.8, 0.72, 0.6]);
  square3d.addBox([x + 1.6, 2.8, z], [1.8, 0.2, 2.3], [0.5, 0.25, 0.2]);
  square3d.addBox([x - 0.04, 0.9, z], [0.05, 0.9, 0.45], [0.3, 0.2, 0.12]);
}
const squareMesh = renderer.createMesh(square3d.build());
const COLOURS: Vec3[] = [
  [0.85, 0.75, 0.45],
  [0.35, 0.38, 0.45],
  [0.6, 0.3, 0.55],
];
const villagerMeshes: MeshHandle[] = COLOURS.map((colour) =>
  renderer.createMesh(
    new MeshBuilder()
      .addCapsule([0, 0.75, 0], 0.22, 0.4, colour)
      .addSphere([0, 1.58, 0], 0.17, [0.85, 0.68, 0.55])
      .addBox([0, 1.58, 0.15], [0.05, 0.03, 0.04], [0.3, 0.2, 0.15])
      .build(),
  ),
);
const crierMesh = renderer.createMesh(
  new MeshBuilder()
    .addCapsule([0, 0.85, 0], 0.25, 0.45, [0.6, 0.12, 0.12])
    .addSphere([0, 1.75, 0], 0.18, [0.85, 0.68, 0.55])
    .addCylinder([0, 2.02, 0], 0.22, 0.03, 'y', [0.12, 0.1, 0.1])
    .addCylinder([0, 2.15, 0], 0.13, 0.12, 'y', [0.12, 0.1, 0.1])
    .addSphere([0.32, 1.1, 0.15], 0.09, [0.85, 0.7, 0.25])
    .build(),
);
const RAIN = 600;
const rain = createLineSegments(RAIN);
const rainBatch = renderer.createLines(RAIN, 'rain');

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const placed = (x: number, z: number, heading: number, out: Float32Array): Float32Array => {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  out.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 0, z, 1]);
  return out;
};
const models = villagers.map(() => new Float32Array(16));
const crierModel = new Float32Array(16);
const env = createEnvironment({
  directionalDir: [0.4, 0.8, 0.45],
  directionalColor: [1.6, 1.5, 1.35],
  ambient: [0.34, 0.37, 0.44],
  ambientGround: [0.14, 0.13, 0.12],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  1,
  0,
  16,
  renderer.shadowMapSize,
  lightMatrix,
);
const readout = createReadout(renderer, 3);
const path = new Uint32Array(16);
/** An intent in words: the floor's by its own name, a model's by the place it sends him. */
const describe = (intent: Intent | null): string => {
  if (intent === null) return 'NOTHING YET';
  if (intent.source === 'floor') return `${intent.id.toUpperCase()} (FLOOR)`;
  const to = intent.args[0] as NavigateArgs | undefined;
  const place = PLACES.find(([, at]) => at[0] === to?.x && at[2] === to?.z)?.[0] ?? 'somewhere';
  return `WALK TO ${place.toUpperCase()} (MODEL)`;
};
const deepest = (routine: BehaviorRunner<Villager>): string => {
  const depth = routine.activePath(path);
  return depth > 0 ? routine.nameOf(path[depth - 1] ?? 0) : '';
};

stage.run({
  simulate() {
    tick += 1;
    square.raining = raining;
    exported<Day>(village, 'day')(square, routines[0]!, routines[1]!, routines[2]!, session);
    stepCrier();
  },
  render() {
    camera.fovYDeg = 45;
    camera.position[0] = 1;
    camera.position[1] = 14;
    camera.position[2] = 17;
    camera.lookAt(1.5, 0, -0.5);
    villagers.forEach((v, at) => placed(v.x, v.z, v.heading, models[at] as Float32Array));
    placed(crier.x, crier.z, crier.heading, crierModel);
    const drawAll = (draw: (mesh: MeshHandle, model: Float32Array) => void): void => {
      draw(squareMesh, IDENTITY);
      villagerMeshes.forEach((mesh, at) => draw(mesh, models[at] as Float32Array));
      draw(crierMesh, crierModel);
    };
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => drawAll((mesh, model) => sink.mesh(mesh, model)));
    renderer.endShadowPass();
    renderer.beginFrame(raining ? [0.42, 0.46, 0.52] : [0.56, 0.64, 0.74]);
    renderer.bindMeshPass(camera, env);
    drawAll((mesh, model) => renderer.drawMesh(mesh, model));
    if (raining) {
      /* Streaks falling through the square, each at its own phase. */
      for (let i = 0; i < RAIN; i += 1) {
        const x = (hashToUnit(i * 3) - 0.5) * 30;
        const z = (hashToUnit(i * 3 + 1) - 0.5) * 26;
        const y = 8 - ((tick * 0.25 + hashToUnit(i * 3 + 2) * 8) % 8);
        rain.from.set([x, y, z], i * 3);
        rain.to.set([x + 0.05, y - 0.5, z], i * 3);
      }
      rain.count = RAIN;
      renderer.drawLines(rainBatch, rain, IDENTITY, camera, env, [0.75, 0.8, 0.9], 0.02, 0.5, 0.5);
    }
    readout.set(
      0,
      villagers
        .map((v, at) => `${v.name.toUpperCase()}: ${deepest(routines[at]!).toUpperCase()}`)
        .join('   '),
    );
    const now = session.current;
    readout.set(1, `CRIER: ${describe(now)}  NEXT: ${describe(session.buffered)}`);
    readout.set(
      2,
      `${square.sheltering} SHELTERING  ${square.trading} TRADING  ${raining ? 'RAINING' : 'DRY'}`,
    );
    readout.draw(tick * DT);
    renderer.endFrame();
  },
});
