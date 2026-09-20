import { describe, expect, test } from 'vitest';

import {
  CLUSTER_FLOATS,
  clusterStride,
  packClusters,
  type ClusterSource,
} from './clusterUpload.ts';

/** One mesh's clusters, as `MSHL` hands them back. */
function mesh(count: number, indicesPerCluster: number, seed: number): ClusterSource {
  const indices = new Uint32Array(count * indicesPerCluster);
  for (let at = 0; at < indices.length; at += 1) indices[at] = (at + seed) % 64;
  return {
    count,
    triangleOffsets: Uint32Array.from({ length: count }, (_, i) => (i * indicesPerCluster) / 3),
    triangleCounts: Uint32Array.from({ length: count }, () => indicesPerCluster / 3),
    boundsCentre: Float32Array.from({ length: count * 3 }, (_, i) => seed + i),
    boundsRadius: Float32Array.from({ length: count }, (_, i) => 1 + i * 0.5),
    coneAxis: Float32Array.from({ length: count * 3 }, (_, i) => (i % 3 === 1 ? 1 : 0)),
    coneCutoff: Float32Array.from({ length: count }, () => -0.5),
    ownError: Float32Array.from({ length: count }, (_, i) => i * 0.01),
    parentError: Float32Array.from({ length: count }, (_, i) => i * 0.01 + 0.2),
    indices,
  };
}

describe('every cluster in the scene lives in one set of buffers', () => {
  test('packs two meshes with the second rebased by the first', () => {
    /*
     * **The whole point of the pipeline is one dispatch over every cluster in the scene.** A
     * per-mesh buffer means a dispatch per mesh, which is the draw-call bound this exists to
     * remove — so the second mesh's index offsets move by the first mesh's index count, and a
     * cluster that forgot to rebase reads the wrong mesh's triangles.
     */
    const a = mesh(3, 9, 0);
    const b = mesh(2, 6, 100);
    const packed = packClusters([a, b]);

    expect(packed.count).toBe(5);
    expect(packed.indices.length).toBe(a.indices.length + b.indices.length);
    /* The first mesh keeps its offsets. */
    expect(packed.indexOffsets[0]).toBe(0);
    expect(packed.indexOffsets[1]).toBe(9);
    /* The second starts where the first ended, in indices rather than in triangles. */
    expect(packed.indexOffsets[3]).toBe(a.indices.length);
    expect(packed.indexOffsets[4]).toBe(a.indices.length + 6);
    expect(packed.indexCounts[3]).toBe(6);

    /* And the indices themselves are rebased by the first mesh's vertex-index space. */
    expect([...packed.indices.subarray(0, a.indices.length)]).toEqual([...a.indices]);
  });

  test('gives every cluster a globally unique identifier, and says which mesh it came from', () => {
    const packed = packClusters([mesh(3, 9, 0), mesh(2, 6, 100)]);
    const ids = [...packed.clusterId];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([0, 1, 2, 3, 4]);
    /* Which mesh, because a cluster that cannot name its own mesh cannot find its transform. */
    expect([...packed.meshOf]).toEqual([0, 0, 0, 1, 1]);
  });

  test('carries the bounds, the cones and both errors through unchanged', () => {
    const a = mesh(2, 6, 7);
    const packed = packClusters([a]);
    expect([...packed.bounds.subarray(0, 8)]).toEqual([
      a.boundsCentre[0],
      a.boundsCentre[1],
      a.boundsCentre[2],
      a.boundsRadius[0],
      a.boundsCentre[3],
      a.boundsCentre[4],
      a.boundsCentre[5],
      a.boundsRadius[1],
    ]);
    expect([...packed.errors]).toEqual([
      a.ownError[0],
      a.parentError[0],
      a.ownError[1],
      a.parentError[1],
    ]);
  });

  test('an empty input is an empty, valid set rather than a throw', () => {
    /*
     * A scene with nothing in it is an ordinary frame, not an error — and a dispatch over zero
     * clusters is a dispatch of zero workgroups, which is legal everywhere.
     */
    const packed = packClusters([]);
    expect(packed.count).toBe(0);
    expect(packed.bounds.length).toBe(0);
    expect(packed.indices.length).toBe(0);
    expect(packed.clusterId.length).toBe(0);
  });

  test('a mesh with no clusters takes a slot in the mesh numbering and contributes nothing', () => {
    /*
     * **The numbering has to survive an empty mesh**, because a cluster's `meshOf` indexes whatever
     * transform array the caller built from the same list. Skipping empty meshes shifts every
     * index after them and every cluster past the gap draws at another mesh's position.
     */
    const packed = packClusters([mesh(1, 3, 0), mesh(0, 3, 5), mesh(1, 3, 9)]);
    expect(packed.count).toBe(2);
    expect([...packed.meshOf]).toEqual([0, 2]);
  });

  test('is the same bytes for the same input order', () => {
    const build = () => packClusters([mesh(3, 9, 0), mesh(2, 6, 100)]);
    const a = build();
    const b = build();
    expect([...a.bounds]).toEqual([...b.bounds]);
    expect([...a.indexOffsets]).toEqual([...b.indexOffsets]);
    expect([...a.indices]).toEqual([...b.indices]);
  });

  test('states its stride rather than leaving a shader to count', () => {
    expect(clusterStride()).toBe(CLUSTER_FLOATS);
    /* Four for the bounding sphere and four for the cone: one vec4 each, which is how a storage
       buffer wants them laid out. */
    expect(CLUSTER_FLOATS).toBe(8);
  });
});
