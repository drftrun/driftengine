import { expect, test } from 'vitest';
import { SURFACE_FLOATS, writeDrft } from '@driftengine/drft';
import type { DrftMaterial, DrftRegion } from '@driftengine/drft';
import type { MeshData, RendererApi } from '@driftengine/core';
import { DrftLoader } from './drftLoader.ts';
import { RegionStore } from './regionStore.ts';
import type { DrftPart } from './loadProgress.ts';

/**
 * A streamed world's regions reach the caller whole and apart: every level's meshes, the props
 * batched from one prototype however many regions place it, the occluders and the collision — and
 * none of it among the model's `parts`, whose merge would weld a region's levels together.
 */

function fakeRenderer(batches: { mesh: unknown; capacity: number; cull: boolean }[]): RendererApi {
  let next = 1;
  return {
    createMesh: () => ({ id: next++ }),
    disposeMesh: () => {},
    createSurfaceTexture: () => ({ id: next++ }),
    updateSurfaceTexture: () => {},
    disposeSurfaceTexture: () => {},
    createInstanced: (mesh: unknown, capacity: number, options?: { cull?: boolean }) => {
      batches.push({ mesh, capacity, cull: options?.cull === true });
      return { id: next++, mesh, capacity };
    },
    uploadInstanced: () => {},
    disposeInstanced: () => {},
  } as unknown as RendererApi;
}

function triangle(x: number): MeshData {
  return {
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

function material(name: string): DrftMaterial {
  return {
    name,
    color: [1, 1, 1],
    specular: 0,
    roughness: 0.5,
    emissive: 0,
    emissiveColor: [0, 0, 0],
    opacity: 1,
    albedo: -1,
    normalMap: -1,
    ormMap: -1,
    emissiveMap: -1,
    roughnessScale: 1,
    metallicScale: 1,
    occlusionStrength: 0,
    reflectivity: 0,
    cutout: 0,
  };
}

const at = (x: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];

/* Mesh 0 is nobody's; region 10 draws 1 and 2, then 3 coarser, and places 4 twice; region 11
   draws 5 and places 4 once. */
const REGIONS: DrftRegion[] = [
  {
    id: 10,
    bounds: [0, 0, 0, 100, 20, 100],
    levels: [
      { error: 0, meshes: [1, 2] },
      { error: 2, meshes: [3] },
    ],
    instances: [{ mesh: 4, transforms: new Float32Array([...at(5), ...at(25)]) }],
    occluders: new Float32Array([10, 0, 10, 30, 20, 30]),
    collision: {
      positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 0, 100]),
      indices: new Uint32Array([0, 2, 1]),
    },
  },
  {
    id: 11,
    bounds: [100, 0, 0, 200, 20, 100],
    levels: [{ error: 0, meshes: [5] }],
    instances: [{ mesh: 4, transforms: new Float32Array(at(150)) }],
    occluders: new Float32Array(0),
    collision: null,
  },
];

test('A REGION ARRIVES WHOLE AND APART FROM THE PARTS, its prop batched from a prototype two regions share', async () => {
  const batches: { mesh: unknown; capacity: number; cull: boolean }[] = [];
  const loader = new DrftLoader(fakeRenderer(batches), {});
  const drft = writeDrft({
    head: { name: 'world' },
    meshes: [0, 1, 2, 3, 4, 5].map((x) => triangle(x)),
    materials: [0, 1, 2, 3, 4, 5].map((i) => material(`m${i}`)),
    regions: REGIONS,
  });
  await loader.consume(new Response(drft), { fit: 'none' });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);

  expect(loader.parts, 'only mesh 0 is a part of the model').toHaveLength(1);
  const ten = loader.regions.get(10);
  const eleven = loader.regions.get(11);
  expect(ten?.levels.map((level) => level.parts.length)).toEqual([2, 1]);
  expect(ten?.levels.map((level) => level.error)).toEqual([0, 2]);
  expect(eleven?.levels[0]?.parts).toHaveLength(1);
  expect([ten?.pending, eleven?.pending], 'both whole').toEqual([0, 0]);
  expect(ten?.batches[0]?.instances?.data.count).toBe(2);
  expect(eleven?.batches[0]?.instances?.data.models[12]).toBe(150);
  expect(batches, 'one batch a region, each culling').toHaveLength(2);
  expect(batches.every((batch) => batch.cull)).toBe(true);
  expect(batches[0]?.mesh, 'the same prototype serves both').toBe(batches[1]?.mesh);
  expect(Array.from(ten?.occluders ?? [])).toEqual([10, 0, 10, 30, 20, 30]);
  expect(Array.from(ten?.collision?.indices ?? [])).toEqual([0, 2, 1]);
  expect(eleven?.collision).toBeNull();
  expect(loader.progress.phase).toBe('ready');
});

