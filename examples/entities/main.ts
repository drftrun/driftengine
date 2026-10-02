/**
 * A pond at dusk: fireflies wander over the water, four frogs on lily pads catch the ones that come
 * near, and new ones hatch to keep the number the pond is set to.
 *
 * Every rule is a DriftScript `system` over components the script declares, run by the engine's
 * schedule against one world. The page builds the world, puts the frogs on their pads from the
 * script's own prefab, and draws what the stores hold. It also keeps the last five seconds as world
 * snapshots, so time can run backwards and pick up again from wherever it stops.
 */
import {
  World,
  buildSchedule,
  createWorldSnapshot,
  instantiate,
  runSchedule,
} from '@driftengine/entities';
import type { ComponentType, Entity, Prefab, WorldSnapshot } from '@driftengine/entities';
import {
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createLineSegments,
} from '@driftengine/core';
import type { MeshHandle, Vec3 } from '@driftengine/core';
import { bindModule, registerEntityModule } from '@driftengine/script';
import type { ComponentRegistry } from '@driftengine/script';
import { loadModule, patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { controls, flag, openStage } from '../common/stage';
import * as pondScript from './pond.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region host
/**
 * The script's components become stores, its prefabs become prefabs, and its systems become a
 * schedule. The registry and the world outlive every reload; the schedule is rebuilt on one.
 */
const pond = loadModule(pondScript as Record<string, unknown>);
const registry: ComponentRegistry = new Map();
const prefabs = new Map<string, Prefab>();
let registered = registerEntityModule(pond, registry);
for (const prefab of registered.prefabs) prefabs.set(prefab.name, prefab);
const bound = bindModule(pond, { entities: { components: registry, prefabs } });
if (!bound.bound) throw new Error(bound.reason);

const world = new World();
let schedule = buildSchedule(registered.systems);
if (import.meta.hot) {
  import.meta.hot.accept('./pond.drs', (next) => {
    if (next === undefined) return;
    patchModule(pond, next as Record<string, unknown>);
    /* The stores are kept, so every fly and frog keeps its components; the systems are new. */
    registered = registerEntityModule(pond, registry);
    for (const prefab of registered.prefabs) prefabs.set(prefab.name, prefab);
    schedule = buildSchedule(registered.systems);
  });
}
// #endregion

const component = (name: string): ComponentType => {
  const type = registry.get(name);
  if (type === undefined) throw new Error(`pond.drs declares no ${name}`);
  return type;
};
const Position = component('Position');
const Frog = component('Frog');
const Fly = component('Fly');
const Pond = component('Pond');

// #region frogs
/** A frog on each lily pad, from the script's own prefab, with the page saying where. */
const PADS: [number, number][] = [
  [4, 0],
  [0, 4],
  [-4, 0],
  [0, -4],
];
const sitter = prefabs.get('Sitter');
if (sitter === undefined) throw new Error('pond.drs declares no Sitter');
const frogs: Entity[] = PADS.map(([x, z]) =>
  instantiate(world, sitter, { Position: { x, y: 0.15, z } }),
);
const pondEntity = world.create();
world.add(pondEntity, Pond, { flies: 12 });
// #endregion

let flies = Number(flag('flies', '12'));
let running = flag('time', 'forward') === 'forward';

// #region rewind
/**
 * Five seconds of the whole world, a snapshot a tick. A slot is reused once it is written, so after
 * the first lap the ring allocates nothing.
 */
const RING = 300;
const ring: WorldSnapshot[] = Array.from({ length: RING }, createWorldSnapshot);
const ringTicks = new Float64Array(RING);
let head = 0;
let held = 0;
let tick = 0;

function step(): void {
  /* The switch's number wins over whatever the world held, rewound or not. */
  world.write(pondEntity, Pond, 'flies', flies);
  runSchedule(world, schedule, tick);
  tick += 1;
  world.saveInto(ring[head % RING] as WorldSnapshot);
  ringTicks[head % RING] = tick;
  head += 1;
  held = Math.min(held + 1, RING);
}

function stepBack(): void {
  if (held <= 1) return;
  head -= 1;
  held -= 1;
  const at = (head - 1 + RING) % RING;
  world.loadFrom(ring[at] as WorldSnapshot);
  tick = ringTicks[at] ?? tick;
}
// #endregion

controls([
  {
    key: 'flies',
    label: 'flies',
    value: String(flies),
    options: ['12', '40'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      flies = Number(value);
    },
  },
  {
    key: 'time',
    label: 'time',
    value: running ? 'forward' : 'back',
    options: ['forward', 'back'].map((t) => ({ text: t, value: t })),
    change: (value) => {
      running = value === 'forward';
    },
  },
]);

/* Drawing: the pond, its pads and reeds, the frogs, the flies, and a frog's tongue. */
const scenery = new MeshBuilder()
  .addBox([0, -0.2, 0], [40, 0.2, 40], [0.2, 0.28, 0.16])
  .addCylinder([0, 0.01, 0], 7.2, 0.02, 'y', [0.16, 0.14, 0.1], 0, 48)
  .addCylinder([0, 0.03, 0], 7, 0.02, 'y', [0.08, 0.16, 0.22], 0, 48);
for (const [x, z] of PADS)
  scenery.addCylinder([x, 0.06, z], 0.75, 0.02, 'y', [0.2, 0.42, 0.18], 0, 20);
/* Reeds round the edge, drawn and not casting: a low sun would lay their shadows across the water. */
const reeds = new MeshBuilder();
for (let k = 0; k < 60; k += 1) {
  const angle = k * 2.399;
  const radius = 7.3 + (k % 5) * 0.2;
  const height = 0.35 + (k % 3) * 0.15;
  reeds.addCylinder(
    [Math.cos(angle) * radius, height, Math.sin(angle) * radius],
    0.025,
    height,
    'y',
    [0.36, 0.42, 0.2],
  );
}
const reedMesh = renderer.createMesh(reeds.build());
const sceneryMesh = renderer.createMesh(scenery.build());
const frogMesh = renderer.createMesh(
  new MeshBuilder()
    .addSphere([0, 0.22, 0], 0.28, [0.32, 0.55, 0.22], 0, 16, 10)
    .addSphere([-0.12, 0.42, 0.12], 0.08, [0.85, 0.85, 0.6])
    .addSphere([0.12, 0.42, 0.12], 0.08, [0.85, 0.85, 0.6])
    .addSphere([-0.12, 0.44, 0.18], 0.035, [0.05, 0.05, 0.05])
    .addSphere([0.12, 0.44, 0.18], 0.035, [0.05, 0.05, 0.05])
    .build(),
);
const flyMesh = renderer.createMesh(
  new MeshBuilder().addSphere([0, 0, 0], 0.07, [1, 0.62, 0.18], 1.4, 8, 5).build(),
);
const tongues = createLineSegments(PADS.length);
const tongueBatch = renderer.createLines(PADS.length, 'tongues');

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const frogModels = frogs.map(() => new Float32Array(16));
const flyModel = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const env = createEnvironment({
  directionalDir: [-0.5, 0.45, 0.6],
  directionalColor: [1.1, 0.75, 0.55],
  ambient: [0.16, 0.18, 0.28],
  ambientGround: [0.06, 0.06, 0.05],
  nightFactor: 0.8,
  emissiveGain: 1.6,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.7;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  0.5,
  0,
  10,
  renderer.shadowMapSize,
  lightMatrix,
);
const readout = createReadout(renderer, 2);
let time = 0;

stage.run({
  simulate() {
    if (running) step();
    else stepBack();
  },
  render() {
    time += 1 / 60;
    camera.fovYDeg = 45;
    camera.position[0] = Math.sin(time * 0.04) * 3;
    camera.position[1] = 7.5;
    camera.position[2] = 11;
    camera.lookAt(0, 0.4, 0.5);

    // #region views
    /* A host reads the stores' columns directly, the way any renderer would. */
    const positions = world.view(Position);
    const frogColumns = world.view(Frog);
    const spot = (entity: Entity): number => positions.sparse[entity % 2 ** 26] ?? 0;
    // #endregion
    frogs.forEach((frog, at) => {
      const i = spot(frog);
      const x = (positions.x as Float32Array)[i] ?? 0;
      const z = (positions.z as Float32Array)[i] ?? 0;
      /* Facing the middle of the pond. */
      const heading = Math.atan2(-x, -z);
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      frogModels[at]?.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 0.15, z, 1]);
    });

    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(sceneryMesh, IDENTITY);
      for (const model of frogModels) sink.mesh(frogMesh, model);
    });
    renderer.endShadowPass();
    renderer.beginFrame([0.12, 0.1, 0.18]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(sceneryMesh, IDENTITY);
    renderer.drawMesh(reedMesh, IDENTITY);
    for (const model of frogModels) renderer.drawMesh(frogMesh, model);

    // #region flies
    /* Every entity with a Fly and a Position, drawn where its Position column says. */
    let count = 0;
    for (const fly of world.query(Fly, Position)) {
      const i = spot(fly);
      flyModel[12] = (positions.x as Float32Array)[i] ?? 0;
      flyModel[13] = (positions.y as Float32Array)[i] ?? 0;
      flyModel[14] = (positions.z as Float32Array)[i] ?? 0;
      renderer.drawMesh(flyMesh, flyModel);
      count += 1;
    }
    // #endregion

    /* A tongue for each frog that has just caught something, from its mouth to where the fly was. */
    let out = 0;
    let caught = 0;
    for (const frog of frogs) {
      const f = frogColumns.sparse[frog % 2 ** 26] ?? 0;
      caught += (frogColumns.caught as Uint32Array)[f] ?? 0;
      if (((frogColumns.tongue as Float32Array)[f] ?? 0) <= 0) continue;
      const i = spot(frog);
      tongues.from.set(
        [(positions.x as Float32Array)[i] ?? 0, 0.45, (positions.z as Float32Array)[i] ?? 0],
        out * 3,
      );
      tongues.to.set(
        [
          (frogColumns.tongueX as Float32Array)[f] ?? 0,
          (frogColumns.tongueY as Float32Array)[f] ?? 0,
          (frogColumns.tongueZ as Float32Array)[f] ?? 0,
        ],
        out * 3,
      );
      out += 1;
    }
    tongues.count = out;
    renderer.drawLines(tongueBatch, tongues, IDENTITY, camera, env, [1.4, 0.3, 0.35], 0.05, 1, 0.3);

    readout.set(0, `${count} FLIES  ${caught} CAUGHT  ${world.liveCount} ENTITIES`);
    readout.set(1, running ? `TICK ${tick}` : `REWINDING  ${((held - 1) / 60).toFixed(1)} S LEFT`);
    readout.draw(time);
    renderer.endFrame();
  },
});
