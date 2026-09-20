import { describe, expect, test } from 'vitest';

import type { GeometrySink, MeshData, StreamHandle } from '../../packages/core/src/index';
import { mirrorSink } from '../../packages/core/src/render/gpudriven/geometryHarness';
import { GPU_DRIVEN_VERTEX_FLOATS } from '../../packages/core/src/render/gpudriven/sceneUpload';

import type { BlockAtlas } from './atlas';
import { atlasProgram } from './atlasProgram';
import { CHUNK_SX, CHUNK_SZ } from './constants';
import {
  BLEND_OPACITY,
  CHUNK_WORST,
  CUTOUT,
  GpuDrivenChunks,
  capacityFor,
} from './gpuDrivenChunks';
import { meshChunk, type ChunkMeshData } from './mesher';
import { World } from './world';

/* Two tiles of four texels side by side, so a uv has a cell to be moved into. */
const ATLAS = atlasProgram(new Uint8Array(8 * 4 * 4).fill(255), 8, 4, 4);

/**
 * `count` unit quads in a row along x, each with its own four corners as the mesher writes them,
 * so neighbours share positions and never an index.
 */
function strip(count: number, glow = 0): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let q = 0; q < count; q += 1) {
    const base = positions.length / 3;
    positions.push(q, 1, 0, q + 1, 1, 0, q + 1, 1, 1, q, 1, 1);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const vertices = positions.length / 3;
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from({ length: vertices * 3 }, (_, i) => (i % 3 === 1 ? 1 : 0)),
    colors: new Float32Array(vertices * 3).fill(1),
    emissive: new Float32Array(vertices).fill(glow),
    uvs: new Float32Array(vertices * 2),
    indices: Uint32Array.from(indices),
  };
}

function chunk(parts: Partial<ChunkMeshData>): ChunkMeshData {
  return { opaque: null, cutout: null, blend: null, ...parts };
}

const ROOMY = { vertices: 4096, indices: 8192, clusters: 64, meshes: 16 };

/** Which materials the scene's live clusters shade in, as a sorted list. */
function liveMaterials(chunks: GpuDrivenChunks): number[] {
  const out: number[] = [];
  const scene = chunks.scene;
  for (let c = 0; c < scene.capacity.clusters; c += 1) {
    if ((scene.meta[c * 4 + 1] as number) > 0) out.push(scene.materialOf[c] as number);
  }
  return out.sort();
}

