import { expect, test } from 'vitest';
import { streamDrft } from './drftStream.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { DrftSource } from './drftWrite.ts';
import { CHUNK_ENTRY_BYTES, CHUNK_REQUIRED, HEADER_BYTES, fourCC } from './drftFormat.ts';
import type { MeshData } from './meshData.ts';
import type { DrftRegion } from './drftRegions.ts';

/**
 * A world written a region at a time: each region's chunk names the meshes it draws at every level,
 * the props it places, the boxes that hide what is behind them and the triangles it collides as,
 * and lands just ahead of the meshes it introduces.
 *
 * Six meshes: 0 belongs to no region; region 10 draws 1 and 2 at its finest and 3 at its coarser
 * level, and places two copies of 4; region 11 draws 5 and places one copy of the same 4, which is
 * what a prop shared across districts is.
 */
function triangle(x: number): MeshData {
  return {
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

const at = (x: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

const REGION_10: DrftRegion = {
  id: 10,
  bounds: [0, 0, 0, 100, 20, 100],
  levels: [
    { error: 0, meshes: [1, 2] },
    { error: 1.5, meshes: [3] },
  ],
  instances: [{ mesh: 4, transforms: new Float32Array([...at(5), ...at(25)]) }],
  occluders: new Float32Array([10, 0, 10, 30, 20, 30]),
  collision: {
    positions: new Float32Array([0, 0, 0, 100, 0, 0, 100, 0, 100, 0, 0, 100]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  },
};

const REGION_11: DrftRegion = {
  id: 11,
  bounds: [100, 0, 0, 200, 20, 100],
  levels: [{ error: 0, meshes: [5] }],
  instances: [{ mesh: 4, transforms: new Float32Array(at(150)) }],
  occluders: new Float32Array(0),
  collision: null,
};

function world(overrides: Partial<DrftSource> = {}): ArrayBuffer {
  return writeDrft({
    head: { name: 'regions' },
    meshes: [0, 1, 2, 3, 4, 5].map((x) => triangle(x)),
    regions: [REGION_10, REGION_11],
    ...overrides,
  });
}

test('A REGION ROUND-TRIPS WHOLE: its levels, its props, its occluders and its collision', () => {
  const regions = readDrft(world()).regions;
  expect(regions).toHaveLength(2);
  const [ten, eleven] = regions;
  expect(ten?.id).toBe(10);
  expect(Array.from(ten?.bounds ?? [])).toEqual([0, 0, 0, 100, 20, 100]);
  expect(ten?.levels).toEqual([
    { error: 0, meshes: [1, 2] },
    { error: 1.5, meshes: [3] },
  ]);
  expect(ten?.instances[0]?.mesh).toBe(4);
  expect(Array.from(ten?.instances[0]?.transforms ?? []).filter((_, i) => i % 16 === 12)).toEqual([
    5, 25,
  ]);
  expect(Array.from(ten?.occluders ?? [])).toEqual([10, 0, 10, 30, 20, 30]);
  expect(Array.from(ten?.collision?.indices ?? [])).toEqual([0, 2, 1, 0, 3, 2]);
  expect(ten?.collision?.positions[6]).toBe(100);
  expect(eleven?.collision, 'a region with no triangles reads back as none').toBeNull();
  expect(eleven?.instances[0]?.mesh, 'and shares its prop with region 10').toBe(4);
});

test('A STREAM HANDS OVER EACH REGION BEFORE THE MESHES IT INTRODUCES, and the chunk is required', async () => {
  const bytes = world();
  const order: string[] = [];
  await streamDrft(new Response(bytes), {
    onRegion: (region) => order.push(`region ${region.id}`),
    onMesh: (_mesh, ordinal) => order.push(`mesh ${ordinal}`),
  });
  expect(order).toEqual([
    'mesh 0',
    'region 10',
    'mesh 1',
    'mesh 2',
    'mesh 3',
    'mesh 4',
    'region 11',
    'mesh 5',
  ]);

  /* Required, so a reader before 1.21 refuses the file by name rather than drawing every level. */
  const view = new DataView(bytes);
  const count = view.getUint32(12, true);
  let flagged = 0;
  for (let i = 0; i < count; i++) {
    const entry = HEADER_BYTES + i * CHUNK_ENTRY_BYTES;
    if (view.getUint32(entry, true) !== fourCC('REGN')) continue;
    expect(view.getUint16(entry + 12, true) & CHUNK_REQUIRED).toBe(CHUNK_REQUIRED);
    flagged++;
  }
  expect(flagged).toBe(2);
});

test('the writer refuses meshes out of region order, a mesh two regions draw, and one INST also places', () => {
  expect(() => world({ regions: [REGION_11, REGION_10] }), 'region 11 first').toThrow(
    /introduces mesh/,
  );
  expect(
    () =>
      world({ regions: [{ ...REGION_11, levels: [{ error: 0, meshes: [0] }], instances: [] }] }),
    'a region mesh ahead of one no region names',
  ).toThrow(/no region names first/);
  expect(
    () => world({ regions: [REGION_10, { ...REGION_11, levels: [{ error: 0, meshes: [3, 5] }] }] }),
    'mesh 3 drawn by two regions',
  ).toThrow(/one region's one level/);
  expect(
    () => world({ instances: [{ mesh: 4, transforms: new Float32Array(at(0)) }] }),
    'mesh 4 placed file-wide as well',
  ).toThrow(/INST/);
  expect(
    () =>
      world({
        regions: [
          {
            ...REGION_10,
            levels: [
              { error: 2, meshes: [1, 2] },
              { error: 1, meshes: [3] },
            ],
          },
          REGION_11,
        ],
      }),
    'a coarser level with a smaller error',
  ).toThrow(/finer than the one before/);
});
