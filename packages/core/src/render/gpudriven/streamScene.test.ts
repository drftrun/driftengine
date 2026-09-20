import { mat4 } from 'gl-matrix';
import { describe, expect, test } from 'vitest';

import { worldClusters } from './clusterWorld.ts';
import { coneBackfacing } from './cullClusters.ts';
import { GPU_DRIVEN_VERTEX_FLOATS, buildGpuDrivenScene } from './sceneUpload.ts';
import { mirrorSink } from './geometryHarness.ts';
import { StreamingScene, streamingScene } from './streamScene.ts';

import type { MirrorSink } from './geometryHarness.ts';
import type { GpuDrivenMesh } from './sceneUpload.ts';
import type { StreamHandle } from './streamScene.ts';

/**
 * **What this file is for: the scene stops being a photograph and starts being a place.**
 *
 * Three ways that goes wrong and one that hides. A mesh whose ranges overlap a live one; a removed
 * mesh that still draws; a dirty journal that reports less than it changed, which uploads a
 * partial buffer and rasterises whatever was there before. The one that hides is a layout that
 * depends on history, so two runs of one demo produce two different images with nothing failing —
 * which is why `streamingScene` is asserted byte-identical to `buildGpuDrivenScene` rather than
 * merely equivalent.
 */

/** A unit cube of one cluster, with distinct vertex data so a wrong range is visible. */
function cube(seed: number): GpuDrivenMesh {
  const positions = new Float32Array(8 * 3);
  const normals = new Float32Array(8 * 3);
  const colours = new Float32Array(8 * 3);
  const uvs = new Float32Array(8 * 2);
  for (let v = 0; v < 8; v += 1) {
    positions[v * 3] = seed + (v & 1);
    positions[v * 3 + 1] = seed + ((v >> 1) & 1);
    positions[v * 3 + 2] = seed + ((v >> 2) & 1);
    normals[v * 3 + 1] = 1;
    colours[v * 3] = seed / 10;
    uvs[v * 2] = v / 8;
  }
  const indices = new Uint32Array([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
  return {
    positions,
    normals,
    colours,
    uvs,
    clusters: {
      count: 1,
      triangleOffsets: new Uint32Array([0]),
      triangleCounts: new Uint32Array([4]),
      boundsCentre: new Float32Array([seed + 0.5, seed + 0.5, seed + 0.5]),
      boundsRadius: new Float32Array([1]),
      coneAxis: new Float32Array([0, 1, 0]),
      coneCutoff: new Float32Array([-1]),
      ownError: new Float32Array([0]),
      parentError: new Float32Array([Infinity]),
      indices,
    },
    material: seed % 4,
  };
}

const CAPACITY = { vertices: 64, indices: 128, clusters: 8, meshes: 4 };

function at(x: number): Float32Array {
  const model = new Float32Array(16);
  mat4.fromTranslation(model, [x, 0, 0]);
  return model;
}

/** Two cubes as one mesh of two clusters: sixteen vertices, so larger than any `cube`. */
function twoCubes(seed: number): GpuDrivenMesh {
  const a = cube(seed);
  const b = cube(seed + 1);
  const join = (x: Float32Array, y: Float32Array): Float32Array => {
    const out = new Float32Array(x.length + y.length);
    out.set(x);
    out.set(y, x.length);
    return out;
  };
  const indices = new Uint32Array(24);
  indices.set(a.clusters.indices);
  indices.set(
    b.clusters.indices.map((i) => i + 8),
    12,
  );
  return {
    positions: join(a.positions, b.positions),
    normals: join(a.normals, b.normals),
    colours: join(a.colours, b.colours),
    uvs: join(a.uvs as Float32Array, b.uvs as Float32Array),
    clusters: {
      count: 2,
      triangleOffsets: Uint32Array.of(0, 4),
      triangleCounts: Uint32Array.of(4, 4),
      boundsCentre: join(a.clusters.boundsCentre, b.clusters.boundsCentre),
      boundsRadius: join(a.clusters.boundsRadius, b.clusters.boundsRadius),
      coneAxis: join(a.clusters.coneAxis, b.clusters.coneAxis),
      coneCutoff: join(a.clusters.coneCutoff, b.clusters.coneCutoff),
      ownError: join(a.clusters.ownError, b.clusters.ownError),
      parentError: join(a.clusters.parentError, b.clusters.parentError),
      indices,
    },
    material: 0,
  };
}

/** The mirror holds `cube(seed)` where the two bases say, interleaved and rebased. */
function holdsCube(sink: MirrorSink, vertexBase: number, indexBase: number, seed: number): void {
  for (let v = 0; v < 8; v += 1) {
    const to = (vertexBase + v) * GPU_DRIVEN_VERTEX_FLOATS;
    expect(sink.vertices[to]).toBe(seed + (v & 1));
    expect(sink.vertices[to + 1]).toBe(seed + ((v >> 1) & 1));
    expect(sink.vertices[to + 2]).toBe(seed + ((v >> 2) & 1));
    expect(sink.vertices[to + 6]).toBe(Math.fround(seed / 10));
    expect(sink.vertices[to + 9]).toBe(v / 8);
  }
  const local = cube(seed).clusters.indices;
  for (let i = 0; i < local.length; i += 1) {
    expect(sink.indices[indexBase + i]).toBe((local[i] as number) + vertexBase);
  }
}

const REFUSAL =
  /\[driftengine\] a streaming scene writes its geometry to one pass's device and keeps no copy, and this one's has already gone to a pass; build the scene again for a second pass/;

describe('a scene that is filled once is the scene that was packed', () => {
  test('STREAMINGSCENE MATCHES BUILDGPUDRIVENSCENE BYTE FOR BYTE, which is the single-path claim', () => {
    /*
     * **This is the test the whole plan rests on.** `GpuDrivenPass` is about to take a streaming
     * scene and nothing else, so the three rigs and the eight published scenes go through this
     * class. If it packs anything differently from the function they used before, every capture
     * moves and the cause is here rather than in the pass.
     */
    /* One of them glows, so the claim covers the float every mesh before it packed as zero. */
    const meshes = [
      cube(0),
      { ...cube(3), emissive: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) },
      cube(7),
    ];
    const transforms = new Float32Array(48);
    mat4.fromTranslation(transforms.subarray(0, 16), [1, 0, 0]);
    mat4.fromTranslation(transforms.subarray(16, 32), [0, 2, 0]);
    mat4.fromTranslation(transforms.subarray(32, 48), [0, 0, -5]);

    const packed = buildGpuDrivenScene(meshes);
    const world = worldClusters(
      {
        bounds: packed.clusters.bounds,
        cones: packed.clusters.cones,
        errors: packed.clusters.errors,
        meshOf: packed.clusters.meshOf,
        count: packed.clusters.count,
      },
      transforms,
    );
    const streamed = streamingScene(meshes, transforms);
    /* The geometry goes to whatever the scene is attached to, so the comparison reads that. */
    const sink = mirrorSink(streamed.capacity);
    streamed.attach(sink);

    expect(streamed.liveClusters).toBe(packed.clusters.count);
    expect(Array.from(sink.indices)).toEqual(Array.from(packed.clusters.indices));
    expect(Array.from(streamed.materialOf)).toEqual(Array.from(packed.materialOf));
    expect(Array.from(streamed.cull)).toEqual(Array.from(world.cull));
    expect(Array.from(streamed.lod)).toEqual(Array.from(world.lod));
    /* And the interleave, which is the pass's own layout rather than the packer's. */
    for (let v = 0; v < packed.vertexCount; v += 1) {
      const to = v * GPU_DRIVEN_VERTEX_FLOATS;
      expect(sink.vertices[to]).toBe(packed.positions[v * 3]);
      expect(sink.vertices[to + 3]).toBe(packed.normals[v * 3]);
      expect(sink.vertices[to + 6]).toBe(packed.colours[v * 3]);
      expect(sink.vertices[to + 9]).toBe(packed.uvs[v * 2]);
      expect(sink.vertices[to + 11]).toBe(packed.emissive[v]);
    }
  });
});

describe('a glow a vertex', () => {
  /*
   * **Block light has to survive nightfall, and a vertex colour does not.** The voxel sandbox folds
   * ambient occlusion and sky light into the colour and keeps torchlight in the vertex's emissive,
   * gated on the night factor; ported without a place for it, every torch in the world goes out
   * after dark. So the vertex gains a float, and a mesh with none packs zero — which is the
   * material's glow unchanged, and what keeps every existing scene the picture it was.
   */
  test('A VERTEX\u2019S GLOW IS PACKED AT FLOAT ELEVEN, and a mesh that carries none packs zero', () => {
    expect(GPU_DRIVEN_VERTEX_FLOATS).toBe(12);
    const lit = {
      ...cube(1),
      emissive: Float32Array.from([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 1]),
    };
    const scene = new StreamingScene(CAPACITY);
    const sink = mirrorSink(CAPACITY);
    scene.attach(sink);
    const glowing = scene.add(lit, at(0), 0) as StreamHandle;
    const plain = scene.add(cube(2), at(4), 0) as StreamHandle;
    for (let v = 0; v < 8; v += 1) {
      expect(sink.vertices[(glowing.vertexBase + v) * GPU_DRIVEN_VERTEX_FLOATS + 11]).toBe(
        lit.emissive[v],
      );
      expect(sink.vertices[(plain.vertexBase + v) * GPU_DRIVEN_VERTEX_FLOATS + 11]).toBe(0);
    }
    /* And the uv before it is still the uv: the glow went after it, not over it. */
    expect(sink.vertices[(glowing.vertexBase + 4) * GPU_DRIVEN_VERTEX_FLOATS + 9]).toBe(4 / 8);
  });

  test('a glow of the wrong length is refused where it is packed, as a uv of the wrong length is', () => {
    const short = { ...cube(1), emissive: new Float32Array(5) };
    expect(() => buildGpuDrivenScene([short])).toThrow(/5 emissive values for 8 vertices/);
    expect(() => new StreamingScene(CAPACITY).add(short, at(0), 0)).toThrow(
      /5 emissive values for 8 vertices/,
    );
  });
});

describe('a scene that changes', () => {
  test('A REMOVED MESH DRAWS NOTHING, because its clusters carry a zero index count', () => {
    const scene = new StreamingScene(CAPACITY);
    const handle = scene.add(cube(0), at(0), 0) as StreamHandle;
    expect(scene.meta[handle.clusterBase * 4 + 1]).toBeGreaterThan(0);
    scene.remove(handle);
    /* Index count is word 1 of the meta record, and zero is what `instanceCull` rejects on. */
    expect(scene.meta[handle.clusterBase * 4 + 1]).toBe(0);
    expect(scene.liveClusters).toBe(0);
  });

  test('before a pass attaches, a removed range is reused by the next mesh of the same size', () => {
    const scene = new StreamingScene(CAPACITY);
    const first = scene.add(cube(0), at(0), 0) as StreamHandle;
    scene.remove(first);
    const second = scene.add(cube(5), at(9), 1) as StreamHandle;
    expect(second.vertexBase).toBe(first.vertexBase);
    expect(second.clusterBase).toBe(first.clusterBase);
    /* And the new mesh's data is what reaches the pass, not the old mesh's. */
    const sink = mirrorSink(CAPACITY);
    scene.attach(sink);
    expect(sink.vertices[second.vertexBase * GPU_DRIVEN_VERTEX_FLOATS]).toBe(5);
    expect(scene.materialOf[second.clusterBase]).toBe(1);
  });

  test('REFUSES WITH NULL WHEN A CAPACITY IS EXHAUSTED, and changes nothing doing it', () => {
    const scene = new StreamingScene({ vertices: 8, indices: 128, clusters: 8, meshes: 4 });
    const sink = mirrorSink(scene.capacity);
    scene.attach(sink);
    expect(scene.add(cube(0), at(0), 0)).not.toBeNull();
    const writes = sink.writes.length;
    /* Eight vertices is exactly one cube; the second has nowhere to go, and nothing is sent. */
    expect(scene.add(cube(1), at(1), 0)).toBeNull();
    expect(sink.writes.length).toBe(writes);
    expect(scene.liveClusters).toBe(1);
  });

  test('A CAPACITY PAST WHAT ANY BROWSER WILL ALLOCATE IS NOT ALLOCATED AT ALL', () => {
    /*
     * **The sandbox at radius 32 died mounting**, then was refused by name: its vertices were
     * 2,230,135,200 bytes, and Chrome will not allocate one ArrayBuffer of 2 GiB. The scene holds
     * no geometry now, so a capacity of a trillion vertices constructs, and holds one mesh's bytes
     * once one is added — the device is what has to have room, and the pass asks it.
     */
    const scene = new StreamingScene({
      vertices: 2 ** 40,
      indices: 2 ** 42,
      clusters: 1,
      meshes: 1,
    });
    expect(scene.heldBytes).toBe(0);
    expect(scene.add(cube(0), at(0), 0)).not.toBeNull();
    expect(scene.heldBytes).toBe(8 * 48 + 12 * 4);
  });

  test('a refusal on a later axis releases the ranges the earlier ones already took', () => {
    /*
     * **The rollback, which is what stops a refusal leaking.** Vertices and indices fit and
     * clusters do not, so the first two claims succeed and the third fails — and without the
     * rollback the scene would be permanently a cube's worth smaller with nothing holding it.
     */
    const scene = new StreamingScene({ vertices: 64, indices: 128, clusters: 1, meshes: 4 });
    expect(scene.add(cube(0), at(0), 0)).not.toBeNull();
    expect(scene.add(cube(1), at(1), 0)).toBeNull();
    /* The room the refused add briefly held is back: a mesh with no clusters still fits. */
    const third = scene.add(cube(2), at(2), 0);
    expect(third).toBeNull();
    expect(scene.liveClusters).toBe(1);
    expect(scene.freeVertices).toBe(64 - 8);
  });

  test('A CLUSTER ID IS ITS POSITION IN THE SCENE, not its position in the mesh it came from', () => {
    /*
     * **The second mesh is what makes this a test.** Every cluster of the first mesh has a scene
     * position equal to its position within the mesh, so a scene of one mesh cannot tell the two
     * apart — found by perturbation, which changed the line and broke nothing.
     *
     * A cluster id is what a pixel in the visibility buffer resolves through, so an id that is a
     * mesh-local index makes every mesh after the first shade as the first one.
     */
    const scene = new StreamingScene(CAPACITY);
    scene.add(cube(0), at(0), 0);
    const second = scene.add(cube(1), at(4), 1) as StreamHandle;
    expect(second.clusterBase).toBeGreaterThan(0);
    for (let c = 0; c < second.clusterCount; c += 1) {
      expect(scene.meta[(second.clusterBase + c) * 4 + 2]).toBe(second.clusterBase + c);
    }
  });

  test("a cluster's mesh index is its slot, so it reaches the transform that placed it", () => {
    const scene = new StreamingScene(CAPACITY);
    const first = scene.add(cube(0), at(0), 0) as StreamHandle;
    scene.remove(first);
    const second = scene.add(cube(1), at(11), 0) as StreamHandle;
    expect(scene.meta[second.clusterBase * 4 + 3]).toBe(second.mesh);
    expect(scene.transforms[second.mesh * 16 + 12]).toBe(11);
  });

  test('THE SAME SEQUENCE TWICE PRODUCES BYTE-IDENTICAL BUFFERS', () => {
    /*
     * **The one that hides.** A layout that depends on anything but the sequence of calls makes a
     * capture differ between runs of one build with nothing failing — which this repository has
     * already spent an afternoon on once, chasing `showroom`'s two states.
     */
    const run = (): { scene: StreamingScene; sink: MirrorSink } => {
      const scene = new StreamingScene(CAPACITY);
      const sink = mirrorSink(CAPACITY);
      scene.attach(sink);
      const a = scene.add(cube(0), at(0), 0) as StreamHandle;
      const b = scene.add(cube(2), at(5), 1) as StreamHandle;
      scene.add(cube(4), at(9), 2);
      scene.remove(a);
      scene.remove(b);
      scene.add(cube(6), at(13), 3);
      return { scene, sink };
    };
    const first = run();
    const second = run();
    expect(Array.from(second.sink.vertices)).toEqual(Array.from(first.sink.vertices));
    expect(Array.from(second.scene.meta)).toEqual(Array.from(first.scene.meta));
    expect(Array.from(second.scene.cull)).toEqual(Array.from(first.scene.cull));
  });

  test('AN INDEX IS REBASED ONTO THE SCENE, not left addressing the mesh it came from', () => {
    /* The classic packing bug, and it draws somebody else's geometry rather than failing. */
    const scene = new StreamingScene(CAPACITY);
    const sink = mirrorSink(CAPACITY);
    scene.attach(sink);
    scene.add(cube(0), at(0), 0);
    const second = scene.add(cube(1), at(4), 0) as StreamHandle;
    expect(sink.indices[second.indexBase]).toBe(second.vertexBase);
  });
});

describe('where the geometry goes', () => {
  /*
   * **The scene keeps no copy of its vertices and indices.** They are the two arrays that grow
   * with a world, and holding them beside the device's own doubled what the sandbox's port cost
   * and stopped it at radius 31, one short of the sandbox's cap: Chrome will not allocate one
   * ArrayBuffer of 2 GiB. So they go to a sink — the pass's two buffers — and these say when.
   */
  test('GEOMETRY ADDED BEFORE A SINK IS ATTACHED REACHES IT AT ATTACH, in full', () => {
    const scene = new StreamingScene(CAPACITY);
    const a = scene.add(cube(0), at(0), 0) as StreamHandle;
    const b = scene.add(cube(3), at(4), 1) as StreamHandle;
    const sink = mirrorSink(CAPACITY);
    scene.attach(sink);
    holdsCube(sink, a.vertexBase, a.indexBase, 0);
    holdsCube(sink, b.vertexBase, b.indexBase, 3);
    expect(sink.writes.map((w) => [w.kind, w.first, w.count])).toEqual([
      ['vertices', a.vertexBase, 8],
      ['indices', a.indexBase, 12],
      ['vertices', b.vertexBase, 8],
      ['indices', b.indexBase, 12],
    ]);
  });

  test('A MESH REMOVED BEFORE ATTACH NEVER REACHES THE SINK', () => {
    const scene = new StreamingScene(CAPACITY);
    const gone = scene.add(cube(0), at(0), 0) as StreamHandle;
    const kept = scene.add(cube(3), at(4), 0) as StreamHandle;
    scene.remove(gone);
    const sink = mirrorSink(CAPACITY);
    scene.attach(sink);
    expect(sink.writes.map((w) => w.first)).toEqual([kept.vertexBase, kept.indexBase]);
    holdsCube(sink, kept.vertexBase, kept.indexBase, 3);
  });

  test('ONCE ATTACHED, AN ADD REACHES THE SINK BEFORE IT RETURNS', () => {
    const scene = new StreamingScene(CAPACITY);
    const sink = mirrorSink(CAPACITY);
    scene.attach(sink);
    const handle = scene.add(cube(2), at(0), 0) as StreamHandle;
    expect(sink.writes.length).toBe(2);
    holdsCube(sink, handle.vertexBase, handle.indexBase, 2);
  });

  test('ONE SCRATCH IS HANDED OVER, reused for a mesh no larger and grown for a larger one', () => {
    /*
     * **`add` is called from a frame loop**, so what it interleaves into is reused rather than made
     * each time — the allocation-free property, stated as the thing a sink can see: the same array.
     */
    const scene = new StreamingScene(CAPACITY);
    const sink = mirrorSink(CAPACITY);
    scene.attach(sink);
    scene.add(cube(1), at(0), 0);
    scene.add(cube(2), at(4), 0);
    const [v1, i1, v2, i2] = sink.writes;
    expect(v2?.source).toBe(v1?.source);
    expect(i2?.source).toBe(i1?.source);

    const pair = scene.add(twoCubes(4), at(8), 0) as StreamHandle;
    const [, , , , v3] = sink.writes;
    expect(v3?.source).not.toBe(v1?.source);
    /* Its second cube is `cube(5)`, eight vertices and twelve indices into the mesh. */
    holdsCube(sink, pair.vertexBase, pair.indexBase, 4);
    holdsCube(sink, pair.vertexBase + 8, pair.indexBase + 12, 5);

    /* And a smaller mesh after it reuses the grown array rather than shrinking it. */
    scene.add(cube(9), at(12), 0);
    expect(sink.writes[6]?.source).toBe(v3?.source);
  });

  test('HELDBYTES IS WHAT WAITS FOR A PASS, nothing once the pass has it, and one mesh after', () => {
    const scene = new StreamingScene(CAPACITY);
    expect(scene.heldBytes).toBe(0);
    scene.add(cube(0), at(0), 0);
    scene.add(cube(3), at(4), 0);
    /* Two cubes staged: eight vertices of forty-eight bytes and twelve indices of four, each. */
    expect(scene.heldBytes).toBe(2 * (8 * 48 + 12 * 4));
    scene.attach(mirrorSink(CAPACITY));
    expect(scene.heldBytes).toBe(0);
    scene.add(cube(5), at(8), 0);
    expect(scene.heldBytes).toBe(8 * 48 + 12 * 4);
  });

  test('WHILE ATTACHED, A REMOVED MESH’S RANGES WAIT FOR THE NEXT UPLOAD', () => {
    /*
     * **The window §3.4 of the design closes.** The pass records its frame at `beginFrame` and
     * submits it at `endFrame`, and a queue write lands before the submitted frame runs. A mesh
     * written into a range freed that frame would be drawn through the removed mesh's clusters,
     * which the device still holds until the next upload. So the range waits for `takeDirty` —
     * the call whose uploads stop every cluster pointing at it.
     */
    const scene = new StreamingScene(CAPACITY);
    scene.attach(mirrorSink(CAPACITY));
    const first = scene.add(cube(0), at(0), 0) as StreamHandle;
    scene.takeDirty();
    scene.remove(first);
    const early = scene.add(cube(1), at(1), 0) as StreamHandle;
    expect(early.vertexBase).not.toBe(first.vertexBase);
    expect(early.indexBase).not.toBe(first.indexBase);
    /* The cluster slot does not wait: its record travels with everything that points at it. */
    expect(early.clusterBase).toBe(first.clusterBase);
    scene.takeDirty();
    const late = scene.add(cube(2), at(2), 0) as StreamHandle;
    expect(late.vertexBase).toBe(first.vertexBase);
    expect(late.indexBase).toBe(first.indexBase);
  });

  test('A WAITING RANGE IS COUNTED AS USED, until the upload frees it', () => {
    const scene = new StreamingScene(CAPACITY);
    scene.attach(mirrorSink(CAPACITY));
    const handle = scene.add(cube(0), at(0), 0) as StreamHandle;
    scene.remove(handle);
    expect(scene.freeVertices).toBe(64 - 8);
    scene.takeDirty();
    expect(scene.freeVertices).toBe(64);
  });

  test('MORE REMOVALS IN ONE FRAME THAN THE SCENE HAS SLOTS ALL WAIT, and all are freed', () => {
    /* A slot is released at once, so one slot can be added and removed again before an upload. */
    const scene = new StreamingScene(CAPACITY);
    scene.attach(mirrorSink(CAPACITY));
    for (let i = 0; i < 6; i += 1) {
      scene.remove(scene.add(cube(i), at(i), 0) as StreamHandle);
    }
    expect(scene.freeVertices).toBe(64 - 6 * 8);
    scene.takeDirty();
    expect(scene.freeVertices).toBe(64);
  });

  test('A SECOND ATTACH IS REFUSED BY NAME, and so is one after detach', () => {
    const scene = new StreamingScene(CAPACITY);
    scene.attach(mirrorSink(CAPACITY));
    expect(() => scene.attach(mirrorSink(CAPACITY))).toThrow(REFUSAL);
    const other = new StreamingScene(CAPACITY);
    other.attach(mirrorSink(CAPACITY));
    other.detach();
    expect(() => other.attach(mirrorSink(CAPACITY))).toThrow(REFUSAL);
    const never = new StreamingScene(CAPACITY);
    never.detach();
    expect(() => never.attach(mirrorSink(CAPACITY))).toThrow(REFUSAL);
  });

  test('A DETACHED SCENE STILL PLACES A MESH, writes it nowhere, and frees a removal at once', () => {
    /*
     * **A streaming consumer can unmount between building a chunk and adding it.** An exception
     * there is a crashed page, and a `null` would read as a capacity refusal, which it is not.
     * Nothing can draw a detached scene, and a second `attach` is refused, so silence is safe here.
     */
    const scene = new StreamingScene(CAPACITY);
    const sink = mirrorSink(CAPACITY);
    scene.attach(sink);
    const waiting = scene.add(cube(0), at(0), 0) as StreamHandle;
    scene.remove(waiting);
    scene.detach();
    /* What was waiting is free: nothing reads a detached scene's ranges. */
    expect(scene.freeVertices).toBe(64);
    const writes = sink.writes.length;
    const handle = scene.add(cube(1), at(0), 0) as StreamHandle;
    expect(handle).not.toBeNull();
    expect(scene.liveClusters).toBe(1);
    expect(sink.writes.length).toBe(writes);
    scene.remove(handle);
    const again = scene.add(cube(2), at(0), 0) as StreamHandle;
    expect(again.vertexBase).toBe(handle.vertexBase);
  });
});

describe('the dirty journal', () => {
  test('REPORTS EXACTLY WHAT CHANGED AND CLEARS ITSELF', () => {
    const scene = new StreamingScene(CAPACITY);
    scene.takeDirty();
    const handle = scene.add(cube(0), at(0), 0) as StreamHandle;
    const dirty = scene.takeDirty();
    expect(dirty.clusters).toEqual([
      { from: handle.clusterBase, to: handle.clusterBase + handle.clusterCount },
    ]);
    /* Records only: the geometry went to the pass when the mesh was placed. */
    expect(Object.keys(dirty).sort()).toEqual(['clusters', 'meshes']);
    /* And taking it emptied it: an unchanged frame uploads nothing. */
    const second = scene.takeDirty();
    expect(second.clusters).toEqual([]);
    expect(second.meshes).toEqual([]);
  });

  test('a removal dirties the clusters it zeroed', () => {
    const scene = new StreamingScene(CAPACITY);
    const handle = scene.add(cube(0), at(0), 0) as StreamHandle;
    scene.takeDirty();
    scene.remove(handle);
    const dirty = scene.takeDirty();
    expect(dirty.clusters).toEqual([
      { from: handle.clusterBase, to: handle.clusterBase + handle.clusterCount },
    ]);
  });

  test('two adjacent adds merge into one span rather than two uploads', () => {
    const scene = new StreamingScene(CAPACITY);
    scene.takeDirty();
    const first = scene.add(cube(0), at(0), 0) as StreamHandle;
    const second = scene.add(cube(1), at(1), 0) as StreamHandle;
    const dirty = scene.takeDirty();
    expect(dirty.clusters).toEqual([
      { from: first.clusterBase, to: second.clusterBase + second.clusterCount },
    ]);
  });
});

describe('the sphere the shadow camera is fitted to', () => {
  /**
   * **A sphere, and the first version of this wrote a box into the same four floats.**
   *
   * `sceneShadowBounds` has always written centre, centre, centre, *radius*, and the pass reads
   * float 3 as the radius. A `sceneBounds` that wrote `[minX, minY, minZ, maxX, maxY, maxZ]` put
   * the light at the box's minimum corner with `maxX` for a radius, and two of the three GPU-driven
   * rigs lost their shadows — 256 pixels on one and 17,394 on another — which the maintainer saw on
   * the page before the diff was read.
   *
   * So these assert the shape as well as the extent, because the shape is what went wrong.
   */
  function sphere(scene: StreamingScene): { x: number; y: number; z: number; radius: number } {
    const out = new Float32Array(4);
    scene.sceneBounds(out);
    return {
      x: out[0] as number,
      y: out[1] as number,
      z: out[2] as number,
      radius: out[3] as number,
    };
  }

  test('COVERS THE LIVE MESHES AND SHRINKS WHEN ONE LEAVES', () => {
    const scene = new StreamingScene(CAPACITY);
    scene.add(cube(0), at(0), 0);
    const far = scene.add(cube(0), at(100), 0) as StreamHandle;
    expect(sphere(scene).radius).toBeGreaterThan(45);
    scene.remove(far);
    /* This is what makes shadow edges crawl in a streaming world, and the spec says so. */
    expect(sphere(scene).radius).toBeLessThan(10);
  });

  test('A RELEASED CLUSTER IS NOT A CLUSTER AT THE ORIGIN', () => {
    /*
     * **The buffers are sized by capacity, so the records past what is live are zeros**, and a
     * zero record read as a cluster at the origin stretches the sphere all the way back to it.
     * Found by perturbation before it was found by a picture: removing the skip broke nothing,
     * because every scene in this file happened to contain the origin.
     */
    const scene = new StreamingScene(CAPACITY);
    const near = scene.add(cube(0), at(0), 0) as StreamHandle;
    scene.add(cube(0), at(100), 0);
    scene.remove(near);
    const far = sphere(scene);
    /* Centred on the one live mesh rather than halfway back to where the other one was. */
    expect(far.x).toBeGreaterThan(90);
    expect(far.radius).toBeLessThan(10);
  });

  test('an empty scene is a unit sphere rather than a point or an infinity', () => {
    /* `sceneShadowBounds` says why: a radius of zero divides by zero in the fit and every entry of
       the matrix comes back NaN, which reaches the device as a frame that is simply unshadowed. */
    const scene = new StreamingScene(CAPACITY);
    const out = new Float32Array(4).fill(-7);
    scene.sceneBounds(out);
    expect(Array.from(out)).toEqual([0, 0, 0, 1]);
  });
});

describe('what the cone cull reads', () => {
  test('A LEAF SEEN FROM BELOW IS NOT CONE-CULLED, AND A FLOOR SEEN FROM BELOW IS', () => {
    /*
     * **Both directions of one mismatch.** A cluster carries the cosine of its cone's half-angle
     * and the cull is written in its sine. A leaf block's cluster — its top and four sides, the
     * bottom hidden against the leaf below — has a cosine of zero, which read as a sine is a flat
     * cluster pointing up, culled from underneath while its sides face the eye. A floor's cluster
     * has a cosine of one, which read as a sine is a hemisphere, never culled from anywhere. The
     * packing converts, so the scene's own cull data is what this reads.
     */
    const pointingUp = (cosine: number): GpuDrivenMesh => ({
      ...cube(0),
      clusters: {
        ...cube(0).clusters,
        coneAxis: new Float32Array([0, 1, 0]),
        coneCutoff: new Float32Array([cosine]),
      },
    });
    const scene = new StreamingScene(CAPACITY);
    const leaf = scene.add(pointingUp(0), at(0), 0) as StreamHandle;
    const floor = scene.add(pointingUp(1), at(0), 0) as StreamHandle;
    /* Below the cluster and to one side of it, as the sandbox's eye stands under a canopy. */
    const culled = (handle: StreamHandle): boolean => {
      const c = handle.clusterBase * 8;
      const d = scene.cull;
      return coneBackfacing(
        d[c + 4] as number,
        d[c + 5] as number,
        d[c + 6] as number,
        d[c + 7] as number,
        d[c] as number,
        d[c + 1] as number,
        d[c + 2] as number,
        d[c + 3] as number,
        3.5,
        -4,
        0.5,
      );
    };
    expect(culled(leaf)).toBe(false);
    expect(culled(floor)).toBe(true);
  });
});
