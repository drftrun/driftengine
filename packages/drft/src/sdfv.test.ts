import { describe, expect, test } from 'vitest';

import { CHUNK_SDFV, KNOWN_CHUNKS, fourCCName } from './drftFormat.ts';
import { readDrft } from './drftRead.ts';
import { writeDrft } from './drftWrite.ts';
import { SDFV_ENTRY_BYTES, buildSdfv, readSdfv } from './sdfv.ts';

import type { MeshData } from './meshData.ts';
import type { DrftSdfvEntry } from './sdfv.ts';

/** A field of the given shape, filled with values no round trip could produce by accident. */
function entry(mesh: number, nx: number, ny: number, nz: number): DrftSdfvEntry {
  const field = new Float32Array(nx * ny * nz);
  for (let at = 0; at < field.length; at++) field[at] = (at % 17) * 0.25 - 2;
  return {
    mesh,
    dims: [nx, ny, nz],
    bounds: new Float32Array([-1, -2, -3, 1.5, 2.5, 3.5]),
    field,
  };
}

function chunk(...entries: DrftSdfvEntry[]): Uint8Array {
  return buildSdfv({ entries });
}

describe('a field survives the container exactly', () => {
  test('every dimension, every bound and every sample comes back', () => {
    /*
     * **Exactness rather than closeness, and the distinction is the reason the chunk stores
     * `f32`.** A distance field written as bytes or halves comes back quantised, and a quantised
     * distance is not a safe step: a march that trusts a value rounded up walks through the
     * surface it was supposed to stop at. The round trip is therefore byte-for-byte or it is a
     * different field.
     */
    const first = entry(0, 5, 4, 3);
    const second = entry(7, 2, 9, 2);
    const bytes = chunk(first, second);
    const read = readSdfv(bytes.buffer as ArrayBuffer, 0, bytes.byteLength);

    expect(read.entries).toHaveLength(2);
    for (const [at, source] of [first, second].entries()) {
      const back = read.entries[at] as DrftSdfvEntry;
      expect(back.mesh).toBe(source.mesh);
      expect(Array.from(back.dims)).toEqual(Array.from(source.dims));
      expect(Array.from(back.bounds)).toEqual(Array.from(source.bounds));
      expect(
        new Uint8Array(back.field.buffer, back.field.byteOffset, back.field.byteLength),
      ).toEqual(
        new Uint8Array(source.field.buffer, source.field.byteOffset, source.field.byteLength),
      );
    }
  });

  test('a chunk carrying no field at all is a chunk carrying no field at all', () => {
    const bytes = chunk();
    expect(readSdfv(bytes.buffer as ArrayBuffer, 0, bytes.byteLength).entries).toEqual([]);
  });
});

describe('a chunk that was not written by this writer', () => {
  /*
   * **`buildSdfv` refuses everything below on the way out**, so no chunk this writer produces can
   * reach the reader's own checks — and a guard only a corrupt file can reach is a guard only a
   * corrupt file can test. A third-party writer implements against the documented layout, so
   * these walk it the same way. `dtex.test.ts` makes the same argument at the same length.
   */
  test('A TRUNCATED CHUNK IS REFUSED RATHER THAN READ SHORT', () => {
    const bytes = chunk(entry(0, 4, 4, 4));
    /* One float short of what the entry table says it carries. */
    expect(() => readSdfv(bytes.buffer as ArrayBuffer, 0, bytes.byteLength - 4)).toThrow(/SDFV/);
    /* And short of the entry table itself, which is the earlier of the two failures. */
    expect(() => readSdfv(bytes.buffer as ArrayBuffer, 0, 8)).toThrow(/SDFV/);
    /* And short of the count. */
    expect(() => readSdfv(bytes.buffer as ArrayBuffer, 0, 2)).toThrow(/SDFV/);
  });

  test('DIMENSIONS THAT DO NOT MATCH THE SAMPLES CARRIED ARE REFUSED', () => {
    /*
     * The one corruption that reads as a working file. A field declared 4x4x4 and carrying 5x4x4
     * samples is a legal-looking chunk whose reader hands back a `Float32Array` of the wrong
     * length, or — worse, and this is the failure being closed — one of the right length whose
     * every sample belongs to a different place in space. Light comes out of solid walls and
     * nothing in the container says why.
     */
    const bytes = chunk(entry(0, 4, 4, 4));
    const view = new DataView(bytes.buffer as ArrayBuffer);
    view.setUint32(8, 5, true);
    expect(() => readSdfv(bytes.buffer as ArrayBuffer, 0, bytes.byteLength)).toThrow(/SDFV/);
  });

  test('a dimension of zero is refused, because a field with no samples has no surface', () => {
    const bytes = chunk(entry(0, 4, 4, 4));
    const view = new DataView(bytes.buffer as ArrayBuffer);
    view.setUint32(12, 0, true);
    expect(() => readSdfv(bytes.buffer as ArrayBuffer, 0, bytes.byteLength)).toThrow(/SDFV/);
  });

  test('A FIELD DECLARING MORE SAMPLES THAN THE CAP IS NAMED, not merely found too big', () => {
    /*
     * **The containment check below would refuse this too, and the message is the point.** A
     * 1000-cubed field in a 36-byte chunk fails containment with "the chunk has 12 bytes left",
     * which reads as a truncated file; it fails the cap with the number it asked for and the
     * number that is allowed, which reads as the corrupt header it is. The cap is checked first
     * for that reason and for no other — `SDFV_MAX_SAMPLES` says what it costs.
     */
    const bytes = chunk(entry(0, 2, 2, 2));
    const view = new DataView(bytes.buffer as ArrayBuffer);
    for (const at of [8, 12, 16]) view.setUint32(at, 1000, true);
    expect(() => readSdfv(bytes.buffer as ArrayBuffer, 0, bytes.byteLength)).toThrow(
      /1000000000 samples and the cap is 134217728/,
    );
  });

  test('a count larger than the chunk could hold is refused before it is trusted', () => {
    /*
     * The count is the first thing read and the one every later bound derives from, so a corrupt
     * one is what turns a short read into a hundred-megabyte allocation.
     */
    const bytes = chunk(entry(0, 3, 3, 3));
    const view = new DataView(bytes.buffer as ArrayBuffer);
    view.setUint32(0, 0xffffff, true);
    expect(() => readSdfv(bytes.buffer as ArrayBuffer, 0, bytes.byteLength)).toThrow(/SDFV/);
  });
});

