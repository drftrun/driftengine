import { expect, test } from 'vitest';
import { buildClusters } from './cluster.ts';
import type { MeshData } from '@driftengine/drft';

/** A flat quad grid: (cells+1)^2 vertices, cells^2 * 2 triangles. */
function grid(cells: number): MeshData {
  const side = cells + 1;
  const positions = new Float32Array(side * side * 3);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const at = (y * side + x) * 3;
      positions[at] = x;
      positions[at + 1] = 0;
      positions[at + 2] = y;
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const a = y * side + x;
      indices.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
    }
  }
  const vertices = side * side;
  return {
    positions,
    normals: new Float32Array(vertices * 3),
    colors: new Float32Array(vertices * 3),
    emissive: new Float32Array(vertices),
    indices: new Uint32Array(indices),
  } as MeshData;
}

test('every triangle lands in exactly one cluster', () => {
  const mesh = grid(14);
  const set = buildClusters(mesh, 128);
  let total = 0;
  for (let i = 0; i < set.count; i += 1) total += set.triangleCounts[i] as number;
  expect(total).toBe(mesh.indices.length / 3);
});

test('no cluster exceeds the target triangle count', () => {
  const set = buildClusters(grid(14), 128);
  for (let i = 0; i < set.count; i += 1) {
    expect(set.triangleCounts[i]).toBeLessThanOrEqual(128);
  }
});

test('a cluster bound contains every vertex of its own triangles', () => {
  const mesh = grid(8);
  const set = buildClusters(mesh, 64);
  for (let c = 0; c < set.count; c += 1) {
    const at = set.triangleOffsets[c] as number;
    const count = set.triangleCounts[c] as number;
    const cx = set.boundsCentre[c * 3] as number;
    const cy = set.boundsCentre[c * 3 + 1] as number;
    const cz = set.boundsCentre[c * 3 + 2] as number;
    const r = set.boundsRadius[c] as number;
    for (let i = at * 3; i < (at + count) * 3; i += 1) {
      const v = (set.indices[i] as number) * 3;
      const d = Math.hypot(
        (mesh.positions[v] as number) - cx,
        (mesh.positions[v + 1] as number) - cy,
        (mesh.positions[v + 2] as number) - cz,
      );
      expect(d).toBeLessThanOrEqual(r + 1e-4);
    }
  }
});

test('a flat grid gives every cluster a tight normal cone', () => {
  const set = buildClusters(grid(8), 64);
  for (let c = 0; c < set.count; c += 1) {
    expect(set.coneCutoff[c]).toBeGreaterThan(0.99);
  }
});

test('clustering is deterministic, because the baker output has to be reproducible', () => {
  const a = buildClusters(grid(8), 64);
  const b = buildClusters(grid(8), 64);
  expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  expect(Array.from(a.triangleCounts)).toEqual(Array.from(b.triangleCounts));
});

test('a mesh smaller than one cluster gives exactly one cluster', () => {
  expect(buildClusters(grid(1), 128).count).toBe(1);
});

test('every index of the source survives the reorder', () => {
  const mesh = grid(6);
  const set = buildClusters(mesh, 32);
  const before = Array.from(mesh.indices).sort((x, y) => x - y);
  const after = Array.from(set.indices).sort((x, y) => x - y);
  expect(after).toEqual(before);
});

test('A LARGE MESH CLUSTERS AT ALL, which the first algorithm here could not', () => {
  /*
   * **The measurement, because a cost claim without one is a hope.** The growth loop originally
   * scanned every triangle in the mesh to choose each member of each cluster, which is cubic in
   * the mesh: 128 triangles took 16 ms, 2,048 took 1.9 s and 4,608 took 9.7 s on the machine this
   * was written on. A million-triangle asset — which is what the plan's dense scene asks for —
   * extrapolates to days, so the offline half of this wave could not be run on anything anybody
   * would ship.
   *
   * 25,088 triangles is 30x the largest size the old loop could do in ten seconds, and the bound
   * here is loose on purpose: what it is guarding against is a return to the old shape, which
   * misses this by two orders of magnitude, not a regression of a few per cent.
   */
  const mesh = grid(112);
  expect(mesh.indices.length / 3).toBe(25088);
  const started = performance.now();
  const set = buildClusters(mesh, 128);
  const ms = performance.now() - started;
  expect(ms).toBeLessThan(3000);
  expect(set.count).toBe(Math.ceil(25088 / 128));
});

