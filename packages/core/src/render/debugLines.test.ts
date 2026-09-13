import { expect, test } from 'vitest';

import { DebugLines } from './debugLines.ts';
import { MeshBuilder } from '../geometry/meshBuilder.ts';
import { boxShape, capsuleShape, cylinderShape, sphereShape } from '@driftengine/physics';

/** Stands in for a corner TypeScript cannot prove is there; the arrays below all have four. */
const A: [number, number, number] = [0, 0, 0];

/** The `n`th segment, as two points. */
function segment(lines: DebugLines, n: number): { from: number[]; to: number[] } {
  const { from, to } = lines.segments;
  return {
    from: [from[n * 3] ?? 0, from[n * 3 + 1] ?? 0, from[n * 3 + 2] ?? 0],
    to: [to[n * 3] ?? 0, to[n * 3 + 1] ?? 0, to[n * 3 + 2] ?? 0],
  };
}

/**
 * The bug this whole facility exists for, drawn.
 *
 * The same four corners in the same order, through `addQuad` and through `addGroundQuad`: one
 * lights from below and one from above, and the difference is invisible on a screenshot lit by
 * anything near the floor. It is four segments pointing opposite ways here, in a unit test, which
 * is the point — the same four segments on screen are what turns "why is the tarmac black at
 * midday" into ten seconds.
 */
test('normals show which way a face is actually pointing', () => {
  const corners: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ];
  const trap = new MeshBuilder()
    .addQuad(corners[0] ?? A, corners[1] ?? A, corners[2] ?? A, corners[3] ?? A, [1, 1, 1])
    .build();
  const fixed = new MeshBuilder()
    .addGroundQuad(corners[0] ?? A, corners[1] ?? A, corners[2] ?? A, corners[3] ?? A, [1, 1, 1])
    .build();

  const lines = new DebugLines(64);
  lines.normals(trap, 0.5);
  expect(lines.segments.count, 'one spike per vertex').toBe(4);
  const down = segment(lines, 0);
  expect(down.from).toEqual([0, 0, 0]);
  expect(down.to, 'the trap points into the ground').toEqual([0, -0.5, 0]);

  lines.clear();
  lines.normals(fixed, 0.5);
  expect(segment(lines, 0).to, 'and the wrapper points at the sky').toEqual([0, 0.5, 0]);
});

test('a stride draws fewer of them, for a mesh nobody can see through', () => {
  const mesh = new MeshBuilder().addBox([0, 0, 0], [1, 1, 1], [1, 1, 1]).build();
  const lines = new DebugLines(64);
  lines.normals(mesh, 0.1, 4);
  expect(mesh.positions.length / 3, 'a box is four vertices a face').toBe(24);
  expect(lines.segments.count).toBe(6);
});

/**
 * Twelve edges from six face loops of four, which is the deduplication working.
 *
 * Each edge of a box lies in two faces, once each way round, so keeping only the ascending pair
 * draws each exactly once. Without that the picture is identical and costs twenty-four segments,
 * which matters precisely when the capacity is what stops the drawing.
 */
test('a box collider is twelve edges, not twenty-four', () => {
  const lines = new DebugLines(64);
  lines.shape(boxShape(1, 2, 3), 10, 0, 0);
  expect(lines.segments.count).toBe(12);

  for (let i = 0; i < 12; i++) {
    const { from, to } = segment(lines, i);
    let differing = 0;
    for (let axis = 0; axis < 3; axis++) if (from[axis] !== to[axis]) differing++;
    expect(differing, `edge ${i} runs along exactly one axis`).toBe(1);
    expect(Math.abs((from[0] ?? 0) - 10), 'and sits at the body, not the origin').toBe(1);
  }
});

test('a sphere is three great circles at its own radius', () => {
  const lines = new DebugLines(256);
  lines.shape(sphereShape(2), 0, 5, 0);
  expect(lines.segments.count, 'three rings of twenty-four').toBe(72);
  for (let i = 0; i < lines.segments.count; i++) {
    const { from } = segment(lines, i);
    expect(Math.hypot(from[0] ?? 0, (from[1] ?? 0) - 5, from[2] ?? 0)).toBeCloseTo(2, 6);
  }
});

test('a capsule is a ball at each end and four lines down the side', () => {
  const lines = new DebugLines(512);
  lines.shape(capsuleShape(0.5, 1), 0, 0, 0);
  expect(lines.segments.count, '72 a ball, twice, and four sides').toBe(148);

  /* The side lines are the last four, each a metre and a half long: two half-heights. */
  const side = segment(lines, 147);
  expect(
    Math.hypot(
      (side.to[0] ?? 0) - (side.from[0] ?? 0),
      (side.to[1] ?? 0) - (side.from[1] ?? 0),
      (side.to[2] ?? 0) - (side.from[2] ?? 0),
    ),
  ).toBeCloseTo(2, 6);
});

test('a cylinder is two flat caps rather than two balls', () => {
  const lines = new DebugLines(512);
  lines.shape(cylinderShape(0.5, 1), 0, 0, 0);
  /* Two rings of twenty-four and four sides: a sharp rim, which is what a cylinder has. */
  expect(lines.segments.count).toBe(52);
  const rim = segment(lines, 0);
  expect(rim.from[1], 'the cap sits at the end, flat').toBeCloseTo(-1, 6);
});

/**
 * A body turned, drawn where it is.
 *
 * A quarter turn about Y sends local +X to −Z, so a box two metres wide in x and six deep in z
 * reaches three metres in x and one in z afterwards. Read off the drawn segments rather than from
 * the shape, which is the only way this test can tell the rotation happened.
 */
test('a collider is drawn in the pose its body holds', () => {
  const lines = new DebugLines(64);
  const half = Math.SQRT1_2;
  lines.shape(boxShape(1, 2, 3), 0, 0, 0, 0, half, 0, half);

  let maxX = 0;
  let maxZ = 0;
  for (let i = 0; i < lines.segments.count; i++) {
    const { from } = segment(lines, i);
    maxX = Math.max(maxX, Math.abs(from[0] ?? 0));
    maxZ = Math.max(maxZ, Math.abs(from[2] ?? 0));
  }
  expect(maxX, 'the deep axis is now across').toBeCloseTo(3, 6);
  expect(maxZ, 'and the wide one runs away').toBeCloseTo(1, 6);
});

/**
 * Overflow is a number to read, never an exception.
 *
 * A drawer that threw when it ran out of room would take the frame down at the exact moment
 * somebody was trying to see what was wrong with it.
 */
test('running out of room is counted rather than thrown', () => {
  const lines = new DebugLines(4);
  expect(() => lines.shape(boxShape(1, 1, 1), 0, 0, 0)).not.toThrow();
  expect(lines.segments.count).toBe(4);
  expect(lines.dropped, 'eight of the twelve edges had nowhere to go').toBe(8);

  lines.clear();
  expect(lines.dropped).toBe(0);
  expect(lines.segments.count).toBe(0);
});
