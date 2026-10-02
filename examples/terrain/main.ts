/**
 * A river valley two kilometres across, flown over: hills, rock where the slope is steep, snow on
 * the tops and a forest below the tree line.
 *
 * The ground is one heightfield drawn as a clipmap, so the patches under the camera are fine and
 * the distant ones coarse, and the patches are rebuilt as the camera crosses them. Which ground is
 * rock, where snow lies, where trees grow and how the camera flies are rules in `ground.drs`, and
 * every rule asks the terrain the same question the mesh was built from.
 *
 * The switches show what the clipmap is doing: paint each level its own colour, change how many
 * cells a patch has, and change how many levels reach out.
 */
import {
  MeshBuilder,
  SceneNode,
  computeLightMatrix,
  concatMeshes,
  createEnvironment,
  createMeshInstances,
  hashToUnit,
} from '@driftengine/core';
import type { MeshHandle, ShadowCasters, SkyColors, Vec3, WaterBody } from '@driftengine/core';
import {
  Terrain,
  TerrainMaterials,
  clipmapFrame,
  clipmapPatchOptions,
  heightfieldPatch,
  selectClipmap,
} from '@driftengine/terrain';
import type { ClipmapFrame, HeightfieldPatchOptions } from '@driftengine/terrain';
import { patchModule } from 'driftscript';
import { exported, hostScript } from '../common/script';
import { controls, flag, flagNumber, openStage } from '../common/stage';
import * as groundScript from './ground.drs';

const stage = await openStage({
  water: true,
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

// #region field
/** Samples across each side, two metres apart: a field 2,048 metres square, centred on the origin. */
const SAMPLES = 1025;
const SPACING = 2;
const HALF = ((SAMPLES - 1) * SPACING) / 2;

/** Smooth noise on a unit lattice, from a hash of each corner. */
function lattice(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hashToUnit(Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663));
  const b = hashToUnit(Math.imul(ix + 1, 73856093) ^ Math.imul(iz, 19349663));
  const c = hashToUnit(Math.imul(ix, 73856093) ^ Math.imul(iz + 1, 19349663));
  const d = hashToUnit(Math.imul(ix + 1, 73856093) ^ Math.imul(iz + 1, 19349663));
  return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz) * 2 - 1;
}

/** Height in metres: a river winding along z, valley walls rising either side, hills over all. */
function valley(x: number, z: number): number {
  const river = Math.sin(z / 260) * 120 + Math.sin(z / 97) * 25;
  const fromRiver = Math.abs(x - river);
  const wall = Math.min(1, Math.max(0, (fromRiver - 30) / 700));
  const rise = 230 * wall * wall * (3 - 2 * wall);
  let hills = 0;
  let amplitude = 1;
  let frequency = 1 / 220;
  for (let octave = 0; octave < 4; octave += 1) {
    hills += lattice(x * frequency, z * frequency) * amplitude;
    amplitude *= 0.5;
    frequency *= 2.1;
  }
  const bed = 5 * Math.max(0, 1 - fromRiver / 22);
  return rise + hills * (4 + rise * 0.35) - bed + 3;
}

const heights = new Float32Array(SAMPLES * SAMPLES);
for (let row = 0; row < SAMPLES; row += 1)
  for (let column = 0; column < SAMPLES; column += 1)
    heights[row * SAMPLES + column] = valley(column * SPACING - HALF, row * SPACING - HALF);

const terrain = new Terrain({
  width: SAMPLES,
  depth: SAMPLES,
  spacingM: SPACING,
  heights,
  origin: [-HALF, 0, -HALF],
});
// #endregion

// #region script
/** The valley's rules, hosted. The flight is a record the page holds, so an edit keeps it flying. */
const ground = hostScript(groundScript);
interface Flight {
  angle: number;
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
}
const flight = exported<() => Flight>(ground, 'createFlight')();
type Rule<T> = (field: Terrain, x: number, z: number) => T;
type Glide = (flight: Flight, field: Terrain, dt: number) => void;
// #endregion

// #region paint
/** Grass, rock and snow, weighted across the field by what the script says each place is. */
const WEIGHTS_ACROSS = 513;
const GRASS: Vec3 = [0.25, 0.38, 0.16];
const ROCK: Vec3 = [0.4, 0.38, 0.35];
const SNOW: Vec3 = [0.86, 0.88, 0.92];

