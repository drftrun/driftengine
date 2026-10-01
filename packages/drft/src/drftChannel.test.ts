import { expect, it } from 'vitest';

import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/* A triangle whose vertices sway 0, 0.5 and 1, lit by the sky 1, 0.25, 1, all opaque. */
const MESH: MeshData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  colors: new Float32Array(9).fill(1),
  emissive: new Float32Array(3),
  channel: new Float32Array([0, 1, 1, 0, 0.5, 0.25, 1, 0, 1, 1, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

it('A MESH’S CHANNEL — SWAY, SKY AND OPACITY — SURVIVES A BAKE, PLAIN AND QUANTISED', () => {
  const plain = readDrft(writeDrft({ meshes: [MESH] })).meshes[0];
  expect(Array.from(plain?.channel ?? [])).toEqual(Array.from(MESH.channel ?? []));
  const quantised = readDrft(writeDrft({ meshes: [MESH], quantise: true })).meshes[0];
  /* 16 bits over each lane's range: well inside a thousandth. */
  const back = Array.from(quantised?.channel ?? []);
  expect(back).toHaveLength(12);
  back.forEach((v, i) => expect(v).toBeCloseTo(MESH.channel?.[i] as number, 3));
});