test('A CONSUMER TAKING MESHES IS OFFERED ONLY THE ONES NO REGION HOLDS, and every region stays whole', async () => {
  const offered: number[] = [];
  const loader = new DrftLoader(fakeRenderer([]), {
    onMesh: (_mesh, ordinal) => {
      offered.push(ordinal);
      return true;
    },
  });
  const drft = writeDrft({
    head: { name: 'world' },
    meshes: [0, 1, 2, 3, 4, 5].map((x) => triangle(x)),
    materials: [0, 1, 2, 3, 4, 5].map((i) => material(`m${i}`)),
    regions: REGIONS,
  });
  await loader.consume(new Response(drft), { fit: 'none' });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);
  /* Mesh 0 is nobody's; the levels 1, 2, 3 and 5 and the prototype 4 are the regions'. */
  expect(offered).toEqual([0]);
  expect(loader.parts).toHaveLength(0);
  expect(loader.regions.get(10)?.levels.map((level) => level.parts.length)).toEqual([2, 1]);
  expect(loader.regions.get(10)?.batches[0]?.instances?.data.count).toBe(2);
});

test('a region naming a prop already up gets its batch at the next build, and a fit places it all', () => {
  const batches: { mesh: unknown; capacity: number; cull: boolean }[] = [];
  const fit = { scale: 2, x: 1, y: 0, z: 0 };
  const store = new RegionStore(fakeRenderer(batches), () => fit);
  store.admit(REGIONS[0] as DrftRegion);
  const prototype = { mesh: { id: 99 }, instances: null, reveal: 1 } as unknown as DrftPart;
  store.arrived(4, prototype);
  store.admit(REGIONS[1] as DrftRegion);
  expect(store.busy, "both regions' props are queued, none built outside a frame").toBe(true);
  while (store.buildNext());
  expect(batches.map((batch) => batch.mesh)).toEqual([{ id: 99 }, { id: 99 }]);

  const eleven = store.regions.get(11);
  /* Bounds are p · 2 + (1, 0, 0). A copy at x = 150 carries s · u = 300 and not the offset:
     the prototype it moves already stands at its fitted place, and t − R·t is 0 unturned. */
  expect(Array.from(eleven?.bounds ?? [])).toEqual([201, 0, 0, 401, 40, 200]);
  expect(eleven?.batches[0]?.instances?.data.models[12]).toBe(300);
  expect(store.regions.get(10)?.levels[1]?.error, 'an error is a length, so it scales').toBe(4);
  expect(Array.from(store.regions.get(10)?.occluders ?? []).slice(0, 3)).toEqual([21, 0, 20]);
});

