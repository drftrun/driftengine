/**
 * The frame's geometry, which arrives and leaves while the frame loop runs.
 *
 * **`GpuDrivenPass` uploaded its scene in a method called `buildStatic`**, and its constructor said
 * why: this pipeline's geometry does not move. A voxel world streams chunks as a player walks and
 * remeshes one on every block they break, so it has to.
 *
 * **Four `RangeAlloc`s over what the pass binds**: six arrays the scene keeps — the cluster and
 * mesh records a frame's culling reads — and two it never keeps. The vertices and the indices go
 * through a `GeometrySink` straight into the device's buffers when a mesh is placed, because
 * holding them as well doubled what a world costs, and at the voxel sandbox's radius 32 the copy
 * was an ArrayBuffer Chrome will not allocate. A mesh claims a run of each, writes its rows, and
 * hands the runs back when it leaves.
 *
 * **One path, not two.** The static case is a scene filled once and never emptied — `streamingScene`
 * is that, and it is what every caller of `buildGpuDrivenScene` plus `new GpuDrivenPass` becomes.
 * Two paths would mean the three rigs in `DRAFT_SCENES` exercise the path no published scene uses,
 * which is how a control stops being a control; `streamScene.test.ts` asserts this class packs a
 * static scene byte for byte where `buildGpuDrivenScene` packed it.
 *
 * **`add` allocates only when a mesh larger than any before it arrives**, because it is called
 * from a frame loop when a player walks: the scratch it interleaves into grows to the largest mesh
 * and is reused. A scene filled before its pass mounts is the exception, and it is the static
 * case: it holds each mesh until the pass attaches, and nothing after. `heldBytes` says which.
 */

import { worldClustersInto } from './clusterWorld.ts';
import { cullCutoff } from './cullClusters.ts';
import { INSTANCE_FLOATS, instanceSphereInto } from './instances.ts';
import { RangeAlloc } from './rangeAlloc.ts';
import { sceneShadowBounds } from './shadowCamera.ts';
import { GPU_DRIVEN_VERTEX_FLOATS, glowOf } from './sceneUpload.ts';

import type { GpuDrivenMesh } from './sceneUpload.ts';

/** Eight floats a cluster in `cull`, matching `clusterWorld.ts` and the cull shader's stride. */
const CULL_FLOATS = 8;
/** Six floats a cluster in `lod`, matching the LOD shader's `i * 6u`. */
const LOD_FLOATS = 6;
/** Four words a cluster in `meta`: index offset, index count, cluster id, mesh index. */
const META_WORDS = 4;
/** Sixteen floats a mesh. */
const TRANSFORM_FLOATS = 16;

/** How many units of each axis a scene may hold. Declared once; a claim past it is refused. */
export interface StreamCapacity {
  readonly vertices: number;
  readonly indices: number;
  readonly clusters: number;
  readonly meshes: number;
}

/** What `add` hands back, and what `remove` needs to give the room back. */
export interface StreamHandle {
  readonly mesh: number;
  readonly vertexBase: number;
  readonly vertexCount: number;
  readonly indexBase: number;
  readonly indexCount: number;
  readonly clusterBase: number;
  readonly clusterCount: number;
}

/** One buffer's changed run, in units of that buffer's record. */
export interface DirtySpan {
  readonly from: number;
  readonly to: number;
}

export interface StreamUpload {
  readonly clusters: readonly DirtySpan[];
  readonly meshes: readonly DirtySpan[];
}

/**
 * Where a scene's vertices and indices go, since it keeps no copy of them.
 *
 * **Handed a scratch array, and a sink must copy it before returning.** `rows` and `values` may be
 * longer than `count` records: the scene interleaves every mesh into the same two arrays and
 * reuses them on the next add, which is what keeps `add` from allocating in a frame loop.
 * `queue.writeBuffer` copies when it is called, so `GpuDrivenPass` hands them straight on.
 */
export interface GeometrySink {
  /** `count` vertices of twelve floats each, from the start of `rows`, placed at `firstVertex`. */
  writeVertices(firstVertex: number, rows: Float32Array, count: number): void;
  /** `count` indices from the start of `values`, already rebased onto the scene, at `firstIndex`. */
  writeIndices(firstIndex: number, values: Uint32Array, count: number): void;
}

