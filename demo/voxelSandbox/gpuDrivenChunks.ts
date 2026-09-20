/**
 * The sandbox's chunks as a streaming scene the GPU-driven pipeline draws.
 *
 * **This is what `ChunkDraw` was, and it is smaller.** `ChunkDraw` walked a tree of scene nodes to
 * find what the frustum kept, bound one material a render mode, and issued a draw a mesh. Every
 * one of those is the pipeline's own job now — the instance cull and the cluster cull are the
 * frustum visit, the material table is the three binds, one indirect draw is every draw — so what
 * is left is a map from a chunk to the three meshes it streamed in.
 *
 * **All or nothing, and a refusal is counted.** `StreamingScene.add` answers `null` when a range
 * will not fit, which is right for a frame loop and wrong to swallow: a world that quietly loses a
 * chunk looks like terrain with a hole in it. A chunk whose water does not fit loses its stone as
 * well rather than standing half-built, and `refused` is what the HUD reads.
 *
 * **Clustered by position.** A voxel mesh gives every face its own four corners, because each face
 * carries its own uv and occlusion, so growth by shared index made every quad a cluster of two
 * triangles — 1,012 clusters for a median chunk of 2,024 triangles. By position the same chunk is
 * nineteen.
 */
import { buildClusters } from '@driftengine/assets';

import { StreamingScene } from '../../packages/core/src/index';
import type {
  GpuDrivenMaterial,
  GpuDrivenMesh,
  MeshData,
  StreamCapacity,
  StreamHandle,
} from '../../packages/core/src/index';

import type { AtlasProgram } from './atlasProgram';
import { CHUNK_SX, CHUNK_SZ, chunkKey } from './constants';
import type { ChunkMeshData } from './mesher';

const MODES = ['opaque', 'cutout', 'blend'] as const;

/** Triangles a cluster, which is what the visibility buffer packs into seven bits. */
const CLUSTER_TRIANGLES = 128;

/** The forward path's leaf cutout, in `ChunkDraw`'s cutout material. */
export const CUTOUT = 0.5;

/** What the reference draws its water and glass at, and `ChunkDraw` did. */
export const BLEND_OPACITY = 0.72;

/**
 * The largest chunk the world makes, in each of the three things a scene has room for.
 *
 * **Measured, not chosen**: every chunk of a 17-by-17 patch of seed 1337 around the origin, through
 * `meshChunk` and `buildClusters` by position, on 2026-09-18. The worst was 8,280 vertices, 12,420
 * indices and 66 clusters, not all from one chunk; the median was 4,048, 6,072 and 19.
 * `gpuDrivenChunks.test.ts` re-meshes the middle of that patch and holds every chunk to these.
 */
export const CHUNK_WORST = { vertices: 8280, indices: 12420, clusters: 66 } as const;

/**
 * Room over the worst case, for fragmentation.
 *
 * `scripts/stream-fragmentation.mjs` measured best fit clean at a quarter's headroom and refusing
 * at five per cent, on a workload of this shape — chunks arriving, leaving and remeshing a little
 * larger or smaller.
 */
const HEADROOM = 1.25;

/**
 * The scene a render radius needs.
 *
 * **The count is the keep ring, not the render ring.** `ChunkRenderer` keeps a chunk one past the
 * radius so a player stepping back and forth across a border does not drop and rebuild a row each
 * time, so the live set reaches (2r + 3) squared: 225 chunks at radius 6, not 169.
 */
export function capacityFor(radius: number): StreamCapacity {
  const side = 2 * (radius + 1) + 1;
  const chunks = side * side;
  return {
    vertices: Math.ceil(CHUNK_WORST.vertices * chunks * HEADROOM),
    indices: Math.ceil(CHUNK_WORST.indices * chunks * HEADROOM),
    clusters: Math.ceil(CHUNK_WORST.clusters * chunks * HEADROOM),
    /* One slot each, so a slot freed is always the size of the next one asked for. */
    meshes: chunks * MODES.length,
  };
}

/** A column-major translation to a chunk's corner. */
function cornerOf(cx: number, cz: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  m[12] = cx * CHUNK_SX;
  m[14] = cz * CHUNK_SZ;
  return m;
}

