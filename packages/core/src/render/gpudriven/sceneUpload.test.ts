import { expect, test } from 'vitest';

import { packClusters, type ClusterSource } from './clusterUpload.ts';
import { buildGpuDrivenScene, type GpuDrivenMesh } from './sceneUpload.ts';

/**
 * One triangle, with its three vertices at `x = base, base + 1, base + 2` so a rebasing fault
 * shows up as a position rather than as an index nobody reads out.
 */
function triangleMesh(base: number, material: number, clusters = 1): GpuDrivenMesh {
  const vertices = 3 * clusters;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colours = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v += 1) {
    positions[v * 3] = base + v;
    normals[v * 3 + 1] = 1;
    colours[v * 3] = (base + v) / 100;
  }
  const indices = new Uint32Array(vertices);
  for (let v = 0; v < vertices; v += 1) indices[v] = v;

  const source: ClusterSource = {
    count: clusters,
    triangleOffsets: Uint32Array.from({ length: clusters }, (_unused, c) => c),
    triangleCounts: new Uint32Array(clusters).fill(1),
    boundsCentre: new Float32Array(clusters * 3),
    boundsRadius: new Float32Array(clusters).fill(1),
    coneAxis: new Float32Array(clusters * 3),
    coneCutoff: new Float32Array(clusters).fill(-1),
    ownError: new Float32Array(clusters),
    parentError: new Float32Array(clusters).fill(Infinity),
    indices,
  };
  return { positions, normals, colours, clusters: source, material };
}

test('A SECOND MESH IS REBASED INTO THE SCENE VERTEX BUFFER, or it draws the first mesh', () => {
  /*
   * `packClusters` rebases index *offsets* and leaves index *values* alone, because it has never
   * been told where a mesh's vertices landed. So every mesh after the first addresses vertex zero
   * of the scene — which is the first mesh's first vertex, a real vertex, drawn in the wrong place
   * with no error anywhere.
   */
  const scene = buildGpuDrivenScene([triangleMesh(0, 0), triangleMesh(10, 0)]);
  expect(Array.from(scene.clusters.indices)).toEqual([0, 1, 2, 3, 4, 5]);
});

test('and the positions the rebased indices reach are the second mesh’s own', () => {
  const scene = buildGpuDrivenScene([triangleMesh(0, 0), triangleMesh(10, 0)]);
  const at = scene.clusters.indices[3] as number;
  expect(scene.positions[at * 3]).toBe(10);
  expect(scene.vertexCount).toBe(6);
});

test('normals and colours concatenate in the same order as the positions', () => {
  const scene = buildGpuDrivenScene([triangleMesh(0, 0), triangleMesh(10, 0)]);
  expect(scene.normals[3 * 3 + 1]).toBe(1);
  expect(scene.colours[3 * 3]).toBeCloseTo(0.1, 6);
  expect(scene.normals.length).toBe(scene.positions.length);
  expect(scene.colours.length).toBe(scene.positions.length);
});

test('every cluster takes the material of the mesh it came from', () => {
  const scene = buildGpuDrivenScene([triangleMesh(0, 3, 2), triangleMesh(10, 7, 1)]);
  expect(Array.from(scene.materialOf)).toEqual([3, 3, 7]);
});

test('A MESH WITH NO CLUSTERS STILL TAKES ITS SLOT, so later transforms stay their own', () => {
  /*
   * `meshOf` indexes the caller's transform array, so a mesh skipped here shifts every mesh after
   * it and each of their clusters draws with somebody else's matrix. The vertex base moves with it
   * for the same reason: skipping the vertices would leave the index rebasing one mesh out of step.
   */
  const empty = triangleMesh(100, 1);
  const scene = buildGpuDrivenScene([
    triangleMesh(0, 0),
    { ...empty, clusters: emptyOf(empty) },
    triangleMesh(20, 2),
  ]);
  expect(Array.from(scene.clusters.meshOf)).toEqual([0, 2]);
  expect(scene.vertexBase[2]).toBe(6);
  expect(scene.positions[(scene.clusters.indices[3] as number) * 3]).toBe(20);
});

function emptyOf(mesh: GpuDrivenMesh): ClusterSource {
  return { ...mesh.clusters, count: 0, indices: new Uint32Array(0) };
}

test('the cluster buffers are what packClusters would have built from the rebased sources', () => {
  /*
   * The bounds, cones, errors and identifiers are `clusterUpload.ts`'s and are not re-derived
   * here — this module adds the vertices and the materials and nothing else. Asserted against the
   * packer directly so a second copy of the packing cannot appear without this failing.
   */
  const meshes = [triangleMesh(0, 0), triangleMesh(10, 1)];
  const scene = buildGpuDrivenScene(meshes);
  const rebased = meshes.map((mesh, at) => ({
    ...mesh.clusters,
    indices: mesh.clusters.indices.map((index) => index + (scene.vertexBase[at] as number)),
  }));
  expect(Array.from(scene.clusters.clusterId)).toEqual(Array.from(packClusters(rebased).clusterId));
  expect(Array.from(scene.clusters.indexOffsets)).toEqual(
    Array.from(packClusters(rebased).indexOffsets),
  );
});

test('A MESH’S UVS ARE REBASED WITH ITS VERTICES, and a mesh without any reads zero', () => {
  const first = triangleMesh(0, 0);
  const second = {
    ...triangleMesh(10, 1),
    uvs: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
  };
  const scene = buildGpuDrivenScene([first, second]);
  expect(scene.uvs.length).toBe(scene.vertexCount * 2);
  expect(Array.from(scene.uvs.subarray(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
  expect(Array.from(scene.uvs.subarray(6, 12)).map((x) => Math.round(x * 10) / 10)).toEqual([
    0.1, 0.2, 0.3, 0.4, 0.5, 0.6,
  ]);
});

test('uvs of the wrong length are refused rather than read past their end', () => {
  const broken = { ...triangleMesh(0, 0), uvs: new Float32Array(4) };
  expect(() => buildGpuDrivenScene([broken])).toThrow(/4 uv values for 3 vertices/);
});
