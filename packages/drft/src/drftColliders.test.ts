import { describe, expect, it } from 'vitest';
import {
  MAX_COLLIDER_HULLS,
  MAX_COLLIDER_POINTS,
  buildColliders,
  readColliders,
} from './drftColliders.ts';
import { DRFT_VERSION_MINOR, DrftError } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import type { MeshData } from './meshData.ts';

/** The smallest asset the writer accepts: one triangle. */
function oneTriangle(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.5),
    emissive: new Float32Array(3),
    indices: new Uint32Array([0, 1, 2]),
  };
}

/** A box's eight corners, xyz-packed, offset along x. */
function boxPoints(offset: number): Float32Array {
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    points.push(offset + (i & 1 ? 1 : -1), i & 2 ? 1 : -1, i & 4 ? 1 : -1);
  }
  return new Float32Array(points);
}

/** A chunk's own bytes, read back without going through a whole file. */
function roundTripPayload(hulls: readonly Float32Array[]): readonly Float32Array[] {
  const bytes = buildColliders(hulls);
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return readColliders(buffer, 0, bytes.length);
}

describe('COLL', () => {
  it('carries hulls of different sizes back unchanged', () => {
    const hulls = [boxPoints(0), boxPoints(4), new Float32Array([0, 0, 0, 1, 1, 1, 2, 0, 1])];
    const back = roundTripPayload(hulls);
    expect(back).toHaveLength(3);
    for (let i = 0; i < hulls.length; i++) {
      expect(Array.from(back[i] as Float32Array)).toEqual(Array.from(hulls[i] as Float32Array));
    }
  });

  it('refuses a payload it cannot mean', () => {
    expect(() => buildColliders([new Float32Array([0, 0])])).toThrow(DrftError);
    expect(() => buildColliders([new Float32Array()])).toThrow(/no points/);
    expect(() => buildColliders([new Float32Array((MAX_COLLIDER_POINTS + 1) * 3)])).toThrow(/cap/);
    expect(() =>
      buildColliders(Array.from({ length: MAX_COLLIDER_HULLS + 1 }, () => boxPoints(0))),
    ).toThrow(/exceeds/);
  });

  it('checks the table before it hands out a single point', () => {
    /*
     * **A start table that runs backwards would otherwise produce a hull of arbitrary geometry**
     * rather than an error — a `subarray` of a length nobody wrote. Every one of these is a byte
     * flipped in a file that is otherwise well formed.
     */
    const bytes = buildColliders([boxPoints(0), boxPoints(4), boxPoints(8)]);
    const broken = (at: number, value: number): ArrayBuffer => {
      const buffer = new ArrayBuffer(bytes.length);
      new Uint8Array(buffer).set(bytes);
      new DataView(buffer).setUint32(at, value, true);
      return buffer;
    };
    /* The first start is not zero. */
    expect(() => readColliders(broken(8, 1), 0, bytes.length)).toThrow(/first hull at zero/);
    /* A start that runs behind the one before it. Table entries sit at 8, 12, 16, 20. */
    expect(() => readColliders(broken(16, 4), 0, bytes.length)).toThrow(/runs backwards/);
    /* The closing entry disagrees with the declared total. */
    expect(() => readColliders(broken(20, 15), 0, bytes.length)).toThrow(/did not declare/);
    /* A count that runs past the chunk. */
    expect(() => readColliders(broken(4, 1_000_000), 0, bytes.length)).toThrow(/runs past/);
    /* More hulls than the cap. */
    expect(() => readColliders(broken(0, 999), 0, bytes.length)).toThrow(/over the/);
    expect(() => readColliders(new ArrayBuffer(4), 0, 4)).toThrow(/too short/);
  });

  it('survives a whole file, and the file says which version wrote it', () => {
    const hulls = [boxPoints(0), boxPoints(3)];
    const file = writeDrft({ meshes: [oneTriangle()], colliders: hulls });
    const asset = readDrft(file);
    expect(asset.versionMinor).toBe(DRFT_VERSION_MINOR);
    expect(asset.colliders).toHaveLength(2);
    expect(Array.from(asset.colliders[0] as Float32Array)).toEqual(
      Array.from(hulls[0] as Float32Array),
    );
    expect(Array.from(asset.colliders[1] as Float32Array)).toEqual(
      Array.from(hulls[1] as Float32Array),
    );
  });

  it('is absent from a file that carries none, rather than empty-but-present', () => {
    /*
     * An empty chunk would cost sixteen bytes of table to say nothing, and rule 2 of §4.4 already
     * covers a chunk's absence. `SUBS` makes the same choice for the same reason.
     */
    const asset = readDrft(writeDrft({ meshes: [oneTriangle()] }));
    expect(asset.colliders).toEqual([]);
    expect(asset.skipped).toEqual([]);
  });

  it('changes nothing for a reader that does not know the chunk', () => {
    /*
     * **The additive claim, asserted rather than assumed.** A 1.12 file carrying `COLL` must read
     * identically to the same asset without it for every consumer written before the chunk existed
     * — which is what rule 2 of docs/FORMAT.md §4.4 promises. Nothing here reads `COLL`; the two
     * assets must agree in every other field.
     */
    const mesh = oneTriangle();
    const withHulls = readDrft(writeDrft({ meshes: [mesh], colliders: [boxPoints(0)] }));
    const without = readDrft(writeDrft({ meshes: [mesh] }));

    expect(withHulls.meshes).toHaveLength(without.meshes.length);
    expect(Array.from(withHulls.meshes[0]?.positions ?? [])).toEqual(
      Array.from(without.meshes[0]?.positions ?? []),
    );
    expect(withHulls.head.bounds).toEqual(without.head.bounds);
    expect(withHulls.nodes).toEqual(without.nodes);
    expect(withHulls.materials).toEqual(without.materials);
    expect(withHulls.substances).toEqual(without.substances);
    expect(withHulls.versionMajor).toBe(without.versionMajor);
  });
});
