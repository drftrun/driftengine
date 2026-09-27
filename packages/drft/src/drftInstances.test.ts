import { expect, test } from 'vitest';
import { buildInstances, readInstances } from './drftInstances.ts';
import { CHUNK_REQUIRED, DrftError } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/**
 * `INST`: a mesh drawn many times, placed by one matrix a copy.
 *
 * The layout is read back here by `FORMAT.md` §4 rather than only through `readInstances`, so a
 * reader and writer sharing a mistake cannot agree with each other past this test.
 */

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1];

test('A GROUP OF PLACEMENTS ROUND-TRIPS, bit for bit', () => {
  const groups = [{ mesh: 2, transforms: new Float32Array([...identity, ...moved]) }];
  const bytes = buildInstances(groups);
  const read = readInstances(bytes.buffer, bytes.byteOffset, bytes.byteLength, 3);
  expect(read).toHaveLength(1);
  expect(read[0]?.mesh).toBe(2);
  expect([...(read[0]?.transforms ?? [])]).toEqual([...identity, ...moved]);
});

test('the layout is a group count, then per group a mesh, a count and the matrices', () => {
  const bytes = buildInstances([{ mesh: 7, transforms: new Float32Array(moved) }]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(1);
  expect(view.getUint32(4, true)).toBe(7);
  expect(view.getUint32(8, true)).toBe(1);
  /* The translation column of the one matrix: floats 12, 13, 14 after a 12-byte group header. */
  expect(view.getFloat32(12 + 12 * 4, true)).toBe(3);
  expect(view.getFloat32(12 + 14 * 4, true)).toBe(5);
});

test('A GROUP NAMING A MESH THE FILE DOES NOT CARRY IS REFUSED BY NAME', () => {
  const bytes = buildInstances([{ mesh: 5, transforms: new Float32Array(identity) }]);
  expect(() => readInstances(bytes.buffer, bytes.byteOffset, bytes.byteLength, 5)).toThrow(
    DrftError,
  );
  expect(() => readInstances(bytes.buffer, bytes.byteOffset, bytes.byteLength, 5)).toThrow(
    /mesh 5/,
  );
});

test('a writer refuses placements that are not whole matrices, or a mesh instanced twice', () => {
  expect(() => buildInstances([{ mesh: 0, transforms: new Float32Array(15) }])).toThrow(/whole/);
  expect(() =>
    buildInstances([
      { mesh: 0, transforms: new Float32Array(identity) },
      { mesh: 0, transforms: new Float32Array(identity) },
    ]),
  ).toThrow(/twice/);
});

function oneTriangle(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.5),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
}

test('A FILE WITH INSTANCES CARRIES THEM AS A REQUIRED CHUNK, AHEAD OF ITS MESHES, AND READS THEM BACK', () => {
  const file = writeDrft({
    meshes: [oneTriangle(), oneTriangle()],
    instances: [{ mesh: 1, transforms: new Float32Array([...identity, ...moved]) }],
  });
  const asset = readDrft(file);
  expect(asset.instances).toHaveLength(1);
  expect(asset.instances[0]?.mesh).toBe(1);
  expect([...(asset.instances[0]?.transforms ?? [])]).toEqual([...identity, ...moved]);

  /* The table, read by FORMAT.md §4.2: FourCC, offset, byte length, then a u16 of flags at 12. */
  const view = new DataView(file);
  const count = view.getUint32(12, true);
  let instFlags = -1;
  let instAt = -1;
  let firstMesh = -1;
  for (let i = 0; i < count; i++) {
    const entry = 32 + i * 16;
    const code = String.fromCharCode(...new Uint8Array(file, entry, 4));
    if (code === 'INST') {
      instFlags = view.getUint16(entry + 12, true);
      instAt = i;
    }
    if (code === 'MESH' && firstMesh < 0) firstMesh = i;
  }
  expect(instFlags & CHUNK_REQUIRED, 'required, so an old reader refuses').toBe(CHUNK_REQUIRED);
  expect(instAt, 'ahead of the geometry it places').toBeLessThan(firstMesh);
});

test('a file with no instances reads an empty list, as every file before 1.18 does', () => {
  expect(readDrft(writeDrft({ meshes: [oneTriangle()] })).instances).toEqual([]);
});

test('a writer refuses a group placing a mesh the asset does not have', () => {
  expect(() =>
    writeDrft({
      meshes: [oneTriangle()],
      instances: [{ mesh: 3, transforms: new Float32Array(identity) }],
    }),
  ).toThrow(/mesh 3/);
});

test('THE HEADER BOUNDS COVER EVERY COPY, not the one copy the mesh holds', () => {
  /*
   * A consumer fits and culls by `HEAD`'s bounds. Computed from the written vertices alone, a file
   * of ten thousand candles reported one candle's box, and a loader fitting it scaled the whole
   * scene as if it were one candle. The copy here is moved to (3, 4, 5); the triangle spans 0..1.
   */
  const asset = readDrft(
    writeDrft({
      meshes: [oneTriangle()],
      instances: [{ mesh: 0, transforms: new Float32Array([...identity, ...moved]) }],
    }),
  );
  expect([...asset.head.bounds]).toEqual([0, 0, 0, 4, 5, 5]);
});
