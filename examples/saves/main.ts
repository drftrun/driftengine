/**
 * A garden bed that saves: seeds sown and growing in DriftScript, the whole bed written out and read
 * back as an entity world, an autosave the script holds back while the last one is on its way, and
 * the player's pace and season kept as preferences.
 *
 * The saves go to a server that is this page pretending: it answers after a delay and keeps what it
 * is sent in your browser's storage, so a reload finds it. The strip makes it slow or takes it
 * offline, and the readout says what the store is doing about it. Save, Load and Clear are on the
 * right. Pace and season are preferences: change one and reload, and it stays.
 */
import {
  MeshBuilder,
  PreferenceStore,
  RemoteSaveStore,
  computeLightMatrix,
  createEnvironment,
  defaultSaveTimer,
  defaultStore,
} from '@driftengine/core';
import type { PreferenceSchema, SaveBackend } from '@driftengine/core';
import {
  World,
  buildSchedule,
  deserializeWorld,
  runSchedule,
  serializeWorld,
} from '@driftengine/entities';
import type { ComponentType, Entity, SerializedScene } from '@driftengine/entities';
import { bindModule, registerEntityModule } from '@driftengine/script';
import type { ComponentRegistry } from '@driftengine/script';
import { loadModule, patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as gardenScript from './garden.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;
const panel = document.querySelector<HTMLElement>('#panel');
const note = document.querySelector<HTMLElement>('#note');
const readout = createReadout(renderer, 3, { clearRight: () => (panel?.offsetWidth ?? 0) + 24 });

// #region preferences
/* What the player chose, validated field by field: a pace outside its range is clamped, and a
   season that is not one of the two falls back to summer. */
interface GardenPreferences {
  pace: number;
  season: string;
}
const SCHEMA: PreferenceSchema<GardenPreferences> = {
  key: 'driftengine.examples.saves.preferences',
  defaults: { pace: 1, season: 'summer' },
  ranges: { pace: [0.25, 4] },
  options: { season: ['summer', 'autumn'] },
};
const preferences = new PreferenceStore(SCHEMA);
// #endregion
/* A link that names a pace or a season sets it, through the same checks a stored one gets. */
preferences.update({
  pace: Number(flag('pace', String(preferences.value.pace))),
  season: flag('season', preferences.value.season),
});

// #region server
/* A server that is this page pretending. It answers after a delay, keeps what it is sent in the
   browser's own storage so that a reload finds it, and fails when the strip says it is down. */
type Server = 'online' | 'slow' | 'offline';
let server = flag('server', 'online') as Server;
const HELD = 'driftengine.examples.saves.server';
const local = defaultStore();
const answer = (): Promise<void> =>
  new Promise((done) => setTimeout(done, server === 'slow' ? 2500 : 300));

const backend: SaveBackend = {
  async load() {
    await answer();
    if (server === 'offline') throw new Error('the server did not answer');
    return JSON.parse(local.read(HELD) ?? '[]') as [string, string][];
  },
  async save(changes) {
    await answer();
    if (server === 'offline') throw new Error('the server did not answer');
    const held = new Map(JSON.parse(local.read(HELD) ?? '[]') as [string, string][]);
    for (const [key, value] of changes) {
      if (value === null) held.delete(key);
      else held.set(key, value);
    }
    local.write(HELD, JSON.stringify([...held]));
  },
};
// #endregion

// #region store
/* The synchronous seam over the server: reads come from a copy loaded once, and writes are batched,
   sent after a quiet quarter second, and retried with a growing delay when the server fails. */
const saves = new RemoteSaveStore(backend, defaultSaveTimer(), {
  flushDelayMs: 250,
  maxAttempts: 3,
  retryDelayMs: 1000,
});
await saves.load();
/* A write is durable once the server has it. Leaving the page is the last chance to send one. */
addEventListener('pagehide', () => void saves.flush());
// #endregion

// #region world
/* The script's components become stores and its systems a schedule, as in the entities example. */
const garden = loadModule(gardenScript as Record<string, unknown>);
const registry: ComponentRegistry = new Map();
let registered = registerEntityModule(garden, registry);
const bound = bindModule(garden, {
  entities: { components: registry, prefabs: new Map(registered.prefabs.map((p) => [p.name, p])) },
});
if (!bound.bound) throw new Error(bound.reason);
let schedule = buildSchedule(registered.systems);

interface Autosave {
  every: number;
  since: number;
  written: number;
  held: number;
}
const autosaves = exported<() => Autosave>(garden, 'createAutosave')();
if (import.meta.hot) {
  import.meta.hot.accept('./garden.drs', (next) => {
    if (next === undefined) return;
    patchModule(garden, next as Record<string, unknown>, { Autosave: [autosaves] });
    registered = registerEntityModule(garden, registry);
    schedule = buildSchedule(registered.systems);
  });
}

/* Looked up each time: a hot edit that adds a field gives the component a new schema. */
const type = (name: string): ComponentType => {
  const found = registry.get(name);
  if (found === undefined) throw new Error(`garden.drs declares no ${name}`);
  return found;
};

let world = new World();
let bed = plantBed();
function plantBed(): Entity {
  const entity = world.create();
  world.add(entity, type('Bed'), {});
  return entity;
}
// #endregion

// #region save
/* The bed and every plant, written out with each component's schema beside it. */
const SLOT = 'driftengine.examples.saves.slot';
const written = (): string => JSON.stringify(serializeWorld(world, [type('Bed'), type('Plant')]));

function save(): string {
  saves.write(SLOT, written());
  return `saved ${world.count(type('Plant'))} plants; the store sends them`;
}

/* Into a fresh world, which replaces the running one only if every entity loaded. */
function load(key: string): string {
  const text = saves.read(key);
  if (text === null) return 'nothing is saved there yet';
  const fresh = new World();
  const result = deserializeWorld(fresh, JSON.parse(text) as SerializedScene, [
    type('Bed'),
    type('Plant'),
  ]);
  if (!result.loaded) return result.reason;
  const found = result.entities.find((entity) => fresh.has(entity, type('Bed')));
  if (found === undefined) return 'that save holds no bed';
  world = fresh;
  bed = found;
  return `loaded ${fresh.count(type('Plant'))} plants`;
}
// #endregion

function clear(): string {
  world = new World();
  bed = plantBed();
  return 'cleared; the bed starts again from its first seed';
}

/* The panel's three buttons, each answering in a sentence. */
const buttons: Record<string, () => string> = {
  save,
  load: () => load(SLOT),
  autosave: () => load('driftengine.examples.saves.auto'),
  clear,
};
for (const button of document.querySelectorAll<HTMLButtonElement>('#panel button')) {
  button.addEventListener('click', () => {
    const act = buttons[button.dataset['act'] ?? ''];
    if (act !== undefined && note !== null) note.textContent = act();
  });
}

controls([
  {
    key: 'server',
    label: 'Server',
    value: server,
    options: [
      { text: 'online', value: 'online' },
      { text: 'slow', value: 'slow' },
      { text: 'offline', value: 'offline' },
    ],
    change: (value) => {
      server = value as Server;
      /* Back online, whatever was kept is sent now. */
      if (server !== 'offline') void saves.flush();
    },
  },
  {
    key: 'pace',
    label: 'Pace',
    value: String(preferences.value.pace),
    options: [
      { text: '½×', value: '0.5' },
      { text: '1×', value: '1' },
      { text: '3×', value: '3' },
    ],
    change: (value) => preferences.update({ pace: Number(value) }),
  },
  {
    key: 'season',
    label: 'Season',
    value: preferences.value.season,
    options: [
      { text: 'summer', value: 'summer' },
      { text: 'autumn', value: 'autumn' },
    ],
    change: (value) => preferences.update({ season: value }),
  },
]);

/* The bed, its border, and a plant: a stem and a crown, one mesh per season, scaled as it grows. */
const soil = renderer.createMesh(
  new MeshBuilder()
    .addBox([0, -0.1, 0], [8, 0.1, 8], [0.36, 0.42, 0.3])
    .addBox([0, 0.02, 0], [3, 0.06, 3], [0.3, 0.2, 0.13])
    .addBox([0, 0.06, -3.05], [3.1, 0.1, 0.05], [0.55, 0.5, 0.42])
    .addBox([0, 0.06, 3.05], [3.1, 0.1, 0.05], [0.55, 0.5, 0.42])
    .addBox([-3.05, 0.06, 0], [0.05, 0.1, 3], [0.55, 0.5, 0.42])
    .addBox([3.05, 0.06, 0], [0.05, 0.1, 3], [0.55, 0.5, 0.42])
    .build(),
);
const plantOf = (crown: [number, number, number]): ReturnType<typeof renderer.createMesh> =>
  renderer.createMesh(
    new MeshBuilder()
      .addCylinder([0, 0.4, 0], 0.03, 0.4, 'y', [0.35, 0.5, 0.2])
      .addSphere([0, 0.85, 0], 0.26, crown, 0, 12, 6, 0.2)
      .build(),
  );
const SEASONS: Record<string, ReturnType<typeof renderer.createMesh>> = {
  summer: plantOf([0.3, 0.62, 0.22]),
  autumn: plantOf([0.86, 0.45, 0.16]),
};

const env = createEnvironment({
  directionalDir: [0.45, 0.8, 0.35],
  directionalColor: [1.6, 1.5, 1.35],
  ambient: [0.3, 0.34, 0.4],
  ambientGround: [0.12, 0.11, 0.09],
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.6;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  0.5,
  0,
  6,
  renderer.shadowMapSize,
  lightMatrix,
);
const at = new Float32Array(16);
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/* A plant's matrix: where it stands, scaled to how tall it is and how far it has grown. */
function placePlant(x: number, z: number, scale: number): Float32Array {
  at.fill(0);
  at[0] = at[5] = at[10] = scale;
  at[15] = 1;
  at[12] = x;
  at[14] = z;
  return at;
}

let time = 0;
let offered = 0;
let tick = 0;
const GROWN = 20;

stage.run({
  simulate(dt) {
    time += dt;
    /* The preference wins over whatever the bed held, saved or not. */
    world.write(bed, type('Bed'), 'pace', preferences.value.pace);
    runSchedule(world, schedule, tick);
    tick += 1;
    /* Once a second the script is offered the garden, and decides whether to write it. */
    offered += dt;
    if (offered >= 1) {
      offered -= 1;
      exported<(a: Autosave, s: RemoteSaveStore, g: string, dt: number) => boolean>(
        garden,
        'autosave',
      )(autosaves, saves, written(), 1);
    }
  },
  render() {
    const orbit = time * 0.05;
    camera.position[0] = Math.sin(orbit) * 5;
    camera.position[1] = 3.4;
    camera.position[2] = Math.cos(orbit) * 5;
    camera.lookAt(0, 0.2, 0);

    const Plant = type('Plant');
    const plant = SEASONS[preferences.value.season] ?? SEASONS['summer'];
    const drawPlants = (draw: (matrix: Float32Array) => void): void => {
      for (const entity of world.query(Plant)) {
        const age = world.read(entity, Plant, 'age') as number;
        const tall = world.read(entity, Plant, 'tall') as number;
        const x = world.read(entity, Plant, 'x') as number;
        const z = world.read(entity, Plant, 'z') as number;
        draw(placePlant(x, z, tall * (0.15 + (0.85 * Math.min(age, GROWN)) / GROWN)));
      }
    };
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters((sink) => {
      sink.mesh(soil, identity);
      if (plant !== undefined) drawPlants((matrix) => sink.mesh(plant, matrix));
    });
    renderer.endShadowPass();
    renderer.beginFrame([0.55, 0.68, 0.82]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(soil, identity);
    if (plant !== undefined) drawPlants((matrix) => renderer.drawMesh(plant, matrix));

    const status = saves.status;
    readout.set(
      0,
      `BED ${world.count(Plant)} OF 40, PACE ${preferences.value.pace}X, ${preferences.value.season.toUpperCase()}`,
    );
    readout.set(
      1,
      status === 'failed'
        ? `SAVES FAILING, ${saves.pending} KEPT TO RETRY`
        : `SAVES ${status.toUpperCase()}${saves.pending > 0 ? `, ${saves.pending} WAITING` : ''}`,
    );
    readout.set(2, `AUTOSAVES ${autosaves.written}, HELD BACK ${autosaves.held}`);
    readout.draw(time);
    renderer.endFrame();
  },
});