/** A mesh's geometry, held until a sink is attached and dropped then. */
interface Staged {
  readonly vertexBase: number;
  readonly rows: Float32Array;
  readonly vertexCount: number;
  readonly indexBase: number;
  readonly values: Uint32Array;
  readonly indexCount: number;
}

/** Four words a removed mesh while its ranges wait: vertex base and count, index base and count. */
const WAITING_WORDS = 4;

/** What a second pass is told. See `attach`. */
const SPENT =
  "[driftengine] a streaming scene writes its geometry to one pass's device and keeps no copy, " +
  "and this one's has already gone to a pass; build the scene again for a second pass";

/**
 * A list of changed runs, kept sorted and merged.
 *
 * **The same invariant `RangeAlloc` keeps over its holes, for the same reason**: `takeDirty` has to
 * answer the same way however the frame's adds were ordered, or a capture depends on history.
 */
class DirtyList {
  private spans: { from: number; to: number }[] = [];

  mark(from: number, to: number): void {
    if (to <= from) return;
    let index = 0;
    while (index < this.spans.length && (this.spans[index] as DirtySpan).from < from) index += 1;
    this.spans.splice(index, 0, { from, to });

    /* Merge backwards then forwards, so three touching runs become one. */
    const previous = index > 0 ? this.spans[index - 1] : undefined;
    if (previous !== undefined && previous.to >= from) {
      previous.to = Math.max(previous.to, to);
      this.spans.splice(index, 1);
      index -= 1;
    }
    let merged = this.spans[index] as { from: number; to: number };
    while (index + 1 < this.spans.length) {
      const next = this.spans[index + 1] as DirtySpan;
      if (next.from > merged.to) break;
      merged.to = Math.max(merged.to, next.to);
      this.spans.splice(index + 1, 1);
      merged = this.spans[index] as { from: number; to: number };
    }
  }

  take(): DirtySpan[] {
    const out = this.spans;
    this.spans = [];
    return out;
  }
}

export class StreamingScene {
  readonly capacity: StreamCapacity;

  /** Eight floats a cluster: world centre, radius, cone axis, cutoff. */
  readonly cull: Float32Array;
  /** Six floats a cluster: world centre, radius, own error, parent error. */
  readonly lod: Float32Array;
  /** Four words a cluster: index offset, index count, cluster id, mesh index. */
  readonly meta: Uint32Array;
  readonly materialOf: Uint32Array;
  readonly transforms: Float32Array;
  readonly instanceSpheres: Float32Array;

  private readonly vertexAlloc: RangeAlloc;
  private readonly indexAlloc: RangeAlloc;
  private readonly clusterAlloc: RangeAlloc;
  private readonly meshAlloc: RangeAlloc;

  private readonly dirtyClusters = new DirtyList();
  private readonly dirtyMeshes = new DirtyList();

  /**
   * Scratch `worldClustersInto` needs, sized once.
   *
   * It wants `bounds` as four floats a cluster — centre and radius together — and `cones` as four,
   * where a `ClusterSource` keeps `boundsCentre` / `boundsRadius` and `coneAxis` / `coneCutoff` as
   * separate arrays. Packing them is a copy a frame loop must not allocate for.
   */
  private readonly boundScratch: Float32Array;
  private readonly coneScratch: Float32Array;
  private readonly errorScratch: Float32Array;
  private readonly meshScratch: Uint32Array;

  private live = 0;

  /**
   * **Where the geometry is.** Held a mesh at a time until a pass attaches (`staging`), written
   * straight to that pass's buffers (`attached`), or nowhere once the pass has gone (`spent`).
   */
  private state: 'staging' | 'attached' | 'spent' = 'staging';
  private sink: GeometrySink | null = null;
  private readonly staged = new Map<number, Staged>();
  /* What an attached scene interleaves through: grown to the largest mesh, never shrunk. */
  private rowScratch = new Float32Array(0);
  private indexScratch = new Uint32Array(0);
  /* Geometry ranges a removal freed while attached, given back at the next `takeDirty`. */
  private waiting: Uint32Array;
  private waitingCount = 0;

