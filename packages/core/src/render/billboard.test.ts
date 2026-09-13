import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';
import { billboardMatrixY } from './billboard.ts';

test('a standing billboard turns to the camera but never tips over', () => {
  /*
   * The whole reason cylindrical and spherical are separate functions. A figure standing
   * on the ground stays upright whatever direction it is turned to face — deriving the
   * orientation from the full 3D direction to the eye is what makes one lean back as the
   * camera climbs, and it reads as the model falling over rather than as it facing you.
   *
   * Checked around the compass rather than at one bearing, because a Y column that
   * happens to be world up at zero yaw proves nothing about the general case.
   */
  const model = mat4.create();
  for (const [cameraX, cameraZ] of [
    [0, 10],
    [10, 0],
    [0, -10],
    [-10, 0],
    [7, 7],
  ]) {
    billboardMatrixY(model, 0, 0, 0, cameraX, cameraZ);
    expect([model[4], model[5], model[6]], `up column at ${cameraX},${cameraZ}`).toEqual([0, 1, 0]);
  }
});

test('a standing billboard faces the camera it was given', () => {
  // Camera on +X, so the quad's +Z (its facing) must point along +X to meet it.
  const model = mat4.create();
  billboardMatrixY(model, 0, 0, 0, 10, 0);
  expect(model[8]).toBeCloseTo(1, 6);
  expect(model[10]).toBeCloseTo(0, 6);
});

test('scale reaches the axes it is meant to and leaves the position alone', () => {
  const model = mat4.create();
  billboardMatrixY(model, 3, 4, 5, 3, 15, 2, 7);
  // Camera straight ahead on +Z: facing is identity, so X scale lands unrotated.
  expect(model[0]).toBeCloseTo(2, 6);
  expect(model[5]).toBeCloseTo(7, 6);
  expect([model[12], model[13], model[14]]).toEqual([3, 4, 5]);
});
