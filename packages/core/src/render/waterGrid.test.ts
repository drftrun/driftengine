import { expect, test } from 'vitest';
import { buildWaterGrid } from './waterGrid.ts';

const RESOLUTION = 128;
const NEAR_EXTENT = 500;
const FAR_HALF = 30000;

test('the wave sheet stays uniform so its lattice survives camera snapping', () => {
  /*
   * The failure this guards against looks like a rendering glitch rather than a
   * geometry bug: the surface swims underfoot as you move.
   *
   * The grid origin snaps to whole cells. That only holds the wave field still
   * if every cell *is* the snap quantum — then a one-cell shift lands each
   * vertex exactly where its neighbour was and the sampled surface is unchanged.
   * Cells wider than the quantum get re-sampled at a new phase on every snap.
   */
  const grid = buildWaterGrid(RESOLUTION, NEAR_EXTENT, FAR_HALF);

  expect(grid.cellSize).toBeCloseTo(NEAR_EXTENT / RESOLUTION, 10);
  for (let x = 0; x < RESOLUTION; x++) {
    const spacing = (grid.offsets[(x + 1) * 2] ?? 0) - (grid.offsets[x * 2] ?? 0);
    expect(spacing, `cell ${x} matches the snap quantum`).toBeCloseTo(grid.cellSize, 4);
  }
  expect(grid.nearHalfExtent).toBe(NEAR_EXTENT / 2);
});

test('the skirt steps out to the horizon rather than leaping there', () => {
  /*
   * Reach alone is not enough. Fog is evaluated per fragment from world
   * position, so a single triangle spanning the near rim to the far edge
   * compresses the whole fog gradient into the few pixels it covers — which
   * restores the hard line at the rim that the skirt exists to remove.
   *
   * So no ring may be more than a small multiple of the previous one: that
   * bounds how much fog a single triangle can span.
   */
  const grid = buildWaterGrid(RESOLUTION, NEAR_EXTENT, FAR_HALF);

  const radii = new Set<number>();
  const nearVertices = (RESOLUTION + 1) ** 2;
  for (let v = nearVertices; v < grid.offsets.length / 2; v++) {
    const x = grid.offsets[v * 2] ?? 0;
    const z = grid.offsets[v * 2 + 1] ?? 0;
    radii.add(Number(Math.max(Math.abs(x), Math.abs(z)).toFixed(3)));
  }

  const sorted = [...radii].sort((a, b) => a - b);
  expect(sorted[0], 'the skirt starts exactly at the near rim').toBeCloseTo(grid.nearHalfExtent, 2);
  expect(sorted[sorted.length - 1]).toBeCloseTo(FAR_HALF, 0);
  expect(sorted.length, 'enough rings to resolve the gradient').toBeGreaterThan(8);

  for (let i = 1; i < sorted.length; i++) {
    const ratio = (sorted[i] ?? 0) / (sorted[i - 1] ?? 1);
    expect(ratio, `ring ${i} step`).toBeLessThan(2.2);
  }
});

test('every triangle references a real vertex', () => {
  // The skirt is stitched by index arithmetic that wraps at each ring's last
  // vertex; an off-by-one there draws garbage rather than failing loudly.
  const grid = buildWaterGrid(16, 64, 5000);
  const vertexCount = grid.offsets.length / 2;
  for (const index of grid.indices) {
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(vertexCount);
  }
  expect(grid.indices.length % 3).toBe(0);

  // The skirt must stay a rounding error next to the sheet it extends.
  const nearTriangles = 16 * 16 * 2;
  expect(grid.indices.length / 3 - nearTriangles).toBeLessThan(1500);
});
