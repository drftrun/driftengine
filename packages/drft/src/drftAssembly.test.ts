import { expect, test } from 'vitest';

import { SURFACE, SURFACE_FLOATS } from './drftAssembly.ts';
import type { DrftAssembly } from './drftAssembly.ts';
import {
  ATTR_TANGENT,
  ATTR_UVS,
  CHUNK_ENTRY_BYTES,
  CHUNK_REQUIRED,
  HEADER_BYTES,
  fourCC,
} from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { streamDrft } from './drftStream.ts';
import { writeDrft } from './drftWrite.ts';
import type { DrftSource } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/**
 * A world built from a kit of one piece: a unit quad at the origin (mesh 0), a triangle nobody
 * copies (mesh 1), and mesh 2 assembled from two copies of the quad, ten and twenty along x, which
 * region 5 draws. The quad itself stands nowhere.
 */
const QUAD: MeshData = {
  positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array(12),
  emissive: new Float32Array(4),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

const TRIANGLE: MeshData = {
  positions: new Float32Array([1, 0, 0, 2, 0, 0, 1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
  emissive: new Float32Array(3),
  indices: new Uint32Array([0, 1, 2]),
};

const moved = (x: number): number[] => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, 0, 0];

const ASSEMBLY: DrftAssembly = {
  attributes: ATTR_UVS | ATTR_TANGENT,
  /* Grey, at layer 0. */
  surfaces: new Float32Array(SURFACE_FLOATS).fill(0.5).fill(0, SURFACE.layer, SURFACE.layer + 1),
  pieces: new Uint32Array([0, 0]),
  surfaceOf: new Uint32Array([0, 0]),
  transforms: new Float32Array([...moved(10), ...moved(20)]),
  uv: new Float32Array([1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0]),
};

function world(overrides: Partial<DrftSource> = {}): ArrayBuffer {
  return writeDrft({
    head: { name: 'kit' },
    meshes: [QUAD, TRIANGLE, ASSEMBLY],
    kit: [0],
    regions: [
      {
        id: 5,
        bounds: [9, -1, -1, 21, 1, 1],
        levels: [{ error: 0, meshes: [2] }],
        instances: [],
        occluders: new Float32Array(0),
        collision: null,
      },
    ],
    ...overrides,
  });
}

test('A KIT ROUND-TRIPS: THE WHOLE-FILE READER EXPANDS EACH ASSEMBLY IN ITS SLOT, AND BOUNDS COUNT COPIES, NOT PIECES', () => {
  const asset = readDrft(world());
  expect(asset.kit).toEqual([0]);
  const carried = asset.assemblies.get(2);
  expect(Array.from(carried?.pieces ?? [])).toEqual([0, 0]);
  expect(Array.from(carried?.transforms ?? [])).toEqual([...moved(10), ...moved(20)]);
  const mesh = asset.meshes[2];
  /* Two quads: the first corner of each at (9.5, −0.5) and (19.5, −0.5). */
  expect(mesh?.positions.length).toBe(8 * 3);
  expect(Array.from(mesh?.positions.subarray(0, 3) ?? [])).toEqual([9.5, -0.5, 0]);
  expect(Array.from(mesh?.positions.subarray(12, 15) ?? [])).toEqual([19.5, -0.5, 0]);
  expect(Array.from(mesh?.indices ?? [])).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  /* The triangle spans x 1..2 and y 0..1, the copies x 9.5..20.5 and y −0.5..0.5; the piece at
     the origin is drawn nowhere and must not pull the minimum to −0.5. */
  expect(asset.head.bounds).toEqual([1, -0.5, 0, 20.5, 1, 0]);
});

test('A STREAM NAMES THE KIT FIRST, HANDS EACH PIECE TO onPiece, AND AN ASSEMBLY OVER SMALL — OR EXPANDED TO A CONSUMER THAT DID NOT ASK', async () => {
  const bytes = world();
  const order: string[] = [];
  await streamDrft(new Response(bytes), {
    onKit: (pieces) => order.push(`kit ${pieces.join(',')}`),
    onPiece: (_mesh, ordinal) => order.push(`piece ${ordinal}`),
    onMesh: (_mesh, ordinal) => order.push(`mesh ${ordinal}`),
    onRegion: (region) => order.push(`region ${region.id}`),
    onAssembly: (assembly, ordinal, piece) =>
      order.push(
        `assembly ${ordinal} of ${assembly.pieces.length} copies of ${piece(0).indices.length / 3} triangles`,
      ),
  });
  expect(order).toEqual([
    'kit 0',
    'piece 0',
    'mesh 1',
    'region 5',
    'assembly 2 of 2 copies of 2 triangles',
  ]);

  const meshes = new Map<number, MeshData>();
  await streamDrft(new Response(bytes), { onMesh: (mesh, ordinal) => meshes.set(ordinal, mesh) });
  expect([...meshes.keys()], 'the piece never reaches onMesh').toEqual([1, 2]);
  expect(Array.from(meshes.get(2)?.positions.subarray(0, 3) ?? [])).toEqual([9.5, -0.5, 0]);

  /* Both required, so a reader before 1.23 refuses the file by name rather than drawing the kit at
     the origin and nothing where the copies stand. */
  const view = new DataView(bytes);
  const flags = new Map<string, number>();
  for (let i = 0; i < view.getUint32(12, true); i++) {
    const entry = HEADER_BYTES + i * CHUNK_ENTRY_BYTES;
    for (const code of ['KITS', 'MSHC']) {
      if (view.getUint32(entry, true) === fourCC(code)) {
        flags.set(code, view.getUint16(entry + 12, true) & CHUNK_REQUIRED);
      }
    }
  }
  expect(Object.fromEntries(flags)).toEqual({ KITS: CHUNK_REQUIRED, MSHC: CHUNK_REQUIRED });
});

test('the writer refuses a copy of a mesh the kit does not name, a piece after its assembly, a piece drawn some other way, and a textured copy of a piece without tangents', () => {
  expect(() => world({ kit: [] }), 'no kit').toThrow(/does not name a piece/);
  expect(
    () =>
      world({
        meshes: [TRIANGLE, { ...ASSEMBLY, pieces: new Uint32Array([2, 2]) }, QUAD],
        kit: [2],
        regions: [],
      }),
    'the piece written last',
  ).toThrow(/comes after it/);
  expect(
    () => world({ instances: [{ mesh: 0, transforms: new Float32Array(16).fill(1) }] }),
    'the piece placed by INST too',
  ).toThrow(/kit piece and is placed by INST/);
  expect(
    () => world({ meshes: [{ ...QUAD, tangents: undefined }, TRIANGLE, ASSEMBLY] }),
    'a piece with no tangents',
  ).toThrow(/has none/);
  expect(
    () =>
      world({
        meshes: [
          QUAD,
          TRIANGLE,
          {
            ...ASSEMBLY,
            transforms: new Float32Array([...moved(10), 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0]),
          },
        ],
      }),
    'a copy flattened to nothing',
  ).toThrow(/flattened/);
});

test('A PIECE TRAVELS WITH THE FIRST REGION THAT COPIES IT, AHEAD OF ITS ASSEMBLY', async () => {
  /*
   * A kit of three quads: 0 copied by region 5 alone, 1 by both regions, 3 by region 6 alone.
   * Region 5 draws assembly 2 (pieces 0 and 1), region 6 assembly 4 (pieces 1 and 3). Each piece
   * is written with the first region that copies it, so a stream starting at region 5 has what it
   * draws without the rest of the kit.
   */
  const copies = (a: number, b: number): DrftAssembly => ({
    ...ASSEMBLY,
    pieces: new Uint32Array([a, b]),
  });
  const region = (
    id: number,
    mesh: number,
  ): DrftSource['regions'] extends readonly (infer R)[] | undefined ? R : never => ({
    id,
    bounds: [0, -1, -1, 30, 1, 1],
    levels: [{ error: 0, meshes: [mesh] }],
    instances: [],
    occluders: new Float32Array(0),
    collision: null,
  });
  const bytes = writeDrft({
    meshes: [QUAD, QUAD, copies(0, 1), QUAD, copies(1, 3)],
    kit: [0, 1, 3],
    regions: [region(5, 2), region(6, 4)],
  });
  const order: string[] = [];
  await streamDrft(new Response(bytes), {
    onRegion: (r) => order.push(`region ${r.id}`),
    onPiece: (_, ordinal) => order.push(`piece ${ordinal}`),
    onAssembly: (_, ordinal) => order.push(`assembly ${ordinal}`),
  });
  /* The first region's pieces lead the file, ahead of its chunk: the file's own, as ever. */
  expect(order).toEqual([
    'piece 0',
    'piece 1',
    'region 5',
    'assembly 2',
    'region 6',
    'piece 3',
    'assembly 4',
  ]);
  /* A whole read builds both from the same kit. */
  expect(readDrft(bytes).meshes[4]?.indices.length).toBe(12);
});