function paintGround(): TerrainMaterials {
  const rockiness = exported<Rule<number>>(ground, 'rockiness');
  const snowiness = exported<Rule<number>>(ground, 'snowiness');
  const weights = new Float32Array(WEIGHTS_ACROSS * WEIGHTS_ACROSS * 3);
  const step = (2 * HALF) / (WEIGHTS_ACROSS - 1);
  for (let row = 0; row < WEIGHTS_ACROSS; row += 1) {
    for (let column = 0; column < WEIGHTS_ACROSS; column += 1) {
      const x = column * step - HALF;
      const z = row * step - HALF;
      const rock = rockiness(terrain, x, z);
      const snow = snowiness(terrain, x, z);
      const at = (row * WEIGHTS_ACROSS + column) * 3;
      weights[at] = Math.max(0, 1 - rock - snow);
      weights[at + 1] = rock;
      weights[at + 2] = snow;
    }
  }
  return new TerrainMaterials({
    materials: [{ color: GRASS }, { color: ROCK, specular: 0.15 }, { color: SNOW, specular: 0.4 }],
    width: WEIGHTS_ACROSS,
    depth: WEIGHTS_ACROSS,
    weights,
  });
}
// #endregion

// #region forest
/** One fir, drawn as many times as the script lets trees grow. */
const fir = renderer.createMesh(
  new MeshBuilder()
    .addCylinder([0, 1.2, 0], 0.22, 1.2, 'y', [0.3, 0.22, 0.16])
    .addCapsule([0, 4, 0], 1.7, 1.2, [0.16, 0.27, 0.15])
    .addCapsule([0, 6.6, 0], 1.1, 0.9, [0.18, 0.3, 0.16])
    .build(),
);
const TREE_SPACING = 9;
const TREES_ACROSS = Math.floor((2 * HALF) / TREE_SPACING);
const trees = createMeshInstances(TREES_ACROSS * TREES_ACROSS);
const forest = renderer.createInstanced(fir, trees.capacity, { cull: true });

function plantForest(): void {
  const grows = exported<Rule<boolean>>(ground, 'grows');
  trees.count = 0;
  for (let row = 0; row < TREES_ACROSS; row += 1) {
    for (let column = 0; column < TREES_ACROSS; column += 1) {
      const seed = row * TREES_ACROSS + column;
      const x = (column + hashToUnit(seed * 2)) * TREE_SPACING - HALF;
      const z = (row + hashToUnit(seed * 2 + 1)) * TREE_SPACING - HALF;
      if (!grows(terrain, x, z)) continue;
      const scale = 0.7 + hashToUnit(seed * 3 + 7) * 0.6;
      /* Sunk a little, so a trunk on a slope meets the ground on its downhill side too. */
      const o = trees.count * 16;
      trees.models.fill(0, o, o + 16);
      trees.models[o] = scale;
      trees.models[o + 5] = scale;
      trees.models[o + 10] = scale;
      trees.models[o + 12] = x;
      trees.models[o + 13] = terrain.heightAt(x, z) - 0.3;
      trees.models[o + 14] = z;
      trees.models[o + 15] = 1;
      const shade = 0.8 + hashToUnit(seed * 5 + 3) * 0.4;
      trees.tints.set([shade, shade, shade], trees.count * 3);
      trees.count += 1;
    }
  }
  renderer.uploadInstanced(forest, trees);
}
// #endregion

let materials = paintGround();
plantForest();

/** The switches: how the levels are painted, how many cells a patch has, and how many levels. */
const LEVEL_COLOURS: Vec3[] = [
  [0.85, 0.42, 0.25],
  [0.85, 0.75, 0.3],
  [0.35, 0.7, 0.35],
  [0.3, 0.55, 0.85],
  [0.6, 0.4, 0.8],
];
let paint = flag('paint', 'ground');
let cells = Math.min(16, Math.max(4, Math.round(flagNumber('cells', 8))));
let levels = Math.min(5, Math.max(3, Math.round(flagNumber('levels', 4))));
let stale = true;
controls([
  {
    key: 'paint',
    label: 'paint',
    value: paint,
    options: ['ground', 'levels'].map((p) => ({ text: p, value: p })),
    change: (value) => {
      paint = value;
      stale = true;
    },
  },
  {
    key: 'cells',
    label: 'patch cells',
    value: String(cells),
    options: ['4', '8', '16'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      cells = Number(value);
      stale = true;
    },
  },
  {
    key: 'levels',
    label: 'levels',
    value: String(levels),
    options: ['3', '4', '5'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      levels = Number(value);
      stale = true;
    },
  },
]);