  constructor(capacity: StreamCapacity) {
    const clusters = Math.max(0, Math.floor(capacity.clusters));
    const meshes = Math.max(0, Math.floor(capacity.meshes));
    this.capacity = {
      vertices: Math.max(0, Math.floor(capacity.vertices)),
      indices: Math.max(0, Math.floor(capacity.indices)),
      clusters,
      meshes,
    };

    this.cull = new Float32Array(clusters * CULL_FLOATS);
    this.lod = new Float32Array(clusters * LOD_FLOATS);
    this.meta = new Uint32Array(clusters * META_WORDS);
    this.materialOf = new Uint32Array(clusters);
    this.transforms = new Float32Array(meshes * TRANSFORM_FLOATS);
    this.instanceSpheres = new Float32Array(meshes * INSTANCE_FLOATS);

    this.vertexAlloc = new RangeAlloc(this.capacity.vertices);
    this.indexAlloc = new RangeAlloc(this.capacity.indices);
    this.clusterAlloc = new RangeAlloc(clusters);
    this.meshAlloc = new RangeAlloc(meshes);

    this.boundScratch = new Float32Array(clusters * 4);
    this.coneScratch = new Float32Array(clusters * 4);
    this.errorScratch = new Float32Array(clusters * 2);
    this.meshScratch = new Uint32Array(clusters);
    /* Room for every mesh the scene can hold being removed in one frame; `hold` grows it past. */
    this.waiting = new Uint32Array(meshes * WAITING_WORDS);
  }

  /** How many clusters currently draw. A removed cluster's slot is still allocated until released. */
  get liveClusters(): number {
    return this.live;
  }

  /** Room left on each axis, which `scripts/stream-fragmentation.mjs` and its tests read. */
  get freeVertices(): number {
    return this.vertexAlloc.capacity - this.vertexAlloc.used;
  }

  /** The worst each axis ever reached, which is the occupancy a fragmentation run reports. */
  get highWater(): StreamCapacity {
    return {
      vertices: this.vertexAlloc.highWater,
      indices: this.indexAlloc.highWater,
      clusters: this.clusterAlloc.highWater,
      meshes: this.meshAlloc.highWater,
    };
  }

  /**
   * The geometry this scene holds on the CPU, in bytes: what is staged for a pass that has not
   * attached, and the two scratch arrays an attached scene interleaves through. **Nothing past
   * that** — which is the whole of what `GeometrySink` is for, as a number a test and a readout can
   * read.
   */
  get heldBytes(): number {
    let bytes = this.rowScratch.byteLength + this.indexScratch.byteLength;
    for (const entry of this.staged.values()) {
      bytes += entry.rows.byteLength + entry.values.byteLength;
    }
    return bytes;
  }

  /**
   * Give the scene the one place its geometry goes, and send it everything staged so far.
   *
   * **Once, and a second time is refused by name.** The scene keeps no copy of what it has sent,
   * so a second pass would bind two empty buffers and draw nothing — silently, which is the one
   * answer this cannot give. The dirty journal already made a scene one pass's: two passes would
   * each take its spans and each miss the other's.
   */
  attach(sink: GeometrySink): void {
    if (this.state !== 'staging') throw new Error(SPENT);
    this.state = 'attached';
    this.sink = sink;
    for (const entry of this.staged.values()) {
      sink.writeVertices(entry.vertexBase, entry.rows, entry.vertexCount);
      sink.writeIndices(entry.indexBase, entry.values, entry.indexCount);
    }
    this.staged.clear();
  }

  /**
   * The pass has gone. Adds and removes still keep the records, and the geometry goes nowhere.
   *
   * **Called by `GpuDrivenPass.dispose` before it destroys its buffers**, because a write to a
   * destroyed buffer is a device error; and nothing waits after it, because nothing reads.
   */
  detach(): void {
    this.state = 'spent';
    this.sink = null;
    this.staged.clear();
    this.releaseWaiting();
  }

