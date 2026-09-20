import { expect, test } from 'vitest';
import { buildClusters } from './cluster.ts';
import { buildClusterDag } from './clusterLod.ts';
import type { MeshData } from '@driftengine/drft';

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

function dag(cells: number, target = 64) {
  const mesh = grid(cells);
  return buildClusterDag(buildClusters(mesh, target), mesh, { target });
}

test('a dense mesh produces more than one level', () => {
  expect(dag(16).levels.length).toBeGreaterThan(1);
});

test('error is monotonic along every parent link, which is the whole guarantee', () => {
  for (const level of dag(16).levels) {
    for (let c = 0; c < level.set.count; c += 1) {
      expect(level.ownError[c] as number).toBeLessThanOrEqual(
        (level.parentError[c] as number) + 1e-6,
      );
    }
  }
});

test('the finest level has zero error, because it is the source mesh', () => {
  const finest = dag(16).levels[0];
  for (let c = 0; c < (finest?.set.count ?? 0); c += 1) {
    expect(finest?.ownError[c]).toBe(0);
  }
});

test('clusters in one group share a parent error, so they cannot disagree at a shared edge', () => {
  for (const level of dag(16).levels) {
    const byGroup = new Map<number, number[]>();
    for (let c = 0; c < level.set.count; c += 1) {
      const g = level.groupOf[c] as number;
      const list = byGroup.get(g) ?? [];
      list.push(level.parentError[c] as number);
      byGroup.set(g, list);
    }
    for (const errors of byGroup.values()) {
      for (const e of errors) expect(e).toBeCloseTo(errors[0] as number, 6);
    }
  }
});

test('each level is coarser than the one below it', () => {
  const levels = dag(16).levels;
  for (let i = 1; i < levels.length; i += 1) {
    const finer = levels[i - 1]?.set.indices.length ?? 0;
    const coarser = levels[i]?.set.indices.length ?? 0;
    expect(coarser).toBeLessThan(finer);
  }
});

test('error rises with every level', () => {
  const levels = dag(16).levels;
  for (let i = 1; i < levels.length; i += 1) {
    const below = Math.max(...Array.from(levels[i - 1]?.ownError ?? [0]));
    const here = Math.max(...Array.from(levels[i]?.ownError ?? [0]));
    expect(here).toBeGreaterThanOrEqual(below);
  }
});

test('the graph is deterministic', () => {
  const a = dag(12);
  const b = dag(12);
  expect(a.levels.length).toBe(b.levels.length);
  for (let i = 0; i < a.levels.length; i += 1) {
    expect(Array.from(a.levels[i]?.ownError ?? [])).toEqual(
      Array.from(b.levels[i]?.ownError ?? []),
    );
    expect(Array.from(a.levels[i]?.set.indices ?? [])).toEqual(
      Array.from(b.levels[i]?.set.indices ?? []),
    );
  }
});