if (import.meta.hot) {
  import.meta.hot.accept('./ground.drs', (next) => {
    if (next === undefined) return;
    patchModule(ground, next as Record<string, unknown>, { Flight: [flight] });
    /* New rules: repaint the ground and replant the forest with them. */
    materials = paintGround();
    plantForest();
    stale = true;
  });
}

// #region clipmap
/** The ground the camera is over, as one mesh rebuilt only when a level's block moves. */
let groundMesh: MeshHandle | null = null;
let shown: ClipmapFrame | null = null;
let shownPatchX = Number.NaN;
let shownPatchZ = Number.NaN;

/** One selected patch, painted by its level or by the ground's materials. */
function patchFor(options: HeightfieldPatchOptions, level: number): HeightfieldPatchOptions {
  return paint === 'levels'
    ? { ...options, color: LEVEL_COLOURS[level] ?? [1, 1, 1] }
    : { ...options, materials };
}

function chooseGround(cameraX: number, cameraZ: number): void {
  /* A block snaps to whole patches, so nothing can move until the camera crosses one. */
  const patchX = Math.floor(cameraX / (cells * SPACING));
  const patchZ = Math.floor(cameraZ / (cells * SPACING));
  if (!stale && patchX === shownPatchX && patchZ === shownPatchZ) return;
  shownPatchX = patchX;
  shownPatchZ = patchZ;

  const frame = clipmapFrame(terrain, cameraX, cameraZ, { levels, patchCells: cells });
  const moved = shown === null || frame.origins.some((origin, i) => origin !== shown?.origins[i]);
  if (!stale && !moved) return;
  shown = frame;
  stale = false;

  const patches = selectClipmap(frame).map((patch) =>
    heightfieldPatch(terrain, patchFor(clipmapPatchOptions(patch), patch.level)),
  );
  const next = renderer.createMesh(concatMeshes(patches));
  if (groundMesh !== null) renderer.disposeMesh(groundMesh);
  groundMesh = next;
}
// #endregion

const HORIZON: Vec3 = [0.66, 0.74, 0.84];
const env = createEnvironment({
  directionalDir: [-0.55, 0.5, -0.4],
  directionalColor: [2.1, 1.95, 1.75],
  ambient: [0.32, 0.38, 0.48],
  ambientGround: [0.14, 0.13, 0.11],
  fogColor: HORIZON,
  fogDensity: 0.0012,
  fogHeightFalloff: 0.004,
});
const sky: SkyColors = {
  top: [0.22, 0.4, 0.7],
  horizon: HORIZON,
  deep: [0.3, 0.36, 0.42],
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
};

/** The river, as the endless water at its level: it shows wherever the valley floor dips below. */
const river = renderer.createWater();
const riverBody: WaterBody = {
  level: 0.6,
  deepColor: [0.04, 0.09, 0.1],
  shallowColor: [0.1, 0.2, 0.2],
  density: 0.8,
  waveScale: 0.15,
};

const still = new SceneNode();
still.updateWorld();
const casters: ShadowCasters = (sink) => {
  if (groundMesh !== null) sink.mesh(groundMesh, still.worldMatrix);
  sink.instanced?.(forest, trees);
};
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;

let time = 0;
stage.run({
  simulate(dt) {
    time += dt;
    exported<Glide>(ground, 'glide')(flight, terrain, dt);
  },
  render() {
    camera.fovYDeg = 60;
    camera.near = 0.5;
    camera.far = 2400;
    camera.position[0] = flight.x;
    camera.position[1] = flight.y;
    camera.position[2] = flight.z;
    camera.lookAt(flight.lookX, flight.lookY, flight.lookZ);
    chooseGround(flight.x, flight.z);

    /* The sun's map covers the ground between the camera and where it looks. */
    env.shadowDepthSpan = computeLightMatrix(
      env.directionalDir,
      (flight.x + flight.lookX) / 2,
      flight.lookY,
      (flight.z + flight.lookZ) / 2,
      120,
      renderer.shadowMapSize,
      lightMatrix,
    );
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();

    renderer.beginFrame(HORIZON);
    renderer.bindMeshPass(camera, env);
    renderer.drawSceneCasters(casters);
    renderer.drawSky(camera, sky, env);
    renderer.drawWater(river, camera, time, riverBody, env, 1, 0.5);
    renderer.endFrame();
  },
});
