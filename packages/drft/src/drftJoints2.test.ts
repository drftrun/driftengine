import { expect, it } from 'vitest';

import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/*
 * One triangle skinned by eight joints: the first vertex is moved half by joint 0 and half by
 * joint 6, which only the second set can name. Joints are exact and weights are values, so a
 * quantised bake keeps the one exactly and the other to a sixteen-bit step.
 */
const MESH: MeshData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array(9).fill(1),
  emissive: new Float32Array(3),
  joints: new Float32Array([0, 1, 2, 3, 0, 0, 0, 0, 1, 0, 0, 0]),
  weights: new Float32Array([0.5, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  joints2: new Float32Array([6, 4, 5, 7, 0, 0, 0, 0, 0, 0, 0, 0]),
  weights2: new Float32Array([0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

it('A MESH’S SECOND FOUR INFLUENCES SURVIVE A BAKE, PLAIN AND QUANTISED', () => {
  const plain = readDrft(writeDrft({ meshes: [MESH] })).meshes[0];
  expect(Array.from(plain?.joints2 ?? [])).toEqual(Array.from(MESH.joints2 ?? []));
  expect(Array.from(plain?.weights2 ?? [])).toEqual(Array.from(MESH.weights2 ?? []));
  expect(Array.from(plain?.joints ?? []), 'and the first four where they were').toEqual(
    Array.from(MESH.joints ?? []),
  );
  const quantised = readDrft(writeDrft({ meshes: [MESH], quantise: true })).meshes[0];
  expect(Array.from(quantised?.joints2 ?? []), 'a joint index is exact').toEqual(
    Array.from(MESH.joints2 ?? []),
  );
  const back = Array.from(quantised?.weights2 ?? []);
  expect(back).toHaveLength(12);
  back.forEach((v, i) => expect(v).toBeCloseTo(MESH.weights2?.[i] as number, 3));
});

it('refuses a second set without the first, or joints without their weights', () => {
  const { joints: _joints, weights: _weights, ...noFirst } = MESH;
  expect(() => writeDrft({ meshes: [noFirst] })).toThrow(/second/i);
  const { weights2: _w2, ...halfSecond } = MESH;
  expect(() => writeDrft({ meshes: [halfSecond] })).toThrow(/weights2|joints2/);
});

/*
 * **An older reader refuses such a mesh rather than misreading it.** Indices follow the last
 * attribute array, so a reader that has never heard of the second set reads its floats where it
 * expects indices; the index scan then finds indices far past the vertex count and refuses the
 * mesh by name. Simulated here by clearing the two bits in the written header, which is exactly
 * what a 1.23 reader would see of them: nothing.
 */
it('AN OLDER READER REFUSES A MESH WITH EIGHT INFLUENCES LOUDLY, AND DOES NOT DRAW GARBAGE', () => {
  const bytes = writeDrft({ meshes: [MESH] });
  const view = new DataView(bytes);
  const file = readDrft(bytes);
  expect(file.meshes).toHaveLength(1);
  /* The MESH chunk's attribute word, found by scanning for the written bit pattern. */
  let patched = 0;
  for (let at = 0; at + 12 <= bytes.byteLength; at += 4) {
    const vertices = view.getUint32(at, true);
    const indices = view.getUint32(at + 4, true);
    const attributes = view.getUint32(at + 8, true);
    if (vertices === 3 && indices === 3 && (attributes & (1 << 11)) !== 0) {
      view.setUint32(at + 8, attributes & ~((1 << 11) | (1 << 12)), true);
      patched += 1;
    }
  }
  expect(patched, 'the attribute word was found').toBe(1);
  expect(() => readDrft(bytes)).toThrow();
});
