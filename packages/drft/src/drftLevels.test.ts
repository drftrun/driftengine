import { expect, test } from 'vitest';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/**
 * `LODF`: discrete levels of detail, each a complete nested file.
 *
 * **The second test is the one the chunk is designed around.** Anything can carry extra bytes; the
 * question §4.4 rule 2 asks is what a reader that has never heard of this chunk sees, and the
 * answer has to be the full-detail model rather than several models drawn on top of each other.
 */

function triangle(scale: number): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, scale, 0, 0, 0, scale, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(1),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
}

/** `writeDrft` yields an `ArrayBuffer`; a level read back out is a `Uint8Array` view. */
function reread(bytes: ArrayBuffer | Uint8Array): ReturnType<typeof readDrft> {
  if (bytes instanceof ArrayBuffer) return readDrft(bytes);
  return readDrft(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

/** A nested level is written first and embedded as bytes. */
function level(scale: number): Uint8Array {
  return new Uint8Array(writeDrft({ meshes: [triangle(scale)] }));
}

test('carries a discrete level as a whole nested file, finest first', () => {
  const asset = reread(writeDrft({ meshes: [triangle(4)], levels: [level(1), level(2)] }));

  expect(asset.levels).toHaveLength(2);
  /* Handed over unparsed, so a consumer pays only for the level it picks. */
  expect(reread(asset.levels[0] as Uint8Array).meshes[0]!.positions[3]).toBe(1);
  expect(reread(asset.levels[1] as Uint8Array).meshes[0]!.positions[3]).toBe(2);
});

test('a reader that skips LODF still sees the full-detail model, and only it', () => {
  const withLevels = reread(writeDrft({ meshes: [triangle(4)], levels: [level(9)] }));
  const without = reread(writeDrft({ meshes: [triangle(4)] }));

  /* One mesh, not two: a nested level's geometry is inside a chunk, never beside the model's. */
  expect(withLevels.meshes).toHaveLength(1);
  expect([...withLevels.meshes[0]!.positions]).toEqual([...without.meshes[0]!.positions]);
});

test('a level carries its own materials and hierarchy, which is why it is not LODM', () => {
  const rigged = new Uint8Array(
    writeDrft({
      meshes: [triangle(1)],
      nodes: [
        {
          parent: -1,
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          mesh: 0,
          name: 'WHEEL_LF',
        },
      ],
    }),
  );
  const asset = reread(writeDrft({ meshes: [triangle(4)], levels: [rigged] }));
  expect(reread(asset.levels[0] as Uint8Array).nodes?.[0]?.name).toBe('WHEEL_LF');
});

test('a file with no levels reports none, and writes the bytes it always did', () => {
  const plain = writeDrft({ meshes: [triangle(4)] });
  const empty = writeDrft({ meshes: [triangle(4)], levels: [] });
  expect(reread(plain).levels).toEqual([]);
  expect([...new Uint8Array(empty)]).toEqual([...new Uint8Array(plain)]);
});
