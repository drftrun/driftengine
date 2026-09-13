import { expect, test } from 'vitest';
import { buildCoarseLevel, isOutlineWorthWriting } from './coarseLevel.ts';
import { validateMeshData } from '@driftengine/drft';
import type { MeshData } from '@driftengine/drft';

/**
 * A flat grid, finely tessellated, facing +Y. `steps` quads on a side, spanning 0 to 1.
 *
 * Fine relative to the cell on purpose: that is the case a coarse level exists for. Every one of
 * these triangles falls inside a single cell, so what the outline is built from is the *boundary
 * of the cells they occupy* rather than anything the triangles are connected into.
 */
function grid(steps: number): MeshData {
  const side = steps + 1;
  const vertices = side * side;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const emissive = new Float32Array(vertices);
  for (let iz = 0; iz < side; iz++) {
    for (let ix = 0; ix < side; ix++) {
      const at = (iz * side + ix) * 3;
      positions[at] = ix / steps;
      positions[at + 1] = 0;
      positions[at + 2] = iz / steps;
      normals[at + 1] = 1;
      colors[at] = 0.5;
      colors[at + 1] = 0.25;
      colors[at + 2] = 0.125;
    }
  }
  const indices = new Uint32Array(steps * steps * 6);
  let at = 0;
  for (let iz = 0; iz < steps; iz++) {
    for (let ix = 0; ix < steps; ix++) {
      const a = iz * side + ix;
      indices[at++] = a;
      indices[at++] = a + 1;
      indices[at++] = a + side + 1;
      indices[at++] = a;
      indices[at++] = a + side + 1;
      indices[at++] = a + side;
    }
  }
  return { positions, normals, colors, emissive, indices };
}

test('a fine surface becomes a coarse one that is inside it, and every array covers every vertex', () => {
  const source = grid(8);
  const level = buildCoarseLevel([source], { cells: 4 });
  expect(level).not.toBeNull();
  if (level === null) return;

  /*
   * The check the whole format exists downstream of. A coarse level is a `MESH` payload like
   * any other, so an attribute that does not cover every vertex is drawn by some drivers and
   * dropped by others — and this one is *generated*, so nobody would think to look at it.
   */
  validateMeshData(level);

  /*
   * How far back a flat surface goes, hand-derived, and it is the *margin only*. The span is 1
   * and 4 cells were asked for, so a cell is 0.25, and the default margin is 0.3 of one, which
   * is 0.075. Every cell here holds one flat surface facing +Y, so every node sits on it and no
   * cell's plane demands anything further: a coarse surface that is genuinely flat is held just
   * under the part covering it rather than a whole cell under it.
   *
   * Both faces of the hull land on the same plane, which is right for a surface with no
   * thickness. A shell an outline stands in for is drawn from both sides, so a hull that closed
   * around a plane of zero depth would be inventing a volume the asset does not have.
   */
  for (let at = 1; at < level.positions.length; at += 3) {
    expect(level.positions[at]).toBeCloseTo(-0.075, 5);
  }

  /* Coarser than what it stands for, which is the point, and it kept the colour. */
  expect(level.indices.length).toBeGreaterThan(0);
  expect(level.indices.length).toBeLessThan(source.indices.length);
  expect(level.positions.length / 3).toBeLessThan(source.positions.length / 3);
  expect(level.colors[0]).toBeCloseTo(0.5, 5);
  expect(level.colors[1]).toBeCloseTo(0.25, 5);

  /* Two bakes of one asset must not differ, or `drft-diff` compares noise. */
  const again = buildCoarseLevel([source], { cells: 4 });
  expect(Array.from(again?.positions ?? [])).toEqual(Array.from(level.positions));
  expect(Array.from(again?.indices ?? [])).toEqual(Array.from(level.indices));
});

