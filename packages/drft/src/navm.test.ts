import { describe, expect, test } from 'vitest';

import { CHUNK_NAVM, DrftError, KNOWN_CHUNKS } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';
import { buildNavm, readNavm, type NavPolyMesh } from './navm.ts';

/**
 * **A file can carry a way across a scene.**
 *
 * A polygon mesh is useless without the placement it was built at, and that is the half a container
 * loses first: the numbers in it are cell indices, and a reader that gets them without the origin
 * and the cell size has a mesh in the wrong units at the wrong place — which looks like a working
 * load right up until somebody asks for a path.
 */

/**
 * Two quads sharing an edge, four cells across, standing away from the origin.
 *
 * **Away from the origin and not at unit scale on purpose.** A mesh built at the origin with
 * one-unit cells cannot tell a lost placement from a kept one, because the two units are the same
 * number there — which is exactly how the placement came to be dropped in the first place.
 */
function polyMesh(overrides: Partial<NavPolyMesh> = {}): NavPolyMesh {
  return {
    vertices: Int32Array.from([0, 0, 4, 0, 4, 4, 0, 4, 8, 0, 8, 4]),
    vertexCount: 6,
    polys: Int32Array.from([0, 1, 2, 3, 1, 4, 5, 2]),
    neighbours: Int32Array.from([-1, 1, -1, -1, -1, -1, -1, 0]),
    polyCount: 2,
    maxVertsPerPoly: 4,
    polyRegion: Int32Array.from([1, 1]),
    originX: 12.5,
    originZ: -7.25,
    cellSize: 0.3,
    ...overrides,
  };
}

describe('a NAVM chunk on its own', () => {
  test('A POLYGON MESH ROUND-TRIPS WITH ITS PLACEMENT', () => {
    const before = polyMesh();
    const bytes = buildNavm(before);
    const after = readNavm(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);

    expect(after.vertexCount).toBe(6);
    expect(after.polyCount).toBe(2);
    expect(after.maxVertsPerPoly).toBe(4);
    expect(Array.from(after.vertices)).toEqual(Array.from(before.vertices));
    expect(Array.from(after.polys)).toEqual(Array.from(before.polys));
    expect(Array.from(after.neighbours)).toEqual(Array.from(before.neighbours));
    expect(Array.from(after.polyRegion)).toEqual(Array.from(before.polyRegion));
    /* The placement, which is the half a container loses. Single precision, so 0.3 is 0.3 as f32. */
    expect(after.originX).toBeCloseTo(12.5, 6);
    expect(after.originZ).toBeCloseTo(-7.25, 6);
    expect(after.cellSize).toBeCloseTo(0.3, 6);
  });

  test('a vertex a polygon names and the mesh does not hold is refused', () => {
    /*
     * **Containment, not meaning.** Whether these polygons describe a surface anybody can walk is
     * `@driftengine/nav`'s question. Whether an index points inside the arrays is this one's, and
     * it has to be, because an index past the end is arbitrary memory on the way back out.
     */
    expect(() => buildNavm(polyMesh({ polys: Int32Array.from([0, 1, 2, 9, 1, 4, 5, 2]) }))).toThrow(
      DrftError,
    );
    expect(() =>
      buildNavm(polyMesh({ neighbours: Int32Array.from([-1, 7, -1, -1, -1, -1, -1, 0]) })),
    ).toThrow(DrftError);
  });

  test('a table whose length disagrees with the count above it is refused', () => {
    expect(() => buildNavm(polyMesh({ vertexCount: 7 }))).toThrow(DrftError);
    expect(() => buildNavm(polyMesh({ polyRegion: Int32Array.from([1]) }))).toThrow(DrftError);
  });

  test('a polygon with two slots is refused on both sides, because a polygon has three corners', () => {
    /*
     * **The tables are consistent here and the shape is still wrong**, which is the point: written
     * as `maxVertsPerPoly: 2` with its tables cut to match, nothing about the *lengths* disagrees,
     * and the refusal that is left is the one about what a polygon is.
     */
    expect(() =>
      buildNavm(
        polyMesh({
          maxVertsPerPoly: 2,
          polys: Int32Array.from([0, 1, 1, 2]),
          neighbours: Int32Array.from([-1, -1, -1, -1]),
        }),
      ),
    ).toThrow(DrftError);

    /*
     * And on the way in, where the count came off a file rather than out of a builder. **The mesh
     * here is chosen so that every other check still passes at the smaller stride** — the tables
     * are shorter, they are read at different offsets, and what they find there is still in range.
     * A corruption that trips the index check instead would have proved only that the index check
     * works.
     */
    const bytes = buildNavm({
      vertices: Int32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
      vertexCount: 4,
      polys: Int32Array.from([0, 1, 0, -1]),
      neighbours: Int32Array.from([-1, -1, -1, -1]),
      polyCount: 1,
      maxVertsPerPoly: 4,
      polyRegion: Int32Array.from([0]),
      originX: 0,
      originZ: 0,
      cellSize: 1,
    });
    new DataView(bytes.buffer as ArrayBuffer).setUint32(8, 2, true);
    expect(() => readNavm(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)).toThrow(
      DrftError,
    );
  });

  test('a stray index is refused on the way in too, not only on the way out', () => {
    /*
     * A file arrives from a network, a disk and a bake this reader did not run, so the writer
     * having checked is not the same as the bytes being right. **This is the one defect that costs
     * the consumer rather than the file**: a polygon naming a vertex that is not there walks a
     * character off the mesh.
     */
    const bytes = buildNavm(polyMesh());
    const table = new Int32Array(bytes.buffer as ArrayBuffer, 24 + 6 * 2 * 4, 8);
    table[3] = 9;
    expect(() => readNavm(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)).toThrow(
      DrftError,
    );
  });

  test('a chunk too short for the tables it declares is refused rather than read', () => {
    const bytes = buildNavm(polyMesh());
    expect(() =>
      readNavm(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength - 16),
    ).toThrow(DrftError);
  });
});

describe('a NAVM chunk in a container', () => {
  const MESH: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };

  test('it travels beside the mesh it is a way across', () => {
    const file = writeDrft({ meshes: [MESH], navigation: polyMesh() });
    const asset = readDrft(file);
    expect(asset.navigation).not.toBeNull();
    expect(asset.navigation?.polyCount).toBe(2);
    expect(asset.navigation?.cellSize).toBeCloseTo(0.3, 6);
    /* Nothing was skipped: this reader knows the chunk, so it is read rather than stepped over. */
    expect(asset.skipped.length).toBe(0);
  });

  test('a file without one says so rather than answering an empty mesh', () => {
    /*
     * **`null`, not a mesh with no polygons.** They are different facts — *nobody built one* and
     * *there is nowhere to walk* — and a consumer that cannot tell them apart cannot decide whether
     * to build one itself.
     */
    const asset = readDrft(writeDrft({ meshes: [MESH] }));
    expect(asset.navigation).toBeNull();
  });

  test('a reader that does not know it skips it, which is the whole guarantee', () => {
    const older = new Set([...KNOWN_CHUNKS].filter((code) => code !== CHUNK_NAVM));
    expect(older.has(CHUNK_NAVM)).toBe(false);
    expect(older.size).toBe(KNOWN_CHUNKS.size - 1);
  });
});
