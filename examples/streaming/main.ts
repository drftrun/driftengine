/**
 * A town three thousand kilometres from the origin, streamed in cells as the camera circles
 * through it, with people walking about who freeze where the simulation stops reaching.
 *
 * The camera's position is kept in double precision and never rebased; the renderer is handed
 * positions relative to an origin that moves a whole cell at a time. Cells load as the camera
 * approaches and unload after it has gone, and each one takes a second and a half to arrive,
 * standing in for a slow network. With prediction on, the stream asks for the cells the camera
 * will need two seconds from now; with it off, only for those it needs now, and the town builds
 * itself in front of you.
 *
 * The walkers are DriftScript records. A cell outside the simulated radius freezes, and its walkers
 * stop exactly where they were, drawn blue; when the camera comes round again they thaw and carry
 * on as if they had never stopped.
 */
import {
  Camera,
  MeshBuilder,
  cellCoordsOf,
  cellPredictor,
  cellsInRadius,
  computeLightMatrix,
  createCellStream,
  createEnvironment,
  createFrozenCells,
  createMeshInstances,
  freezeCell,
  hashToUnit,
  isCellFrozen,
  pumpCellStream,
  renderOrigin,
  setCellStreamOrigin,
  thawCell,
  toRenderSpace,
  srgbColor,
} from '@driftengine/core';
import type { CellStore, FreezableWorld, MeshHandle, ShadowCasters, Vec3 } from '@driftengine/core';
import { runPrediction } from '@driftengine/texture';
import type { SimulationHandle } from '@driftengine/texture';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as walkerScript from './walker.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

/** Cells are 64 metres on a side; the town is 3,000 km east of the origin. */
const CELL = 64;
const CENTRE_X = 3_000_000;
const CENTRE_Z = -1_500_000;
/** The camera circles the centre at 45 metres a second, 45 metres up. */
const LOOP_M = 420;
const SPEED = 45;
const HEIGHT = 45;

/** Where the camera is at a time, in absolute world coordinates, in double precision. */
function pathAt(time: number, out: Float64Array): Float64Array {
  const angle = (time * SPEED) / LOOP_M;
  out[0] = CENTRE_X + Math.cos(angle) * LOOP_M;
  out[1] = HEIGHT;
  out[2] = CENTRE_Z + Math.sin(angle) * LOOP_M;
  return out;
}

// #region store
/** How long a cell takes to arrive, in seconds of wall clock: a stand-in for a slow network. */
const ARRIVAL_SECONDS = 1.5;

interface Resident {
  mesh: MeshHandle;
  /** The cell's minimum corner, absolute, for drawing it relative to the render origin. */
  x: number;
  z: number;
}
const resident = new Map<number, Resident>();
const arriving = new Map<number, number>();
const coords = new Int32Array(3);

/**
 * Where a cell's contents live. Only the layer of cells at ground level holds a town; the layers
 * above and below hold nothing, so they count as loaded at once.
 */
const store: CellStore = {
  loaded(id) {
    cellCoordsOf(id, coords);
    return coords[1] !== 0 || resident.has(id);
  },
  load(id) {
    if (!arriving.has(id)) arriving.set(id, performance.now() + ARRIVAL_SECONDS * 1000);
  },
  unload(id) {
    /* Only a frozen cell may be unloaded: freezing first is a no-op for one that already is. */
    if (byCell.has(id)) freezeCell(world, frozen, id);
    const cell = resident.get(id);
    if (cell !== undefined) renderer.disposeMesh(cell.mesh);
    resident.delete(id);
    arriving.delete(id);
  },
};

/** The stream: cells within 110 metres are wanted, and dropped after two seconds unwanted. */
const stream = createCellStream({ store, size: CELL, radius: 110, hysteresis: 120 });
const predictor = cellPredictor(stream);
// #endregion