/**
 * One mode's geometry as the pipeline takes it: clustered by position, its uvs moved into the
 * atlas's cells, its glow carried along. A new uv array, because the mesh is the chunk renderer's.
 */
function streamed(data: MeshData, material: number, atlas: AtlasProgram): GpuDrivenMesh {
  const set = buildClusters(data, CLUSTER_TRIANGLES, { share: 'position' });
  let uvs: Float32Array | undefined;
  if (data.uvs !== undefined) {
    uvs = new Float32Array(data.uvs.length);
    for (let v = 0; v < uvs.length; v += 2) {
      const [u, w] = atlas.remap(data.uvs[v] as number, data.uvs[v + 1] as number);
      uvs[v] = u;
      uvs[v + 1] = w;
    }
  }
  return {
    positions: data.positions,
    normals: data.normals,
    colours: data.colors,
    ...(uvs === undefined ? {} : { uvs }),
    ...(data.emissive === undefined ? {} : { emissive: data.emissive }),
    clusters: {
      count: set.count,
      triangleOffsets: set.triangleOffsets,
      triangleCounts: set.triangleCounts,
      boundsCentre: set.boundsCentre,
      boundsRadius: set.boundsRadius,
      coneAxis: set.coneAxis,
      coneCutoff: set.coneCutoff,
      /* No detail chain: a chunk is one level, its own error zero and its parent never chosen. */
      ownError: new Float32Array(set.count),
      parentError: new Float32Array(set.count).fill(Infinity),
      indices: set.indices,
    },
    material,
  };
}

export class GpuDrivenChunks {
  readonly scene: StreamingScene;
  /** Opaque, cutout and blend, in the order `MODES` names them and the scene's meshes point at. */
  readonly materials: readonly GpuDrivenMaterial[];
  /** Chunks that did not fit. It staying at zero is what says the capacity is right. */
  refused = 0;

  private readonly live = new Map<string, StreamHandle[]>();
  private readonly atlas: AtlasProgram;

  constructor(capacity: StreamCapacity, atlas: AtlasProgram) {
    this.scene = new StreamingScene(capacity);
    this.atlas = atlas;
    /* No uv scale: a chunk's uvs are moved into the atlas's cells as it arrives. */
    const textures = { baseColour: atlas.program };
    this.materials = [
      { tint: [1, 1, 1], emissive: 0, textures },
      /* Leaves: discarded below the cutout rather than blended, so a canopy never sorts. */
      { tint: [1, 1, 1], emissive: 0, textures, alphaCutoff: CUTOUT },
      /* Water and glass, glossy at the forward path's roughness scale of a tenth. */
      {
        tint: [1, 1, 1],
        emissive: 0,
        textures,
        blend: true,
        opacity: BLEND_OPACITY,
        roughness: 0.1,
      },
    ];
  }

  /** Chunks with meshes in the scene. */
  get count(): number {
    return this.live.size;
  }

  /** The handles a chunk streamed in, one a mode that had geometry. For the tests and the HUD. */
  handlesOf(cx: number, cz: number): readonly StreamHandle[] | undefined {
    return this.live.get(chunkKey(cx, cz));
  }

  /**
   * Put a chunk's meshes in the scene, replacing whatever it had. False, and counted, if it would
   * not fit — in which case nothing of it is there.
   */
  add(cx: number, cz: number, data: ChunkMeshData): boolean {
    this.remove(cx, cz);
    const corner = cornerOf(cx, cz);
    const handles: StreamHandle[] = [];
    for (let mode = 0; mode < MODES.length; mode += 1) {
      const geometry = data[MODES[mode] as (typeof MODES)[number]];
      if (geometry === null) continue;
      const handle = this.scene.add(streamed(geometry, mode, this.atlas), corner, mode);
      if (handle === null) {
        for (const placed of handles) this.scene.remove(placed);
        this.refused += 1;
        return false;
      }
      handles.push(handle);
    }
    this.live.set(chunkKey(cx, cz), handles);
    return true;
  }

  /** Take a chunk's meshes out of the scene. Nothing happens for a chunk that is not there. */
  remove(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const handles = this.live.get(key);
    if (handles === undefined) return;
    for (const handle of handles) this.scene.remove(handle);
    this.live.delete(key);
  }
}