  /**
   * Place a mesh, or refuse.
   *
   * **Every claim before any write, and a rollback if the last one fails.** A partial add is a mesh
   * whose clusters point at vertices another mesh owns, which draws somebody else's geometry rather
   * than failing — the shape of mistake `packClusters` documents one level up.
   *
   * **`null` rather than an exception**, because a streaming consumer calls this from a frame loop
   * when the player walks: an exception there is a crashed demo where a refusal is a chunk that
   * arrives a frame later.
   */
  add(mesh: GpuDrivenMesh, transform: ArrayLike<number>, material: number): StreamHandle | null {
    const vertexCount = mesh.positions.length / 3;
    const indexCount = mesh.clusters.indices.length;
    const clusterCount = mesh.clusters.count;

    const vertexBase = this.vertexAlloc.claim(vertexCount);
    const indexBase = vertexBase < 0 ? -1 : this.indexAlloc.claim(indexCount);
    const clusterBase = indexBase < 0 ? -1 : this.clusterAlloc.claim(clusterCount);
    const slot = clusterBase < 0 ? -1 : this.meshAlloc.claim(1);
    if (vertexBase < 0 || indexBase < 0 || clusterBase < 0 || slot < 0) {
      if (clusterBase >= 0) this.clusterAlloc.release(clusterBase, clusterCount);
      if (indexBase >= 0) this.indexAlloc.release(indexBase, indexCount);
      if (vertexBase >= 0) this.vertexAlloc.release(vertexBase, vertexCount);
      return null;
    }

    for (let i = 0; i < TRANSFORM_FLOATS; i += 1) {
      this.transforms[slot * TRANSFORM_FLOATS + i] = transform[i] ?? 0;
    }

    /* The interleave the pass used to do at construction, in the order its shaders index. */
    const uvs = mesh.uvs;
    const glow = glowOf(mesh, 'added');
    const rows = this.rowsFor(vertexCount);
    for (let v = 0; v < vertexCount; v += 1) {
      const to = v * GPU_DRIVEN_VERTEX_FLOATS;
      for (let axis = 0; axis < 3; axis += 1) {
        rows[to + axis] = mesh.positions[v * 3 + axis] as number;
        rows[to + 3 + axis] = mesh.normals[v * 3 + axis] as number;
        rows[to + 6 + axis] = mesh.colours[v * 3 + axis] as number;
      }
      rows[to + 9] = uvs === undefined ? 0 : (uvs[v * 2] as number);
      rows[to + 10] = uvs === undefined ? 0 : (uvs[v * 2 + 1] as number);
      rows[to + 11] = glow === undefined ? 0 : (glow[v] as number);
    }

    /* **Rebased onto the scene**, because the indices arrive addressing the mesh they came from. */
    const values = this.valuesFor(indexCount);
    for (let i = 0; i < indexCount; i += 1) {
      values[i] = (mesh.clusters.indices[i] as number) + vertexBase;
    }
    this.place(slot, vertexBase, rows, vertexCount, indexBase, values, indexCount);

    for (let c = 0; c < clusterCount; c += 1) {
      const record = clusterBase + c;
      this.meta[record * META_WORDS] = indexBase + (mesh.clusters.triangleOffsets[c] as number) * 3;
      this.meta[record * META_WORDS + 1] = (mesh.clusters.triangleCounts[c] as number) * 3;
      /* Its own position, which is what a pixel in the visibility buffer resolves through. */
      this.meta[record * META_WORDS + 2] = record;
      this.meta[record * META_WORDS + 3] = slot;
      this.materialOf[record] = material;

      for (let axis = 0; axis < 3; axis += 1) {
        this.boundScratch[c * 4 + axis] = mesh.clusters.boundsCentre[c * 3 + axis] as number;
        this.coneScratch[c * 4 + axis] = mesh.clusters.coneAxis[c * 3 + axis] as number;
      }
      this.boundScratch[c * 4 + 3] = mesh.clusters.boundsRadius[c] as number;
      /* Carried as a cosine, read by the cull as a sine: see `cullCutoff`. */
      this.coneScratch[c * 4 + 3] = cullCutoff(mesh.clusters.coneCutoff[c] as number);
      this.errorScratch[c * 2] = mesh.clusters.ownError[c] as number;
      this.errorScratch[c * 2 + 1] = mesh.clusters.parentError[c] as number;
      this.meshScratch[c] = slot;
    }

    /*
     * **The bounds are computed here, at the moment the mesh is placed.** `cull` holds them already
     * multiplied by the transform, and the pass's own constructor records what happened when it did
     * not: every rig stood at the origin, so nothing ever said so.
     */
    worldClustersInto(
      {
        bounds: this.boundScratch,
        cones: this.coneScratch,
        errors: this.errorScratch,
        meshOf: this.meshScratch,
        count: clusterCount,
      },
      this.transforms,
      this.cull,
      this.lod,
      clusterBase,
    );
    instanceSphereInto(this.cull, clusterBase, clusterCount, this.instanceSpheres, slot);

    this.dirtyClusters.mark(clusterBase, clusterBase + clusterCount);
    this.dirtyMeshes.mark(slot, slot + 1);
    this.live += clusterCount;

    return {
      mesh: slot,
      vertexBase,
      vertexCount,
      indexBase,
      indexCount,
      clusterBase,
      clusterCount,
    };
  }