/** A cell's town, built when it arrives, from nothing but the cell's own coordinates. */
function buildCell(id: number): Resident {
  cellCoordsOf(id, coords);
  const cx = coords[0] as number;
  const cz = coords[2] as number;
  const seed = Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663);
  const town = new MeshBuilder();
  const green = 0.3 + hashToUnit(seed) * 0.08;
  town.addBox([CELL / 2, -0.1, CELL / 2], [CELL / 2 - 4, 0.1, CELL / 2 - 4], [0.24, green, 0.2]);
  town.addBox([CELL / 2, -0.12, CELL / 2], [CELL / 2, 0.1, CELL / 2], [0.32, 0.31, 0.3]);
  for (let quarter = 0; quarter < 4; quarter += 1) {
    if (hashToUnit(seed + quarter * 31) < 0.45) continue;
    const x = (quarter % 2) * 30 + 17;
    const z = Math.floor(quarter / 2) * 30 + 17;
    const tall = 4 + hashToUnit(seed + quarter * 53) * 16;
    const tone = 0.55 + hashToUnit(seed + quarter * 71) * 0.3;
    town.addBox([x, tall / 2, z], [8, tall / 2, 8], [tone, tone * 0.92, tone * 0.82]);
  }
  return { mesh: renderer.createMesh(town.build()), x: cx * CELL, z: cz * CELL };
}

// #region walkers
/** The walkers, hosted. Each is a record the page holds, so an edited script keeps them all. */
const walkers = hostScript(walkerScript);
interface Walker {
  x: number;
  z: number;
  heading: number;
  untilTurn: number;
  seed: number;
  turns: number;
}
const createWalker = exported<() => Walker>(walkers, 'createWalker');
type Step = (walker: Walker, dt: number, cellSize: number) => void;

const people: Walker[] = [];
const homes: number[] = [];
const walking: boolean[] = [];
const byCell = new Map<number, number[]>();

/** Four people to a cell, placed from the cell's identifier when the cell first comes near. */
function populate(id: number): void {
  const living: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const walker = createWalker();
    walker.seed = (id + i * 977) >>> 0;
    walker.x = 6 + hashToUnit(walker.seed) * (CELL - 12);
    walker.z = 6 + hashToUnit(walker.seed + 1) * (CELL - 12);
    living.push(people.length);
    people.push(walker);
    homes.push(id);
    walking.push(true);
  }
  byCell.set(id, living);
}

/** What freezing needs of the world: who lives in a cell, and their state as numbers. */
const world: FreezableWorld = {
  entitiesIn: (cell) => byCell.get(cell) ?? [],
  readState(entity, out) {
    const w = people[entity] as Walker;
    out[0] = w.x;
    out[1] = w.z;
    out[2] = w.heading;
    out[3] = w.untilTurn;
    out[4] = w.turns;
    return 5;
  },
  writeState(entity, values) {
    const w = people[entity] as Walker;
    w.x = values[0] as number;
    w.z = values[1] as number;
    w.heading = values[2] as number;
    w.untilTurn = values[3] as number;
    w.turns = values[4] as number;
  },
  simulating: (entity) => walking[entity] === true,
  setSimulating(entity, on) {
    walking[entity] = on;
  },
};
const frozen = createFrozenCells();
// #endregion

if (import.meta.hot) {
  import.meta.hot.accept('./walker.drs', (next) => {
    if (next !== undefined)
      patchModule(walkers, next as Record<string, unknown>, { Walker: people });
  });
}

/** The switches: whether the stream looks ahead, and whether the cells show their state. */
let predict = flag('predict', 'ahead') === 'ahead';
let paint = flag('paint', 'town');
controls([
  {
    key: 'predict',
    label: 'prediction',
    value: predict ? 'ahead' : 'none',
    options: [
      { text: 'two seconds ahead', value: 'ahead' },
      { text: 'none', value: 'none' },
    ],
    change: (value) => {
      predict = value === 'ahead';
    },
  },
  {
    key: 'paint',
    label: 'paint',
    value: paint,
    options: ['town', 'cells'].map((p) => ({ text: p, value: p })),
    change: (value) => {
      paint = value;
    },
  },
]);