test('no part of the outline sticks out through the surface it stands for', () => {
  /*
   * The invariant the whole inset exists for, on the shape that breaks a constant one: a concave
   * crease. A floor facing up and a wall facing in, meeting at the origin, so the room is
   * `x > 0, y > 0` and being *behind* either surface means being out of the room.
   *
   * A cluster in the corner cell averages floor corners and wall corners, so it lands inside the
   * room — in front of both of the surfaces it stands for — and every frame that draws the
   * outline under a finished floor then shows it through the floor. Measured on the real car
   * before this was fixed: four centimetres of coarse surface through the body panels, which
   * read as blistering.
   *
   * So: no vertex of the outline may be inside the room. A floor cluster clears it on `y`, a
   * wall cluster on `x`, and the corner cluster has to clear it on both — which it only does
   * because the push is measured from the corners that formed it rather than guessed at.
   */
  const floor = grid(8);
  const wall = grid(8);
  for (let at = 0; at < wall.positions.length; at += 3) {
    /* (x, 0, z) becomes (0, x, z): the same grid, stood up, facing +X. */
    wall.positions[at + 1] = wall.positions[at] as number;
    wall.positions[at] = 0;
    wall.normals[at] = 1;
    wall.normals[at + 1] = 0;
  }

  const level = buildCoarseLevel([floor, wall], { cells: 4 });
  expect(level).not.toBeNull();
  if (level === null) return;

  for (let at = 0; at + 2 < level.positions.length; at += 3) {
    const x = level.positions[at] as number;
    const y = level.positions[at + 1] as number;
    expect(Math.min(x, y), `vertex ${at / 3} is inside the room at ${x}, ${y}`).toBeLessThanOrEqual(
      1e-6,
    );
  }
});

test('a surface thinner than a cell is not pushed off itself', () => {
  /*
   * The thin-feature case `DIRECTED` exists for: a plate with a front and a back, both inside
   * one cell layer. Their normals cancel, so there is no direction to inset along, and pushing
   * the single sheet that results along either face's normal would move it clean out of the
   * part it stands for — a wing mirror's outline floating beside the mirror.
   */
  const front = grid(4);
  const back = grid(4);
  for (let at = 1; at < back.normals.length; at += 3) back.normals[at] = -1;
  const flipped = new Uint32Array(back.indices.length);
  for (let at = 0; at + 2 < back.indices.length; at += 3) {
    flipped[at] = back.indices[at + 2] as number;
    flipped[at + 1] = back.indices[at + 1] as number;
    flipped[at + 2] = back.indices[at] as number;
  }
  const level = buildCoarseLevel([front, { ...back, indices: flipped }], { cells: 4 });
  expect(level).not.toBeNull();
  if (level === null) return;

  for (let at = 1; at < level.positions.length; at += 3) {
    expect(level.positions[at], 'the sheet stays in the plate').toBeCloseTo(0, 6);
  }
});

test('nothing to decimate is null rather than an empty mesh', () => {
  expect(buildCoarseLevel([])).toBeNull();

  /* Every vertex at one point: there is no extent to lay a grid over. */
  const point: MeshData = {
    positions: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    colors: new Float32Array(9),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
  expect(buildCoarseLevel([point])).toBeNull();
});

/**
 * The budget that made writing an outline safe to default to on.
 *
 * The grid is a fixed number of cells across whatever it is given, so its cost follows the shape
 * rather than the detail. A model simpler than the grid comes back as a hull with more triangles
 * than itself: the checked-in four-triangle bake fixture produced 9,840 of them, 308 KB of
 * outline ahead of a model measured in bytes. That inverts everything an outline is for.
 *
 * The numbers here are hand-derived from the two arrays rather than measured off a build, so this
 * pins the rule and not today's hull.
 */
test('an outline that is not much coarser than its model is not worth writing', () => {
  const fake = (triangles: number): MeshData => ({
    positions: new Float32Array(triangles * 9),
    normals: new Float32Array(triangles * 9),
    colors: new Float32Array(triangles * 9),
    emissive: new Float32Array(triangles * 3),
    indices: new Uint32Array(triangles * 3),
  });

  /* Bigger than the model: the case the fixture found, and the one this exists for. */
  expect(isOutlineWorthWriting(fake(9840), [fake(4)])).toBe(false);
  /* A saving too small to pay for a chunk, an upload and a swap. */
  expect(isOutlineWorthWriting(fake(90), [fake(100)])).toBe(false);
  /* Exactly half is the edge, and it is included rather than excluded. */
  expect(isOutlineWorthWriting(fake(50), [fake(100)])).toBe(true);
  /* What a real car looks like: 4,792 against 1.4 million. */
  expect(isOutlineWorthWriting(fake(4792), [fake(700000), fake(700000)])).toBe(true);
});