  /** Take a mesh out. Its ranges go back and its clusters stop drawing. */
  remove(handle: StreamHandle): void {
    for (let c = 0; c < handle.clusterCount; c += 1) {
      /*
       * **The index count, not the offset.** Zero indices is a cluster that draws nothing and that
       * `instanceCull` rejects before it can write an instance; a zeroed offset is a cluster that
       * draws somebody else's first triangle.
       */
      this.meta[(handle.clusterBase + c) * META_WORDS + 1] = 0;
      /*
       * **And its world bounds, because `sceneBounds` reads them.** A released cluster whose cull
       * record still holds where it used to stand keeps the light's box stretched over a mesh that
       * is not there — which is a shadow map spread across empty space rather than anything that
       * fails. A radius of zero is what `sceneShadowBounds` skips.
       */
      for (let f = 0; f < CULL_FLOATS; f += 1)
        this.cull[(handle.clusterBase + c) * CULL_FLOATS + f] = 0;
    }
    for (let i = 0; i < INSTANCE_FLOATS; i += 1) {
      this.instanceSpheres[handle.mesh * INSTANCE_FLOATS + i] = 0;
    }

    this.clusterAlloc.release(handle.clusterBase, handle.clusterCount);
    this.meshAlloc.release(handle.mesh, 1);
    /* Removed before a pass attached: nothing of it is ever sent. */
    this.staged.delete(handle.mesh);
    if (this.state === 'attached') {
      this.hold(handle);
    } else {
      this.indexAlloc.release(handle.indexBase, handle.indexCount);
      this.vertexAlloc.release(handle.vertexBase, handle.vertexCount);
    }

    this.dirtyClusters.mark(handle.clusterBase, handle.clusterBase + handle.clusterCount);
    this.dirtyMeshes.mark(handle.mesh, handle.mesh + 1);
    this.live -= handle.clusterCount;

    /*
     * **The geometry is deliberately not cleared.** Nothing reads it once no cluster points at it,
     * and not clearing it is what makes a removal a handful of stores rather than a device write —
     * which matters, because a player walking away causes one every few frames.
     */
  }

  /** What changed since the last call, then cleared. An unchanged frame uploads nothing. */
  takeDirty(): StreamUpload {
    /* The uploads the caller is about to make are what stop anything reading a waiting range. */
    this.releaseWaiting();
    return {
      clusters: this.dirtyClusters.take(),
      meshes: this.dirtyMeshes.take(),
    };
  }

  /**
   * Where a mesh is interleaved: a fresh array while it has to be held until a pass attaches, and
   * the one scratch otherwise, grown only when a mesh larger than any before it arrives.
   */
  private rowsFor(vertexCount: number): Float32Array {
    const floats = vertexCount * GPU_DRIVEN_VERTEX_FLOATS;
    if (this.state === 'staging') return new Float32Array(floats);
    if (this.rowScratch.length < floats) this.rowScratch = new Float32Array(floats);
    return this.rowScratch;
  }

  private valuesFor(indexCount: number): Uint32Array {
    if (this.state === 'staging') return new Uint32Array(indexCount);
    if (this.indexScratch.length < indexCount) this.indexScratch = new Uint32Array(indexCount);
    return this.indexScratch;
  }