// #region simulate
/**
 * People live in every cell within 240 metres of the camera, and walk only within 40; the rest are
 * frozen. A cell is peopled frozen, so it is the simulated radius alone that sets anyone walking.
 * Both are conservative: a cell any part of the radius's square reaches is in it.
 */
const PEOPLED_M = 240;
const SIMULATED_M = 40;
let time = 0;
const eye = new Float64Array(3);
const near: number[] = [];
const nearSet = new Set<number>();

function simulate(dt: number): void {
  time += dt;
  pathAt(time, eye);
  cellsInRadius(eye[0] as number, 0, eye[2] as number, PEOPLED_M, CELL, near);
  for (const id of near) {
    cellCoordsOf(id, coords);
    if (coords[1] !== 0 || byCell.has(id)) continue;
    populate(id);
    freezeCell(world, frozen, id);
  }
  cellsInRadius(eye[0] as number, 0, eye[2] as number, SIMULATED_M, CELL, near);
  nearSet.clear();
  for (const id of near) {
    cellCoordsOf(id, coords);
    if (coords[1] === 0) nearSet.add(id);
  }
  /* Freezing is decided here, by the simulation's own camera, and never by what is loaded. */
  for (const id of nearSet) thawCell(world, frozen, id);
  for (const id of byCell.keys()) {
    if (!nearSet.has(id) && !isCellFrozen(frozen, id)) freezeCell(world, frozen, id);
  }
  const step = exported<Step>(walkers, 'step');
  for (let i = 0; i < people.length; i += 1) {
    if (walking[i] === true) step(people[i] as Walker, dt, CELL);
  }
}
// #endregion

// #region predict
/**
 * What prediction runs forward. The view here depends only on the camera's path, so the handle
 * saves, advances and restores the clock alone; a game whose camera follows a simulated player
 * advances its real step.
 */
let predictedTime = 0;
let savedTime = 0;
const lens = new Camera();
const at = new Float64Array(3);
const ahead = new Float64Array(3);
const local = new Float32Array(3);
const handle: SimulationHandle = {
  save: () => {
    savedTime = predictedTime;
  },
  restore: () => {
    predictedTime = savedTime;
  },
  advance: (dt) => {
    predictedTime += dt;
  },
  viewAt(out) {
    aimAt(lens, predictedTime);
    lens.updateMatrices(renderer.cssWidth / Math.max(1, renderer.cssHeight));
    out.set(lens.view);
  },
};

/** Put a camera on the path at a time, in render space, looking three seconds ahead. */
function aimAt(view: Camera, when: number): void {
  pathAt(when, at);
  pathAt(when + 3, ahead);
  toRenderSpace(at[0] as number, at[1] as number, at[2] as number, stream.origin, local);
  view.position[0] = local[0] as number;
  view.position[1] = local[1] as number;
  view.position[2] = local[2] as number;
  toRenderSpace(ahead[0] as number, 0, ahead[2] as number, stream.origin, local);
  view.lookAt(local[0] as number, local[1] as number, local[2] as number);
}
// #endregion

/** One figure, drawn once a walker, at twice life size so it reads from the air. */
const figure = renderer.createMesh(
  new MeshBuilder().addCapsule([0, 1.8, 0], 0.6, 1.2, [1, 1, 1]).build(),
);
const crowd = createMeshInstances(4096);
const crowdBatch = renderer.createInstanced(figure, crowd.capacity);
const WALKING: Vec3 = [1, 0.25, 0.02];
const STILL: Vec3 = [0.05, 0.25, 1];
const FROZEN_CELL: Vec3 = [0.45, 0.62, 1.5];
const LIVE_CELL: Vec3 = [1.3, 1.05, 0.7];

