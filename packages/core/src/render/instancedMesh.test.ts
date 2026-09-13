import { expect, test } from 'vitest';
import { InstancedMesh, createInstanceData, writeInstance } from './instancedMesh.ts';
import { recordingGl } from './rendererHarness.ts';

test('instances pack at the right stride and read back unchanged', () => {
  /*
   * Instancing itself is GPU behaviour and is judged by eye. The packing is
   * not: a stride mistake scatters everything to the wrong place while every
   * buffer still uploads cleanly, so it presents as "the grass looks wrong"
   * rather than as an error.
   */
  const data = createInstanceData(3);
  writeInstance(data, 0, 1, 2, 3, 0.5, 1.1, 0.2, 0.4, 0.6, 1, 2, 3);
  writeInstance(data, 2, 7, 8, 9, 2.0, -0.3, 0.9, 0.8, 0.7, 4, 5, 6);

  expect(Array.from(data.positions.subarray(0, 3))).toEqual([1, 2, 3]);
  expect(Array.from(data.positions.subarray(6, 9))).toEqual([7, 8, 9]);
  // Float32 rounding, so compare with tolerance rather than exactly — the
  // contract is the stride, not the last bit of the mantissa.
  const near = (actual: Float32Array, expected: number[]): void => {
    expect(actual.length).toBe(expected.length);
    expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 5));
  };
  near(data.scaleAndYaw.subarray(0, 2), [0.5, 1.1]);
  near(data.scaleAndYaw.subarray(4, 6), [2, -0.3]);
  near(data.tints.subarray(6, 9), [0.9, 0.8, 0.7]);
  near(data.windResponse.subarray(6, 9), [4, 5, 6]);

  // Instance 1 was never written and must stay zeroed, not inherit a neighbour.
  expect(Array.from(data.positions.subarray(3, 6))).toEqual([0, 0, 0]);
});

test('capacity is respected rather than silently overflowing', () => {
  // An overflow here corrupts *other* instances rather than failing, which is
  // far worse to debug than a throw at the moment of the mistake.
  const data = createInstanceData(2);
  expect(() => writeInstance(data, 2, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0)).toThrow();
  expect(() => writeInstance(data, -1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0)).toThrow();
});

/*
 * **The refusal, and why it is a throw.** Location 13 is this path's `aInstanceModel2`, so a
 * channelled mesh drawn instanced would read the absent-attribute constant and draw a perfectly
 * plausible frame: leaves that never move, a cave face at full sun, a pane at full opacity. That
 * is the silent no-op the two-backends rule forbids, and it is exactly the kind of defect that
 * survives a session because nothing looks broken.
 */
const baseMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array(9),
  emissive: new Float32Array(3),
  indices: new Uint32Array([0, 1, 2]),
};

test('refuses a mesh carrying a per-vertex channel, naming the location', () => {
  const { gl } = recordingGl();
  const channel = new Float32Array(3 * 4);
  expect(() => new InstancedMesh(gl, { ...baseMesh, channel }, 4)).toThrow(/location.*13/s);
});

test('still accepts a mesh that carries none', () => {
  const { gl } = recordingGl();
  expect(() => new InstancedMesh(gl, baseMesh, 4)).not.toThrow();
});
