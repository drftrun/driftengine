/**
 * A gatehouse built in code from closed solids and booleans: a wall with windows cut out of it, a
 * round tower with a doorway carved into its foot, a domed pavilion on a star-shaped plinth, an urn
 * turned on a lathe and a rail swept along a curve.
 *
 * Everything here is shape until the last step, when each solid is painted one colour and handed to
 * the renderer. The wall can be cut two ways, and the figures say what each costs: the box grid,
 * exact for boxes on the axes, or the general boolean. How many windows there are and how big each
 * row's are is decided in `wall.drs`.
 */
import {
  MeshBuilder,
  createEnvironment,
  computeLightMatrix,
  mergeSolids,
  smoothSolidNormals,
  solidBox,
  solidBoxBoolean,
  solidCapsule,
  solidCone,
  solidCylinder,
  solidExtrude,
  solidHemisphere,
  solidLathe,
  solidSubtract,
  solidSweep,
  solidToMesh,
  solidTorus,
  solidTube,
  solidVolume,
  transformSolid,
} from '@driftengine/core';
import type { BoxOperation, MeshHandle, ShadowCasters, Solid, Vec3 } from '@driftengine/core';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as wallScript from './wall.drs';

const stage = await openStage({
  directionalShadows: true,
  outputTransform: 'aces',
  sceneSamples: 4,
});
const { renderer, camera } = stage;

/** A matrix that moves a solid to `x, y, z`. */
const at = (x: number, y: number, z: number): number[] => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];

// #region primitives
/** A plinth: an eight-pointed star in plan, extruded up 0.6 metres. */
const star: number[] = [];
for (let i = 0; i < 16; i += 1) {
  const a = (i / 16) * Math.PI * 2;
  const r = i % 2 === 0 ? 6 : 4.6;
  star.push(Math.cos(a) * r, Math.sin(a) * r);
}
const plinth = solidExtrude(star, 0.6);

/** A pavilion on it: a ring of wall, a dome, and a torus where the two meet. */
const drum = transformSolid(solidTube(4, 0.4, 3, 32), at(0, 2.1, 0));
const dome = transformSolid(solidHemisphere(4.1, 32), at(0, 3.6, 0));
const band = transformSolid(solidTorus(4.15, 0.22, 48, 10), at(0, 3.6, 0));
const pavilion = transformSolid(mergeSolids([plinth, drum, band]), at(-17, 0, 2));
const roof = transformSolid(dome, at(-17, 0, 2));

/** An urn turned on a lathe from a profile of radius and height pairs, bottom to top. */
const urn = transformSolid(
  solidLathe([0.5, 0, 0.7, 0.2, 0.9, 0.9, 0.6, 1.5, 0.45, 1.8, 0.65, 2.1], 24),
  at(-9, 0, 6),
);

/** A rail swept along a curve in front of the wall: a small square section, both ends capped. */
const path: number[] = [];
for (let i = 0; i <= 24; i += 1) {
  const x = -12 + i;
  path.push(x, 1 + Math.sin(i * 0.25) * 0.15, 4 + Math.cos(i * 0.2) * 0.8);
}
const rail = solidSweep([-0.08, -0.08, 0.08, -0.08, 0.08, 0.08, -0.08, 0.08], path, true);
// #endregion

// #region doorway
/** A round tower with a doorway carved into its foot: a capsule taken out of a cylinder. */
const shaft = transformSolid(solidCylinder(3, 14, 32), at(16, 7, 0));
const arch = transformSolid(solidCapsule(1.1, 1.8, 24), at(16, 1.4, 3));
const tower = mergeSolids([
  solidSubtract(shaft, arch),
  transformSolid(solidCone(3.6, 4.5, 32), at(16, 16.25, 0)),
]);
// #endregion

// #region wall
/** The windows, as the script lays them out, cut out of a wall 24 metres long and 10.5 high. */
const layout = hostScript(wallScript);
type Rule<T> = (value: number) => T;

function openings(count: number): [number, number, number, number, number, number][] {
  const perRow = exported<Rule<number>>(layout, 'perRow')(count);
  const height = exported<Rule<number>>(layout, 'windowHeight');
  const width = exported<Rule<number>>(layout, 'windowWidth');
  const boxes: [number, number, number, number, number, number][] = [];
  let y = 1;
  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / perRow);
    const column = i % perRow;
    if (column === 0 && row > 0) y += height(row - 1) + 0.5;
    const x = -12 + (24 / perRow) * (column + 0.5);
    const w = width(row) / 2;
    boxes.push([x - w, y, -1, x + w, y + height(row), 1]);
  }
  return boxes;
}

