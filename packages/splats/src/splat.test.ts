import { describe, expect, it } from 'vitest';
import { halfToFloat } from './half.ts';
import { SPLAT_WORDS } from './splatData.ts';
import { SPLAT_RECORD_BYTES, readSplat } from './splat.ts';

/** One record, built from known values rather than captured from a run. */
function record(
  over: {
    position?: [number, number, number];
    scale?: [number, number, number];
    color?: [number, number, number, number];
    /** wxyz, as the file stores it, already as bytes. */
    rotation?: [number, number, number, number];
  } = {},
): Uint8Array {
  const bytes = new Uint8Array(SPLAT_RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  const [px, py, pz] = over.position ?? [0, 0, 0];
  const [sx, sy, sz] = over.scale ?? [1, 1, 1];
  view.setFloat32(0, px, true);
  view.setFloat32(4, py, true);
  view.setFloat32(8, pz, true);
  view.setFloat32(12, sx, true);
  view.setFloat32(16, sy, true);
  view.setFloat32(20, sz, true);
  bytes.set(over.color ?? [255, 255, 255, 255], 24);
  /* 128 is zero on this encoding, so the identity quaternion is w = 255 and xyz = 128. */
  bytes.set(over.rotation ?? [255, 128, 128, 128], 28);
  return bytes;
}

function fileOf(...records: Uint8Array[]): ArrayBuffer {
  const out = new Uint8Array(records.length * SPLAT_RECORD_BYTES);
  records.forEach((r, i) => out.set(r, i * SPLAT_RECORD_BYTES));
  return out.buffer;
}

describe('readSplat', () => {
  it('reads position, scale and colour from a known record', () => {
    const data = readSplat(
      fileOf(record({ position: [1.5, -2.25, 300], color: [255, 0, 0, 128] })),
    );
    expect(data.count).toBe(1);
    expect(Array.from(data.positions)).toEqual([1.5, -2.25, 300]);
    /* Red in the lowest byte, opacity in the highest. 128/255 rounds back to 128. */
    const word = data.packed[3] ?? 0;
    expect(word & 0xff).toBe(255);
    expect((word >>> 8) & 0xff).toBe(0);
    expect((word >>> 24) & 0xff).toBe(128);
  });

  it('recovers the identity quaternion from the byte encoding', () => {
    /*
     * 255 is (255 − 128) / 128 = 0.9922 and 128 is exactly 0, so the file's identity is a hair off
     * unit length. `packSplats` normalises, so the covariance comes back as the identity for unit
     * scales — which is the property that says the reorder and the encoding are both right.
     */
    const data = readSplat(fileOf(record()));
    const at = 0 * SPLAT_WORDS;
    const pair = (word: number): number[] => [
      halfToFloat((data.packed[word] ?? 0) & 0xffff),
      halfToFloat((data.packed[word] ?? 0) >>> 16),
    ];
    expect([...pair(at + 4), ...pair(at + 5), ...pair(at + 6)]).toEqual([1, 0, 0, 1, 0, 1]);
  });

  it('reads the file as wxyz and hands on xyzw', () => {
    /*
     * A quarter turn about z is xyzw = (0, 0, sin 22.5, cos 22.5) — 0.38268 and 0.92388. Encoded:
     * z = round(0.38268 * 128 + 128) = 177, w = round(0.92388 * 128 + 128) = 246, and the file
     * puts w first. With scales (2, 1, 1) the covariance is 2.5, 1.5, 0, 2.5, 0, 1, hand-derived
     * in `splatData.test.ts`; reading the file as xyzw instead would rotate about x and give a
     * different, plausible matrix — which is why this asserts the matrix and not the quaternion.
     */
    const data = readSplat(fileOf(record({ scale: [2, 1, 1], rotation: [246, 128, 128, 177] })));
    const pair = (word: number): number[] => [
      halfToFloat((data.packed[word] ?? 0) & 0xffff),
      halfToFloat((data.packed[word] ?? 0) >>> 16),
    ];
    const [xx, xy, xz, yy, yz, zz] = [...pair(4), ...pair(5), ...pair(6)];
    /* Quantised to eight bits, so within a few thousandths rather than exact. */
    expect(xx).toBeCloseTo(2.5, 1);
    expect(xy).toBeCloseTo(1.5, 1);
    expect(yy).toBeCloseTo(2.5, 1);
    expect(zz).toBeCloseTo(1, 2);
    expect(xz).toBeCloseTo(0, 3);
    expect(yz).toBeCloseTo(0, 3);
  });

  it('encloses every splat in the bounds', () => {
    const data = readSplat(
      fileOf(record({ position: [-1, 2, 3] }), record({ position: [4, -5, 6] })),
    );
    expect(data.count).toBe(2);
    expect(Array.from(data.boundsMin)).toEqual([-1, -5, 3]);
    expect(Array.from(data.boundsMax)).toEqual([4, 2, 6]);
  });

  it('refuses a length that is not a whole number of records, stating the remainder', () => {
    /*
     * The format has no header and no magic, so this is the only structural check available: a
     * truncated file and a file of some other kind both land here, and the message says which
     * numbers led to the refusal rather than guessing which it was.
     */
    const short = new Uint8Array(SPLAT_RECORD_BYTES + 5).buffer;
    expect(() => readSplat(short)).toThrow(/leaves 5 over/);
    expect(() => readSplat(short)).toThrow(/37 bytes/);
  });

  it('reads an empty file as an empty capture rather than refusing', () => {
    /* Zero is a whole number of records. A capture of nothing is a legal, useless file. */
    const data = readSplat(new ArrayBuffer(0));
    expect(data.count).toBe(0);
    expect(Array.from(data.boundsMin)).toEqual([0, 0, 0]);
  });
});
