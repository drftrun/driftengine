/**
 * A street of buildings made of three pieces: a box, a column and a sphere, each placed thousands
 * of times at its own size and in its own paint.
 *
 * The street is a `DrftAssembly`, the form a `.drft` carries a mesh built from a kit in: one entry
 * a copy, naming its piece, its paint and the matrix that places it. `expandAssembly` turns that
 * into the mesh it describes, by arithmetic. The figures say what the street weighs both ways.
 *
 * How tall each building is, how wide, and whether it has an arcade or a dome are rules in
 * `street.drs`; save a change to them and the street is built again from the same kit.
 */
import { MeshBuilder, createEnvironment } from '@driftengine/core';
import type { MeshData, MeshHandle, Vec3 } from '@driftengine/core';
import {
  COPY_MATRIX_FLOATS,
  COPY_UV_FLOATS,
  SURFACE,
  SURFACE_FLOATS,
  expandAssembly,
} from '@driftengine/drft';
import type { DrftAssembly } from '@driftengine/drft';
import { patchModule } from 'driftscript';
import { createReadout } from '../common/readout';
import { exported, hostScript } from '../common/script';
import { controls, flag, openStage } from '../common/stage';
import * as streetScript from './street.drs';

const stage = await openStage({ outputTransform: 'aces', sceneSamples: 4 });
const { renderer, camera } = stage;

// #region kit
/** The kit: three unit pieces. Their own colours are ignored; a copy's surface paints it. */
const WHITE: Vec3 = [1, 1, 1];
const PIECES: MeshData[] = [
  new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], WHITE).build(),
  new MeshBuilder().addCylinder([0, 0, 0], 0.5, 0.5, 'y', WHITE, 0, 12).build(),
  new MeshBuilder().addSphere([0, 0, 0], 0.5, WHITE, 0, 16, 8).build(),
];
const BOX = 0;
const COLUMN = 1;
const SPHERE = 2;

/** The surfaces a copy can wear: four wall paints, glass, stone, copper and the road. */
const PAINTS: [Vec3, number][] = [
  [[0.78, 0.66, 0.52], 0],
  [[0.7, 0.52, 0.42], 0],
  [[0.82, 0.78, 0.68], 0],
  [[0.58, 0.6, 0.62], 0],
  [[0.12, 0.15, 0.2], 0.7],
  [[0.86, 0.84, 0.8], 0.1],
  [[0.36, 0.6, 0.5], 0.4],
  [[0.22, 0.22, 0.24], 0],
  /* And one per piece, for painting the street by which piece each copy is. */
  [[1, 0.5, 0.25], 0],
  [[1, 0.85, 0.3], 0],
  [[0.35, 0.6, 1], 0],
];
const GLASS = 4;
const STONE = 5;
const COPPER = 6;
const ROAD = 7;
const BY_PIECE = 8;
const surfaces = new Float32Array(PAINTS.length * SURFACE_FLOATS);
PAINTS.forEach(([colour, specular], i) => {
  surfaces.set(colour, i * SURFACE_FLOATS + SURFACE.color);
  surfaces[i * SURFACE_FLOATS + SURFACE.specular] = specular;
});
// #endregion

/** The street's rules, hosted, and the building they describe for one lot. */
const street = hostScript(streetScript);
const rule = <T>(name: string): ((lot: number) => T) => exported<(lot: number) => T>(street, name);

// #region copies
/** Copies collected for one street, before they become an assembly. */
const pieces: number[] = [];
const surfaceOf: number[] = [];
const transforms: number[] = [];
let paintByPiece = flag('paint', 'surfaces') === 'pieces';

/** One copy: a piece, a surface, and a box it fills, from its centre and its size on each axis. */
function place(piece: number, surface: number, centre: Vec3, size: Vec3): void {
  pieces.push(piece);
  surfaceOf.push(paintByPiece ? BY_PIECE + piece : surface);
  /* Three columns of the linear part, then the translation: a scale and a move. */
  transforms.push(size[0], 0, 0, 0, size[1], 0, 0, 0, size[2], centre[0], centre[1], centre[2]);
}