describe('a chunk on the second pipeline', () => {
  test('A CHUNK’S THREE MODES BECOME THREE MESHES WITH THREE MATERIALS', () => {
    /*
     * **This is what `ChunkDraw` was, and the pipeline does the rest.** Its three material records
     * and its three draw lists become three streamed adds, each naming its mode's material; the
     * frustum visit and the per-mode draws are the pipeline's own job now.
     */
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    expect(chunks.add(0, 0, chunk({ opaque: strip(2), cutout: strip(2), blend: strip(2) }))).toBe(
      true,
    );
    expect(chunks.handlesOf(0, 0)?.length).toBe(3);
    expect(liveMaterials(chunks)).toEqual([0, 1, 2]);
  });

  test('THE THREE MATERIALS ARE THE FORWARD PATH’S THREE, reading one atlas', () => {
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    const [opaque, cutout, blend] = chunks.materials;
    /* The forward path's own numbers: `cutout: 0.5` on the leaves and 0.72 on water and glass. */
    expect(CUTOUT).toBe(0.5);
    expect(BLEND_OPACITY).toBe(0.72);
    expect(opaque?.alphaCutoff ?? 0).toBe(0);
    expect(opaque?.blend ?? false).toBe(false);
    expect(cutout?.alphaCutoff).toBe(CUTOUT);
    expect(cutout?.blend ?? false).toBe(false);
    expect(blend?.blend).toBe(true);
    expect(blend?.opacity).toBe(BLEND_OPACITY);
    /* Water is glossy on the forward path, at a roughness scale of a tenth. */
    expect(blend?.roughness).toBe(0.1);
    for (const material of chunks.materials) {
      expect(material.textures?.baseColour).toBe(ATLAS.program);
      /* No scale: the uvs are moved into the atlas's cells when a chunk arrives. */
      expect(material.textures?.uScale ?? 1).toBe(1);
      expect(material.textures?.vScale ?? 1).toBe(1);
    }
  });

  test('A CHUNK’S UVS ARE MOVED INTO THE ATLAS’S CELLS, each to the same texel of its tile', () => {
    /*
     * The mesher writes `buildBlockAtlas`'s UV table, which addresses tiles packed edge to edge;
     * the program holds each tile in a cell with a gutter round it. A uv left as the mesher wrote
     * it samples the wrong place in the cells — a gutter or another tile — so every vertex is
     * moved as it is streamed.
     */
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    const sink = mirrorSink(ROOMY);
    chunks.scene.attach(sink);
    const data = strip(1);
    const uvs = data.uvs as Float32Array;
    uvs.set([0.1, 0.2, 0.4, 0.2, 0.6, 0.9, 0.9, 0.9]);
    chunks.add(0, 0, chunk({ opaque: data }));
    const handle = chunks.handlesOf(0, 0)?.[0] as StreamHandle;
    for (let v = 0; v < 4; v += 1) {
      const at = (handle.vertexBase + v) * GPU_DRIVEN_VERTEX_FLOATS;
      const [u, w] = ATLAS.remap(uvs[v * 2] as number, uvs[v * 2 + 1] as number);
      expect(sink.vertices[at + 9]).toBeCloseTo(u, 6);
      expect(sink.vertices[at + 10]).toBeCloseTo(w, 6);
    }
    /* And the mesh the chunk renderer built is left as it was. */
    expect(uvs[0]).toBeCloseTo(0.1, 6);
  });

  test('a chunk stands at its own corner of the world, as its scene node did', () => {
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    chunks.add(3, -2, chunk({ opaque: strip(1) }));
    const handle = chunks.handlesOf(3, -2)?.[0] as StreamHandle;
    const at = handle.mesh * 16;
    expect(chunks.scene.transforms[at + 12]).toBe(3 * CHUNK_SX);
    expect(chunks.scene.transforms[at + 13]).toBe(0);
    expect(chunks.scene.transforms[at + 14]).toBe(-2 * CHUNK_SZ);
    expect(chunks.scene.transforms[at + 0]).toBe(1);
    expect(chunks.scene.transforms[at + 15]).toBe(1);
  });

  test('A REMOVED CHUNK GIVES ITS RANGES BACK, and the next one takes them', () => {
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    chunks.add(0, 0, chunk({ opaque: strip(4) }));
    const first = chunks.handlesOf(0, 0)?.[0] as StreamHandle;
    chunks.remove(0, 0);
    expect(chunks.scene.liveClusters).toBe(0);
    expect(chunks.handlesOf(0, 0)).toBeUndefined();
    chunks.add(1, 0, chunk({ opaque: strip(4) }));
    expect(chunks.handlesOf(1, 0)?.[0]?.vertexBase).toBe(first.vertexBase);
  });

  test('A REFUSAL IS COUNTED AND DOES NOT THROW, and leaves nothing of the chunk behind', () => {
    /*
     * **A chunk that does not appear has to say so.** The HUD carries this count and a capture
     * asserts it stays at zero; a world that quietly loses terrain is the failure this pipeline
     * makes easy. And **all or nothing**: half a chunk — its stone without its water — is a hole
     * that looks like terrain.
     */
    const tight = { vertices: 12, indices: 64, clusters: 8, meshes: 8 };
    const chunks = new GpuDrivenChunks(tight, ATLAS);
    expect(chunks.add(0, 0, chunk({ opaque: strip(2), blend: strip(2) }))).toBe(false);
    expect(chunks.refused).toBe(1);
    expect(chunks.scene.liveClusters).toBe(0);
    expect(chunks.handlesOf(0, 0)).toBeUndefined();
    /* And the room it rolled back is room: the opaque half alone fits. */
    expect(chunks.add(0, 0, chunk({ opaque: strip(2) }))).toBe(true);
    expect(chunks.refused).toBe(1);
  });

  test('adding a chunk that is already there replaces it, which is what a remesh is', () => {
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    chunks.add(0, 0, chunk({ opaque: strip(4) }));
    const clusters = chunks.scene.liveClusters;
    chunks.add(0, 0, chunk({ opaque: strip(4) }));
    expect(chunks.scene.liveClusters).toBe(clusters);
    expect(chunks.count).toBe(1);
  });

  test('a mode with no geometry adds nothing', () => {
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    chunks.add(0, 0, chunk({ cutout: strip(1) }));
    expect(chunks.handlesOf(0, 0)?.length).toBe(1);
    expect(liveMaterials(chunks)).toEqual([1]);
  });

  test('BLOCK LIGHT TRAVELS WITH THE VERTEX, so a torch still burns after dark', () => {
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    const sink = mirrorSink(ROOMY);
    chunks.scene.attach(sink);
    chunks.add(0, 0, chunk({ opaque: strip(1, 0.75) }));
    const handle = chunks.handlesOf(0, 0)?.[0] as StreamHandle;
    expect(sink.vertices[handle.vertexBase * GPU_DRIVEN_VERTEX_FLOATS + 11]).toBe(0.75);
  });

  test('A CHUNK IS CLUSTERED BY POSITION, or every quad is a cluster of its own', () => {
    /* Eight quads that touch and share no index: one cluster by position, eight by index. */
    const chunks = new GpuDrivenChunks(ROOMY, ATLAS);
    chunks.add(0, 0, chunk({ opaque: strip(8) }));
    expect(chunks.scene.liveClusters).toBe(1);
  });

  test('A FRAME\u2019S REMESHES FIT IN THE HEADROOM, with every chunk the worst the world makes', () => {
    /*
     * **The price of §3.4 of the design, measured where it is highest.** While a pass holds the
     * scene, a removed chunk's ranges wait for the next upload, so a remesh cannot reuse its own
     * room in the frame it happens in. `capacityFor` keeps a quarter over the worst chunk on every
     * chunk of the ring; this fills the ring with the worst chunk and remeshes two a frame — a
     * block broken on a border — which a world whose median chunk is half the worst never nears.
     */
    const chunks = new GpuDrivenChunks(capacityFor(1), ATLAS);
    const nowhere: GeometrySink = { writeVertices: () => undefined, writeIndices: () => undefined };
    chunks.scene.attach(nowhere);
    const worst = chunk({ opaque: strip(CHUNK_WORST.vertices / 4) });
    const ring: [number, number][] = [];
    for (let x = -2; x <= 2; x += 1) for (let z = -2; z <= 2; z += 1) ring.push([x, z]);
    for (const [x, z] of ring) expect(chunks.add(x, z, worst)).toBe(true);
    chunks.scene.takeDirty();
    for (let i = 0; i < ring.length; i += 2) {
      for (const [x, z] of ring.slice(i, i + 2)) chunks.add(x, z, worst);
      chunks.scene.takeDirty();
    }
    expect(chunks.refused).toBe(0);
  });
});

