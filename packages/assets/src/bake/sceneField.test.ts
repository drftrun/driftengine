import { expect, test } from 'vitest';
import { MeshBuilder } from '@driftengine/core';
import { SDFV_WHOLE_FILE } from '@driftengine/drft';
import { bakeSceneField } from './sceneField.ts';

/**
 * One field over a scene's static geometry. Three unit cubes at x = 0, 3 and 6, the last left
 * out: the field is inside the first two at their centres, outside between them, and does not see
 * the third at all. Every expectation is a distance to a cube a person can work out.
 */
function cube(x: number) {
  const builder = new MeshBuilder();
  /* Half extents: a unit cube, faces half a unit from its centre. */
  builder.addBox([x, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1], 0, 0);
  return builder.build();
}

/** The field's value at a world point, from the nearest sample. */
function at(
  entry: NonNullable<ReturnType<typeof bakeSceneField>>,
  x: number,
  y: number,
  z: number,
) {
  const [nx, ny, nz] = entry.dims;
  const b = entry.bounds;
  const step = ((b[3] as number) - (b[0] as number)) / (nx - 1);
  const ix = Math.round((x - (b[0] as number)) / step);
  const iy = Math.round((y - (b[1] as number)) / step);
  const iz = Math.round((z - (b[2] as number)) / step);
  expect(ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz).toBe(true);
  return entry.field[ix + nx * (iy + ny * iz)] as number;
}

test('A SCENE FIELD COVERS THE GEOMETRY IT WAS GIVEN AND NONE IT WAS NOT, as one field for the file', () => {
  const entry = bakeSceneField([cube(0), cube(3), cube(6)], 0.1, (index) => index !== 2);
  expect(entry).not.toBeNull();
  if (entry === null) return;
  expect(entry.mesh).toBe(SDFV_WHOLE_FILE);
  /* Inside a unit cube, half a unit from each face. */
  expect(at(entry, 0, 0, 0)).toBeLessThan(0);
  expect(at(entry, 3, 0, 0)).toBeLessThan(0);
  /*
   * Halfway between, a unit from either cube's face. Read from the nearest sample, which stands at
   * most half a voxel, 0.05, from the point asked for; the distance there differs by as much.
   */
  expect(Math.abs(at(entry, 1.5, 0, 0) - 1)).toBeLessThanOrEqual(0.05 + 1e-4);
  /* The field stops a little past the last cube it covers, which ends at 3.5; the third starts at 5.5. */
  expect(entry.bounds[3] as number).toBeLessThan(5.5);
});

test('a scene with nothing to cover has no field', () => {
  expect(bakeSceneField([cube(0)], 0.1, () => false)).toBeNull();
});