/** Lots down both sides of the street, each a building the rules describe. */
function buildStreet(lots: number): DrftAssembly {
  pieces.length = 0;
  surfaceOf.length = 0;
  transforms.length = 0;
  const storeys = rule<number>('storeys');
  const bays = rule<number>('bays');
  const arcaded = rule<boolean>('arcaded');
  const domed = rule<boolean>('domed');
  const paint = rule<number>('paint');
  const along = [0, 0];
  for (let lot = 0; lot < lots; lot += 1) {
    const side = lot % 2 === 0 ? -1 : 1;
    const width = bays(lot) * 3.2 + 1.6;
    const height = (storeys(lot) + 1) * 3.4;
    const z = (along[lot % 2] ?? 0) + width / 2;
    along[lot % 2] = z + width / 2 + 0.6;
    const front = side * 7;
    const middle = side * 13;
    const wall = paint(lot);
    place(BOX, wall, [middle, height / 2, z], [12, height, width]);
    place(BOX, STONE, [middle, height + 0.25, z], [12.6, 0.5, width + 0.3]);
    for (let floor = 1; floor <= storeys(lot); floor += 1) {
      for (let bay = 0; bay < bays(lot); bay += 1) {
        const across = z - width / 2 + 2.4 + bay * 3.2;
        place(BOX, GLASS, [front - side * 0.05, floor * 3.4 + 1.7, across], [0.2, 1.8, 1.4]);
      }
    }
    if (arcaded(lot)) {
      for (let column = 0; column <= bays(lot); column += 1) {
        const across = z - width / 2 + 0.8 + column * 3.2;
        place(COLUMN, STONE, [front - side * 1.6, 1.7, across], [0.5, 3.4, 0.5]);
      }
      place(BOX, STONE, [front - side * 1.2, 3.6, z], [2.8, 0.4, width]);
    }
    if (domed(lot)) place(SPHERE, COPPER, [middle, height + 0.5, z], [7, 7, 7]);
  }
  const length = Math.max(along[0] ?? 0, along[1] ?? 0);
  place(BOX, ROAD, [0, -0.1, length / 2], [60, 0.2, length + 40]);

  const copies = pieces.length;
  /* A stretch of one along each piece axis and no offset: untextured, so it changes nothing. */
  const uv = new Float32Array(copies * COPY_UV_FLOATS);
  for (let c = 0; c < copies; c += 1) uv.set([1, 1, 1, 1, 1, 1, 0, 0], c * COPY_UV_FLOATS);
  return {
    attributes: 0,
    surfaces,
    pieces: Uint32Array.from(pieces),
    surfaceOf: Uint32Array.from(surfaceOf),
    transforms: Float32Array.from(transforms),
    uv,
  };
}
// #endregion

// #region expand
/** The street as a mesh, built again whenever the rules, the length or the paint change. */
let mesh: MeshHandle | null = null;
const readout = createReadout(renderer, 2);
let lots = Number(flag('lots', '128'));

function rebuild(): void {
  const assembly = buildStreet(lots);
  const expanded = expandAssembly(assembly, (ordinal) => PIECES[ordinal] as MeshData);
  const next = renderer.createMesh(expanded);
  if (mesh !== null) renderer.disposeMesh(mesh);
  mesh = next;

  const copies = assembly.pieces.length;
  /* What the file would carry: a surface table, then 88 bytes a copy. */
  const placed =
    12 + surfaces.byteLength + copies * (8 + (COPY_MATRIX_FLOATS + COPY_UV_FLOATS) * 4);
  const vertices =
    expanded.positions.byteLength +
    expanded.normals.byteLength +
    expanded.colors.byteLength +
    expanded.emissive.byteLength +
    (expanded.specular?.byteLength ?? 0) +
    expanded.indices.byteLength;
  readout.set(0, `${copies} COPIES OF ${PIECES.length} PIECES`);
  readout.set(
    1,
    `PLACEMENTS ${(placed / 1e6).toFixed(2)} MB  EXPANDED ${(vertices / 1e6).toFixed(2)} MB`,
  );
}
// #endregion

rebuild();
if (import.meta.hot) {
  import.meta.hot.accept('./street.drs', (next) => {
    if (next === undefined) return;
    patchModule(street, next as Record<string, unknown>, {});
    rebuild();
  });
}

controls([
  {
    key: 'lots',
    label: 'lots',
    value: String(lots),
    options: ['16', '128', '512'].map((n) => ({ text: n, value: n })),
    change: (value) => {
      lots = Number(value);
      rebuild();
    },
  },
  {
    key: 'paint',
    label: 'paint',
    value: paintByPiece ? 'pieces' : 'surfaces',
    options: ['surfaces', 'pieces'].map((p) => ({ text: p, value: p })),
    change: (value) => {
      paintByPiece = value === 'pieces';
      rebuild();
    },
  },
]);

const HAZE: Vec3 = [0.7, 0.74, 0.8];
const env = createEnvironment({
  directionalDir: [0.5, 0.7, -0.3],
  directionalColor: [1.9, 1.8, 1.6],
  ambient: [0.34, 0.37, 0.44],
  ambientGround: [0.16, 0.15, 0.14],
  fogColor: HAZE,
  fogDensity: 0.004,
});
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

let time = 0;
stage.run({
  simulate(dt) {
    time += dt;
  },
  render() {
    camera.fovYDeg = 55;
    camera.far = 1500;
    camera.position[0] = Math.sin(time * 0.15) * 3;
    camera.position[1] = 9;
    camera.position[2] = -18;
    camera.lookAt(0, 6, 120);
    renderer.beginFrame(HAZE);
    renderer.bindMeshPass(camera, env);
    if (mesh !== null) renderer.drawMesh(mesh, IDENTITY);
    readout.draw(time);
    renderer.endFrame();
  },
});
