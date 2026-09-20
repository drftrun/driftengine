import { expect, test } from 'vitest';
import { DrftError } from './drftFormat.ts';
import { buildMeshlets, readMeshlets } from './drftMeshlets.ts';
import type { MeshletLevel } from './drftMeshlets.ts';

function level(): MeshletLevel {
  return {
    triangleOffsets: Uint32Array.from([0, 2]),
    triangleCounts: Uint32Array.from([2, 1]),
    boundsCentre: Float32Array.from([0, 0, 0, 1, 1, 1]),
    boundsRadius: Float32Array.from([1.5, 2.5]),
    coneAxis: Float32Array.from([0, 1, 0, 1, 0, 0]),
    coneCutoff: Float32Array.from([0.9, 0.8]),
    ownError: Float32Array.from([0, 0]),
    parentError: Float32Array.from([0.25, Infinity]),
    indices: Uint32Array.from([0, 1, 2, 2, 3, 0, 1, 2, 3]),
    count: 2,
  };
}

/** A chunk's own bytes, read back without going through a whole file. */
function payload(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function roundTrip(l: MeshletLevel): MeshletLevel {
  const bytes = buildMeshlets(l);
  return readMeshlets(payload(bytes), 0, bytes.length);
}

test('a level round-trips exactly', () => {
  const source = level();
  const back = roundTrip(source);
  expect(back.count).toBe(2);
  expect(Array.from(back.triangleOffsets)).toEqual([0, 2]);
  expect(Array.from(back.triangleCounts)).toEqual([2, 1]);
  expect(Array.from(back.indices)).toEqual(Array.from(source.indices));
  expect(Array.from(back.boundsRadius)).toEqual([1.5, 2.5]);
  expect(Array.from(back.coneCutoff)).toEqual([0.9, 0.8].map((v) => Math.fround(v)));
});

test('an infinite parent error survives, which is how the coarsest level says it has no parent', () => {
  expect(roundTrip(level()).parentError[1]).toBe(Infinity);
});

test('a truncated chunk is refused rather than read as a shorter one', () => {
  const bytes = buildMeshlets(level());
  expect(() => readMeshlets(payload(bytes), 0, 12)).toThrow(DrftError);
});

test('a chunk too short even for its counts is refused', () => {
  expect(() => readMeshlets(new ArrayBuffer(4), 0, 4)).toThrow(/too short/);
});

test('a cluster running past the triangles it was given is refused at write', () => {
  const bad = level();
  bad.triangleCounts = Uint32Array.from([2, 99]);
  expect(() => buildMeshlets(bad)).toThrow(/runs past/);
});

test('indices that are not whole triangles are refused', () => {
  const bad = level();
  bad.indices = Uint32Array.from([0, 1]);
  expect(() => buildMeshlets(bad)).toThrow(/whole triangles/);
});

test('a cluster running past the chunk is refused at read', () => {
  const buffer = payload(buildMeshlets(level()));
  /* Corrupt the second cluster's triangle count in place. */
  new DataView(buffer).setUint32(8 + 2 * 4 + 4, 999, true);
  expect(() => readMeshlets(buffer, 0, buffer.byteLength)).toThrow(/runs past/);
});

test('the payload is four-byte aligned, so every view is a subarray rather than a copy', () => {
  expect(buildMeshlets(level()).byteLength % 4).toBe(0);
});

test('an empty level is legal and round-trips to nothing', () => {
  const empty: MeshletLevel = {
    triangleOffsets: new Uint32Array(0),
    triangleCounts: new Uint32Array(0),
    boundsCentre: new Float32Array(0),
    boundsRadius: new Float32Array(0),
    coneAxis: new Float32Array(0),
    coneCutoff: new Float32Array(0),
    ownError: new Float32Array(0),
    parentError: new Float32Array(0),
    indices: new Uint32Array(0),
    count: 0,
  };
  expect(roundTrip(empty).count).toBe(0);
});