/** Boxes on the three axes: exact over the grid of their coordinates, faces merged. */
function cutByGrid(holes: [number, number, number, number, number, number][]): Solid {
  const operations: BoxOperation[] = [{ box: [-12, 0, -0.3, 12, 10.5, 0.3], op: 'union' }];
  for (const box of holes) operations.push({ box, op: 'subtract' });
  return solidBoxBoolean(operations);
}

/** The general boolean: any closed solid from any other, one subtraction at a time. */
function cutByBsp(holes: [number, number, number, number, number, number][]): Solid {
  let wall = transformSolid(solidBox(24, 10.5, 0.6), at(0, 5.25, 0));
  for (const [x0, y0, z0, x1, y1, z1] of holes) {
    const hole = solidBox(x1 - x0, y1 - y0, z1 - z0);
    wall = solidSubtract(
      wall,
      transformSolid(hole, at((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)),
    );
  }
  return wall;
}
// #endregion

/** The switches: how many windows, which boolean cuts them, and how the round solids shade. */
let count = Number(flag('windows', '12'));
let method = flag('boolean', 'grid');
let smooth = flag('normals', 'smooth') === 'smooth';
const readout = createReadout(renderer, 2);

const STONE: Vec3 = [0.8, 0.66, 0.5];
const meshes: MeshHandle[] = [];
// #region paint
/** Every solid painted once and handed to the renderer; built again when a switch changes. */
function build(): void {
  for (const mesh of meshes) renderer.disposeMesh(mesh);
  meshes.length = 0;
  const holes = openings(count);
  const started = performance.now();
  const wall = method === 'grid' ? cutByGrid(holes) : cutByBsp(holes);
  const took = performance.now() - started;
  const shade = (solid: Solid): Solid => (smooth ? smoothSolidNormals(solid, 40) : solid);
  const paint = (solid: Solid, colour: Vec3): void => {
    meshes.push(renderer.createMesh(solidToMesh(shade(solid), colour)));
  };
  paint(wall, STONE);
  paint(tower, [0.66, 0.4, 0.32]);
  paint(pavilion, [0.86, 0.82, 0.74]);
  paint(roof, [0.32, 0.58, 0.5]);
  paint(urn, [0.5, 0.3, 0.2]);
  paint(rail, [0.2, 0.2, 0.24]);
  readout.set(0, `WALL ${wall.indices.length / 3} TRIANGLES IN ${took.toFixed(1)} MS`);
  readout.set(1, `VOLUME ${solidVolume(wall).toFixed(2)} CUBIC METRES`);
}
// #endregion
build();

if (import.meta.hot) {
  import.meta.hot.accept('./wall.drs', (next) => {
    if (next === undefined) return;
    patchModule(layout, next as Record<string, unknown>, {});
    build();
  });
}

controls([
  {
    key: 'windows',
    label: 'windows',
    value: String(count),
    options: ['4', '12', '40'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      count = Number(value);
      build();
    },
  },
  {
    key: 'boolean',
    label: 'boolean',
    value: method,
    options: [
      { text: 'box grid', value: 'grid' },
      { text: 'general', value: 'bsp' },
    ],
    change: (value) => {
      method = value;
      build();
    },
  },
  {
    key: 'normals',
    label: 'normals',
    value: smooth ? 'smooth' : 'faceted',
    options: ['smooth', 'faceted'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      smooth = value === 'smooth';
      build();
    },
  },
]);

const ground = renderer.createMesh(
  new MeshBuilder().addBox([0, -0.1, 0], [60, 0.1, 60], [0.36, 0.42, 0.3]).build(),
);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const env = createEnvironment({
  directionalDir: [-0.5, 0.65, 0.55],
  directionalColor: [2, 1.88, 1.7],
  ambient: [0.32, 0.36, 0.44],
  ambientGround: [0.16, 0.15, 0.13],
  fogColor: [0.68, 0.74, 0.82],
  fogDensity: 0.004,
});
const casters: ShadowCasters = (sink) => {
  sink.mesh(ground, IDENTITY);
  for (const mesh of meshes) sink.mesh(mesh, IDENTITY);
};
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 0.8;
env.shadowDepthSpan = computeLightMatrix(
  env.directionalDir,
  0,
  4,
  2,
  30,
  renderer.shadowMapSize,
  lightMatrix,
);

let time = 0;
stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    const angle = 0.35 + Math.sin(time * 0.12) * 0.45;
    camera.fovYDeg = 50;
    camera.position[0] = Math.sin(angle) * 40;
    camera.position[1] = 11;
    camera.position[2] = Math.cos(angle) * 40;
    camera.lookAt(0, 4, 0);
    renderer.beginShadowPass(lightMatrix, 'static');
    renderer.drawShadowCasters(casters);
    renderer.endShadowPass();
    renderer.beginFrame([0.68, 0.74, 0.82]);
    renderer.bindMeshPass(camera, env);
    renderer.drawSceneCasters(casters);
    readout.draw(time);
    renderer.endFrame();
  },
});