/** A cheap order-sensitive digest, so the whole reordering is one number a test can hold. */
function digest(indices: Uint32Array): number {
  let value = 0;
  for (let at = 0; at < indices.length; at += 1) {
    value = (value * 31 + ((indices[at] as number) + 1) * (at + 1)) % 2147483647;
  }
  return value;
}

test('THE FRONTIER WALK ANSWERS WHAT THE WHOLE-MESH SCAN ANSWERED, index for index', () => {
  /*
   * **Captured from the quadratic version before it was replaced, and it matched byte for byte.**
   * That is the claim the rewrite rests on: growth picks the unassigned triangle sharing the most
   * vertices with the cluster so far, and a triangle sharing none can never be picked — so
   * restricting the search to the vertex-adjacent ones changes which triangles are *considered*
   * and not which is chosen. The tie-break is written out in the loop for the same reason, because
   * a frontier is not in index order and the old scan got its tie-break from being one.
   *
   * A digest rather than six hundred numbers, because what is being pinned is the whole ordering
   * and not any one entry of it.
   */
  const set = buildClusters(grid(10), 32);
  expect(Array.from(set.triangleCounts)).toEqual([32, 32, 32, 32, 32, 32, 8]);
  expect(Array.from(set.indices.subarray(0, 12))).toEqual([
    0, 1, 11, 1, 12, 11, 1, 2, 12, 2, 13, 12,
  ]);
  expect(digest(set.indices)).toBe(304394967);
});

/**
 * The same flat grid with every quad owning its four corners, as a voxel mesher writes it and as
 * a box built face by face does: no vertex index is shared between two quads.
 */
function unwelded(cells: number): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const base = positions.length / 3;
      positions.push(x, 0, y, x + 1, 0, y, x, 0, y + 1, x + 1, 0, y + 1);
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  const vertices = positions.length / 3;
  return {
    positions: Float32Array.from(positions),
    normals: new Float32Array(vertices * 3),
    colors: new Float32Array(vertices * 3),
    emissive: new Float32Array(vertices),
    indices: Uint32Array.from(indices),
  } as MeshData;
}

/** Every triangle as a string, sorted, so two index buffers can be compared as sets of faces. */
function faces(indices: Uint32Array): string[] {
  const out: string[] = [];
  for (let t = 0; t < indices.length / 3; t += 1) {
    out.push(`${indices[t * 3]},${indices[t * 3 + 1]},${indices[t * 3 + 2]}`);
  }
  return out.sort();
}

test('A MESH WHOSE FACES OWN THEIR CORNERS GROWS BY POSITION WHEN IT ASKS TO', () => {
  /*
   * **Growth by shared index stops at every seam a mesh has split**, and a voxel mesh is nothing
   * but seams: each face carries its own uv and its own occlusion, so no two faces share a vertex
   * and every quad became a cluster of two triangles. A median chunk of the voxel sandbox was 1,012
   * clusters for 2,024 triangles, which a frame then culls one quad at a time.
   */
  const mesh = unwelded(16);
  expect(buildClusters(mesh, 128).count).toBe(256);
  const byPosition = buildClusters(mesh, 128, { share: 'position' });
  expect(Array.from(byPosition.triangleCounts)).toEqual([128, 128, 128, 128]);
});

test('AND WRITES THE MESH’S OWN INDICES, because a corner is a face’s own uv and colour', () => {
  /* Welding decides who is a neighbour and nothing else: an index that pointed at a welded
     vertex would give a face its neighbour's texture coordinate. */
  const mesh = unwelded(6);
  const set = buildClusters(mesh, 16, { share: 'position' });
  expect(faces(set.indices)).toEqual(faces(mesh.indices as Uint32Array));
});

test('on a mesh that already shares its vertices, position and index agree index for index', () => {
  /* The pinned walk above, asked for by position: every vertex is its own position there, so the
     canonical corner is the corner and nothing about the growth may move. */
  const set = buildClusters(grid(10), 32, { share: 'position' });
  expect(digest(set.indices)).toBe(304394967);
});

test('the default is sharing by index, which is what every baked container was hashed with', () => {
  expect(buildClusters(unwelded(8), 32).count).toBe(64);
  expect(digest(buildClusters(grid(10), 32, { share: 'index' }).indices)).toBe(304394967);
});

test('growth by position is as reproducible as growth by index', () => {
  const a = buildClusters(unwelded(9), 32, { share: 'position' });
  const b = buildClusters(unwelded(9), 32, { share: 'position' });
  expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  expect(Array.from(a.triangleCounts)).toEqual(Array.from(b.triangleCounts));
});