const HORIZON = srgbColor(0.7, 0.76, 0.84);
const env = createEnvironment({
  directionalDir: [-0.45, 0.6, -0.35],
  directionalColor: [2, 1.9, 1.7],
  ambient: [0.32, 0.36, 0.44],
  ambientGround: [0.14, 0.13, 0.12],
  fogColor: HORIZON,
  fogDensity: 0.0035,
});
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.75;
const origin = new Float64Array(3);
const model = new Float32Array(16);
const corner = new Float32Array(3);

/** Each resident cell, placed relative to the render origin: the subtraction is done in doubles. */
function placeCell(cell: Resident): Float32Array {
  toRenderSpace(cell.x, 0, cell.z, stream.origin, corner);
  model.fill(0);
  model[0] = 1;
  model[5] = 1;
  model[10] = 1;
  model[12] = corner[0] as number;
  model[13] = corner[1] as number;
  model[14] = corner[2] as number;
  model[15] = 1;
  return model;
}

const casters: ShadowCasters = (sink) => {
  for (const cell of resident.values()) sink.mesh(cell.mesh, placeCell(cell));
  sink.instanced?.(crowdBatch, crowd);
};

function placeCrowd(): void {
  crowd.count = 0;
  for (let i = 0; i < people.length && crowd.count < crowd.capacity; i += 1) {
    const cell = resident.get(homes[i] as number);
    if (cell === undefined) continue;
    const w = people[i] as Walker;
    toRenderSpace(cell.x + w.x, 0, cell.z + w.z, stream.origin, corner);
    const o = crowd.count * 16;
    crowd.models.fill(0, o, o + 16);
    crowd.models[o] = 1;
    crowd.models[o + 5] = 1;
    crowd.models[o + 10] = 1;
    crowd.models[o + 12] = corner[0] as number;
    crowd.models[o + 13] = corner[1] as number;
    crowd.models[o + 14] = corner[2] as number;
    crowd.models[o + 15] = 1;
    crowd.tints.set(walking[i] === true ? WALKING : STILL, crowd.count * 3);
    crowd.count += 1;
  }
  renderer.uploadInstanced(crowdBatch, crowd);
}

/** Where the camera is, and what the stream holds. */
const readout = createReadout(renderer, 2);

stage.run({
  simulate,
  render() {
    // #region stream
    /* The render origin follows the camera a whole cell at a time, and the stream is told it. */
    pathAt(time, eye);
    renderOrigin(eye[0] as number, eye[1] as number, eye[2] as number, CELL, origin);
    setCellStreamOrigin(stream, origin[0] as number, origin[1] as number, origin[2] as number);
    predictedTime = time;
    runPrediction(handle, predictor, predict ? 120 : 1, predict ? 1 / 60 : 0, 32);
    pumpCellStream(stream, eye[0] as number, eye[1] as number, eye[2] as number);
    // #endregion

    const now = performance.now();
    for (const [id, due] of arriving) {
      if (due > now) continue;
      arriving.delete(id);
      resident.set(id, buildCell(id));
    }

    aimAt(camera, time);
    camera.fovYDeg = 60;
    camera.far = 600;
    placeCrowd();

    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      camera.position[0],
      0,
      camera.position[2],
      90,
      renderer.shadowMapSize,
      lightMatrix,
    );
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();

    renderer.beginFrame(HORIZON);
    renderer.bindMeshPass(camera, env);
    for (const [id, cell] of resident) {
      const tint = paint !== 'cells' ? null : isCellFrozen(frozen, id) ? FROZEN_CELL : LIVE_CELL;
      renderer.drawMesh(cell.mesh, placeCell(cell), undefined, tint);
    }
    renderer.drawInstanced(crowdBatch, crowd);

    readout.set(0, `X ${Math.round(eye[0] as number)}  Z ${Math.round(eye[2] as number)}`);
    readout.set(
      1,
      `RESIDENT ${resident.size}  ARRIVING ${arriving.size}  FROZEN ${frozen.cells.size}`,
    );
    readout.draw(time);
    renderer.endFrame();
  },
});