  /** Hand a placed mesh's geometry on, or hold it for the pass that has not attached yet. */
  private place(
    slot: number,
    vertexBase: number,
    rows: Float32Array,
    vertexCount: number,
    indexBase: number,
    values: Uint32Array,
    indexCount: number,
  ): void {
    if (this.state === 'staging') {
      this.staged.set(slot, { vertexBase, rows, vertexCount, indexBase, values, indexCount });
      return;
    }
    const sink = this.sink;
    if (sink === null) return;
    sink.writeVertices(vertexBase, rows, vertexCount);
    sink.writeIndices(indexBase, values, indexCount);
  }

  /**
   * Keep a removed mesh's vertex and index ranges from the allocator until the next `takeDirty`.
   *
   * **Because the geometry is written when a mesh is added, not when the frame is recorded.** The
   * pass records its frame at `beginFrame` and submits it at `endFrame`, and a queue write lands
   * before the frame it was made during runs. A mesh added in that window into a range freed that
   * frame would be drawn through the removed mesh's clusters, which the device holds until the
   * next upload. `takeDirty` is that upload's first step, so from then on nothing reads the range.
   * The cluster and mesh slots do not wait: their records travel together through the journal.
   */
  private hold(handle: StreamHandle): void {
    if ((this.waitingCount + 1) * WAITING_WORDS > this.waiting.length) {
      const grown = new Uint32Array(Math.max(WAITING_WORDS, this.waiting.length * 2));
      grown.set(this.waiting);
      this.waiting = grown;
    }
    const at = this.waitingCount * WAITING_WORDS;
    this.waiting[at] = handle.vertexBase;
    this.waiting[at + 1] = handle.vertexCount;
    this.waiting[at + 2] = handle.indexBase;
    this.waiting[at + 3] = handle.indexCount;
    this.waitingCount += 1;
  }

  private releaseWaiting(): void {
    const waiting = this.waiting;
    for (let i = 0; i < this.waitingCount; i += 1) {
      const at = i * WAITING_WORDS;
      this.vertexAlloc.release(waiting[at] as number, waiting[at + 1] as number);
      this.indexAlloc.release(waiting[at + 2] as number, waiting[at + 3] as number);
    }
    this.waitingCount = 0;
  }

  /**
   * A bounding sphere over every live cluster: centre in floats 0 to 2, radius in float 3.
   *
   * **`sceneShadowBounds` itself rather than a second spelling of it**, and that is not tidiness —
   * the first version of this method wrote a *box* into the same four floats the pass reads a
   * sphere out of, so the shadow camera was fitted to a sphere centred on the box's minimum corner
   * with `maxX` as its radius. Two GPU-driven rigs lost their shadows and the maintainer saw it on
   * the page before the capture diff was read.
   *
   * The function's own header already says why there is one copy of this arithmetic: a light's box
   * that disagrees with the cull's bounds clips casters out of a map the cull believes are in it.
   * A second copy here was the same mistake one level up.
   */
  sceneBounds(out: Float32Array): void {
    sceneShadowBounds(this.cull, CULL_FLOATS, this.capacity.clusters, out);
  }
}

/**
 * A scene filled once from a list of meshes, which is the static case.
 *
 * With no capacity given it sizes itself to exactly what the meshes need, so a static scene
 * allocates nothing spare and packs where `buildGpuDrivenScene` packed.
 */
export function streamingScene(
  meshes: readonly GpuDrivenMesh[],
  transforms: Float32Array,
  capacity?: StreamCapacity,
): StreamingScene {
  let vertices = 0;
  let indices = 0;
  let clusters = 0;
  for (const mesh of meshes) {
    vertices += mesh.positions.length / 3;
    indices += mesh.clusters.indices.length;
    clusters += mesh.clusters.count;
  }
  const scene = new StreamingScene(
    capacity ?? { vertices, indices, clusters, meshes: meshes.length },
  );
  meshes.forEach((mesh, at) => {
    scene.add(
      mesh,
      transforms.subarray(at * TRANSFORM_FLOATS, at * TRANSFORM_FLOATS + TRANSFORM_FLOATS),
      mesh.material,
    );
  });
  return scene;
}