describe('what the writer will not write', () => {
  test('a field whose length is not the product of its dimensions', () => {
    const bad = { ...entry(0, 4, 4, 4), field: new Float32Array(63) };
    expect(() => chunk(bad)).toThrow(/64/);
  });

  test('a dimension below one', () => {
    expect(() => chunk({ ...entry(0, 4, 4, 4), dims: [4, 0, 4] })).toThrow(/dimension/i);
  });

  test('bounds that are not six numbers', () => {
    expect(() => chunk({ ...entry(0, 4, 4, 4), bounds: new Float32Array(4) })).toThrow(/bounds/i);
  });
});

describe('the chunk has a route into a file and back out of it', () => {
  /*
   * **A chunk nothing writes is a chunk-shaped module, and this repository has the scar.**
   * `bake/cluster.ts` and `bake/clusterLod.ts` were tested, sized and licensed and had no export
   * out of their package for as long as they existed; the first scene that wanted them found out
   * by failing a boundary test. So the wiring is asserted rather than assumed: a whole file, out
   * through `writeDrft` and back through `readDrft`.
   */
  test('a whole file carries fields through the writer and the reader', () => {
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      colors: new Float32Array(9),
      emissive: new Float32Array(3),
      indices: new Uint32Array([0, 1, 2]),
    };
    const source = entry(0, 3, 4, 5);
    const asset = readDrft(writeDrft({ meshes: [mesh, mesh], fields: [source] }));

    expect(asset.versionMinor).toBeGreaterThanOrEqual(13);
    expect(asset.fields).toHaveLength(1);
    const back = asset.fields[0] as DrftSdfvEntry;
    expect(back.mesh).toBe(0);
    expect(Array.from(back.dims)).toEqual([3, 4, 5]);
    expect(Array.from(back.field)).toEqual(Array.from(source.field));
  });

  test('a file that carries no field says so with an empty list rather than an empty chunk', () => {
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      colors: new Float32Array(9),
      emissive: new Float32Array(3),
      indices: new Uint32Array([0, 1, 2]),
    };
    expect(readDrft(writeDrft({ meshes: [mesh] })).fields).toEqual([]);
  });
});

describe('the freeze holds because the chunk is additive', () => {
  test('this reader knows the code', () => {
    expect(KNOWN_CHUNKS.has(CHUNK_SDFV)).toBe(true);
    expect(fourCCName(CHUNK_SDFV)).toBe('SDFV');
  });

  test('a reader that does not know it skips it, which is the whole guarantee', () => {
    /*
     * **Rule 2 of `FORMAT.md` §4.4, asserted rather than trusted.** An older reader's known set is
     * this one without `SDFV`; an optional chunk it does not recognise is skipped by its length,
     * and what it loses is indirect light it had no way to trace anyway.
     */
    const older = new Set([...KNOWN_CHUNKS].filter((code) => code !== CHUNK_SDFV));
    expect(older.has(CHUNK_SDFV)).toBe(false);
    expect(older.size).toBe(KNOWN_CHUNKS.size - 1);
  });

  test('the entry table is a fixed stride, so a reader can walk it without parsing a field', () => {
    /* 4 for the ordinal, 12 for the dimensions, 24 for the bounds. A field is elsewhere. */
    expect(SDFV_ENTRY_BYTES).toBe(40);
    const bytes = chunk(entry(0, 2, 2, 2), entry(1, 3, 3, 3));
    expect(bytes.byteLength).toBe(4 + 2 * SDFV_ENTRY_BYTES + (8 + 27) * 4);
  });
});