describe('how much room a radius needs', () => {
  test('THE COUNT IS THE KEEP RING, NOT THE RENDER RING', () => {
    /*
     * **`ChunkRenderer` keeps a chunk one past the radius**, so the player stepping back and forth
     * across a border does not drop and rebuild a row each time — which means the live set reaches
     * (2r + 3) squared and not the (2r + 1) squared the spec's arithmetic used: 225 chunks at radius
     * 6 rather than 169. Sized to the render ring, the port would refuse chunks every time the
     * player walked.
     */
    const at6 = capacityFor(6);
    const chunks = 15 * 15;
    expect(at6.vertices).toBe(Math.ceil(CHUNK_WORST.vertices * chunks * 1.25));
    expect(at6.indices).toBe(Math.ceil(CHUNK_WORST.indices * chunks * 1.25));
    expect(at6.clusters).toBe(Math.ceil(CHUNK_WORST.clusters * chunks * 1.25));
    expect(at6.meshes).toBe(chunks * 3);
  });

  test('THE DECLARED WORST CHUNK COVERS EVERY CHUNK OF THE WORLD AROUND SPAWN', () => {
    /*
     * **The worst chunk is measured, and this is the measurement's guard.** The constants came from
     * a 17-by-17 patch of seed 1337 around the origin; this re-meshes the middle 9-by-9 of it
     * through the real mesher and the real clusterer and holds every chunk to them. A change to the
     * mesher that grows a chunk past its worst fails here rather than as a refused chunk on a page.
     */
    const world = new World(1337);
    const atlas = {
      rects: new Map(),
      fallback: { u0: 0, v0: 0, u1: 1, v1: 1 },
    } as unknown as BlockAtlas;
    const chunks = new GpuDrivenChunks(capacityFor(4), ATLAS);
    for (let cz = -4; cz <= 4; cz += 1) {
      for (let cx = -4; cx <= 4; cx += 1) {
        world.light.beginFrame();
        world.light.warmFor(cx, cz, Number.POSITIVE_INFINITY);
        const data = meshChunk(world, cx, cz, atlas, world.light);
        expect(chunks.add(cx, cz, data)).toBe(true);
        let vertices = 0;
        let indices = 0;
        let clusters = 0;
        for (const handle of chunks.handlesOf(cx, cz) ?? []) {
          vertices += handle.vertexCount;
          indices += handle.indexCount;
          clusters += handle.clusterCount;
        }
        expect(vertices).toBeLessThanOrEqual(CHUNK_WORST.vertices);
        expect(indices).toBeLessThanOrEqual(CHUNK_WORST.indices);
        expect(clusters).toBeLessThanOrEqual(CHUNK_WORST.clusters);
      }
    }
    expect(chunks.refused).toBe(0);
  }, 60_000);
});
