import { expect, test } from 'vitest';
import { buildSheets } from './surfaceSheet.ts';
import type { SheetSpan } from './surfaceSheet.ts';

function span(x0: number, z0: number, x1: number, z1: number, y = 5): SheetSpan {
  return { x0, z0, x1, z1, y };
}

/** Total area the emitted triangles actually cover. */
function triangleArea(positions: Float32Array): number {
  let total = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i] as number;
    const ay = positions[i + 1] as number;
    const az = positions[i + 2] as number;
    const bx = positions[i + 3] as number;
    const by = positions[i + 4] as number;
    const bz = positions[i + 5] as number;
    const cx = positions[i + 6] as number;
    const cy = positions[i + 7] as number;
    const cz = positions[i + 8] as number;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return total;
}

test('the triangles cover a bent sheet exactly, so a curve cannot open a seam', () => {
  /*
   * The defect this catches is what a chain of independent rectangles does at a
   * bend: a notch at every joint, or an overlap. Both are small and both are
   * fatal here, because this sheet is either water or a surface with light
   * crawling across it, and a hairline gap in either reads as broken.
   *
   * Areas are hand-derived: a 6 x 4 rectangle, then a parallelogram with a base
   * of 4 offset by (3, 3), whose area is |(0,4) x (3,3)| = 12.
   */
  const mesh = buildSheets(
    [{ spans: [span(0, -2, 0, 2), span(6, -2, 6, 2), span(9, 1, 9, 5)] }],
    0.75,
    () => undefined,
  );

  expect(triangleArea(mesh.positions)).toBeCloseTo(24 + 12, 6);
});

test('cells are no coarser than asked, and the local coordinate reaches the rim', () => {
  /*
   * Two properties, one mesh. Cell size is what decides whether a wave shorter
   * than the sheet is visible at all — a channel cut into four cells carries no
   * ripples however good the shader is. And the local coordinate has to reach 0
   * and 1 *exactly* at the outermost vertices: an edge fade that only nearly
   * closes leaves a hard rim, which is the failure the ocean's own horizon
   * already paid for.
   *
   * 12 m by 4 m at 1 m cells is 12 x 4 cells, six vertices each.
   */
  const mesh = buildSheets(
    [{ spans: [span(0, -2, 0, 2), span(12, -2, 12, 2)] }],
    1,
    () => undefined,
  );

  expect(mesh.vertexCount).toBe(12 * 4 * 6);

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < mesh.locals.length; i += 2) {
    const u = mesh.locals[i] as number;
    const v = mesh.locals[i + 1] as number;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  expect(minU).toBe(0);
  expect(maxU).toBe(1);
  expect(minV).toBe(0);
  expect(maxV).toBe(1);
});

test('a degenerate sheet produces no geometry rather than NaN', () => {
  // All four of these arrive eventually: a generator is seeded, a channel can be
  // asked for at a point where the route has no room for one, and a blank frame
  // or a NaN in a vertex buffer is a much worse answer than nothing.
  const cases = [
    [],
    [{ spans: [] }],
    [{ spans: [span(0, -2, 0, 2)] }],
    [{ spans: [span(0, 0, 0, 0), span(4, 0, 4, 0)] }],
  ];
  for (const sheets of cases) {
    const mesh = buildSheets(sheets, 0.5, () => undefined);
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.positions.length).toBe(0);
  }

  // And a nonsense cell size is not a divide-by-zero either.
  const zeroCell = buildSheets(
    [{ spans: [span(0, -2, 0, 2), span(6, -2, 6, 2)] }],
    0,
    () => undefined,
  );
  expect(zeroCell.vertexCount).toBe(0);
});