test('A LEVEL THAT ARRIVES AS COPIES IS PAGED: HELD SMALL, UP ONLY WHEN ASKED, IN A LATER FRAME, AND FREED WHEN LET GO', async () => {
  /* Mesh 0 is a kit piece — a quad, four vertices, so its upload would show — mesh 1 nobody's;
     region 7's finest level is mesh 2, two copies of the piece, and its coarser one mesh 3. */
  const quad: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(12),
    emissive: new Float32Array(4),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const created: number[] = [];
  const disposed: unknown[] = [];
  let next = 1;
  const renderer = {
    ...fakeRenderer([]),
    createMesh: (data: MeshData) => {
      created.push(data.positions.length / 3);
      return { id: next++ };
    },
    disposeMesh: (mesh: unknown) => {
      disposed.push(mesh);
    },
  } as unknown as RendererApi;
  const loader = new DrftLoader(renderer, {});
  const moved = (x: number): number[] => [1, 0, 0, 0, 1, 0, 0, 0, 1, x, 0, 0];
  const drft = writeDrft({
    head: { name: 'kit' },
    meshes: [
      quad,
      triangle(1),
      {
        attributes: 0,
        surfaces: new Float32Array(SURFACE_FLOATS),
        pieces: new Uint32Array([0, 0]),
        surfaceOf: new Uint32Array([0, 0]),
        transforms: new Float32Array([...moved(10), ...moved(20)]),
        uv: new Float32Array([1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0]),
      },
      triangle(3),
    ],
    materials: [0, 1, 2, 3].map((i) => material(`m${i}`)),
    kit: [0],
    regions: [
      {
        id: 7,
        bounds: [0, 0, 0, 30, 1, 1],
        levels: [
          { error: 0, meshes: [2] },
          { error: 4, meshes: [3] },
        ],
        instances: [],
        occluders: new Float32Array(0),
        collision: null,
      },
    ],
  });
  await loader.consume(new Response(drft), { fit: 'none' });
  for (let frame = 0; frame < 16; frame++) loader.update(1 / 60);

  const seven = loader.regions.get(7);
  const fine = seven?.levels[0];
  expect(loader.parts, 'the piece is not a part; mesh 1 is').toHaveLength(1);
  /* Three-vertex uploads only: mesh 1, its merged group and the coarse level. */
  expect(
    created.every((vertices) => vertices === 3),
    'neither the piece (4) nor the copies (8) uploaded',
  ).toBe(true);
  const before = created.length;
  expect([fine?.paged, fine?.resident, fine?.parts.length]).toEqual([true, false, 0]);
  expect([seven?.levels[1]?.resident, seven?.pending]).toEqual([true, 0]);
  expect([loader.progress.partsTotal, loader.progress.phase]).toEqual([3, 'ready']);

  loader.pageRegion(7, 0, true);
  expect(created, 'nothing expanded inside the call').toHaveLength(before);
  for (let frame = 0; frame < 4; frame++) loader.update(1 / 60);
  expect(created.slice(before), 'two copies of the four-vertex piece').toEqual([8]);
  expect([fine?.resident, fine?.parts.length]).toEqual([true, 1]);

  const up = fine?.parts[0]?.mesh;
  const freed = disposed.length;
  loader.pageRegion(7, 0, false);
  expect(disposed.slice(freed)).toEqual([up]);
  expect([fine?.resident, fine?.parts.length]).toEqual([false, 0]);

  /* Asked for and let go before a frame ran: nothing is built. */
  loader.pageRegion(7, 0, true);
  loader.pageRegion(7, 0, false);
  for (let frame = 0; frame < 4; frame++) loader.update(1 / 60);
  expect(created).toHaveLength(before + 1);
});

test('a paged mesh that lands after it was let go is freed rather than drawn', () => {
  const disposed: unknown[] = [];
  const store = new RegionStore(
    {
      ...fakeRenderer([]),
      disposeMesh: (mesh: unknown) => disposed.push(mesh),
    } as unknown as RendererApi,
    () => null,
  );
  store.admit({ ...(REGIONS[1] as DrftRegion), instances: [] });
  const assembly = {
    attributes: 0,
    surfaces: new Float32Array(SURFACE_FLOATS),
    pieces: new Uint32Array(0),
    surfaceOf: new Uint32Array(0),
    transforms: new Float32Array(0),
    uv: new Float32Array(0),
  };
  store.hold(5, assembly, () => triangle(0));
  expect(store.page(11, 0, true).map((c) => c.ordinal)).toEqual([5]);
  store.page(11, 0, false);
  const late = { mesh: { id: 42 }, instances: null, reveal: 1 } as unknown as DrftPart;
  store.arrived(5, late);
  expect(disposed).toEqual([{ id: 42 }]);
  expect(store.regions.get(11)?.levels[0]?.parts).toEqual([]);
});

test('A BATCH SAYS WHICH OF ITS REGION’S GROUPS IT IS, SINCE BATCHES ARE BUILT AS THEIR PROTOTYPES ARRIVE', () => {
  const store = new RegionStore(fakeRenderer([]), () => null);
  store.admit({
    ...(REGIONS[1] as DrftRegion),
    instances: [
      { mesh: 4, transforms: new Float32Array(at(1)) },
      { mesh: 6, transforms: new Float32Array(at(2)) },
    ],
  });
  /* The second group's prototype lands first, so its batch is built first. */
  store.arrived(6, { mesh: { id: 6 }, instances: null, reveal: 1 } as unknown as DrftPart);
  store.arrived(4, { mesh: { id: 4 }, instances: null, reveal: 1 } as unknown as DrftPart);
  while (store.buildNext());
  const region = store.regions.get(11);
  expect(region?.batches.map((b) => (b.mesh as unknown as { id: number }).id)).toEqual([6, 4]);
  expect(region?.batchGroups).toEqual([1, 0]);
});
