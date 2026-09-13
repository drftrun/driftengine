import { describe, expect, it } from 'vitest';
import { SPLAT_WORDS, packSplats } from './splatData.ts';
import { SplatCapture, splatsFromRecords } from './splatCapture.ts';
import { SPLAT_STRIDE, splatRowSource, splatRowWords } from './splatLayout.ts';

/** A capture of `count` splats, spread along x, each a different size. */
function packed(count: number): ReturnType<typeof packSplats> {
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  const opacities = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    positions[index * 3] = index;
    positions[index * 3 + 1] = index * 2;
    positions[index * 3 + 2] = index * 3;
    const size = 0.25 * (index + 1);
    scales[index * 3] = size;
    scales[index * 3 + 1] = size * 0.5;
    scales[index * 3 + 2] = size * 0.25;
    rotations[index * 4 + 3] = 1;
    colors[index * 3] = 1;
    opacities[index] = 1;
  }
  return packSplats({ count, positions, scales, rotations, colors, opacities });
}

describe('SplatCapture', () => {
  it('has nothing ready before a block lands', () => {
    const capture = new SplatCapture({
      total: 8,
      boundsMin: [0, 0, 0],
      boundsMax: [1, 1, 1],
    });

    expect(capture.ready).toBe(0);
    expect(capture.data.count, 'sized for the whole capture from the first moment').toBe(8);
  });

  it('rebuilds positions and extents from the records alone', () => {
    /*
     * **The records are the only thing the container carries**, so everything the CPU needs after
     * a load has to come back out of them: positions from the first three words reinterpreted,
     * and the extent from the eighth. A block that arrived with either derived wrongly draws in
     * the right place and sorts or budgets in the wrong one, which is invisible until a camera
     * moves.
     */
    const source = packed(4);
    const capture = new SplatCapture({
      total: 4,
      boundsMin: source.boundsMin,
      boundsMax: source.boundsMax,
    });

    capture.append(source.packed, 4);

    expect(capture.ready).toBe(4);
    expect(Array.from(capture.data.positions)).toEqual(Array.from(source.positions));
    expect(Array.from(capture.data.extents)).toEqual(Array.from(source.extents));
    expect(Array.from(capture.data.packed)).toEqual(Array.from(source.packed));
  });

  it('appends blocks end to end and says which range moved', () => {
    const source = packed(6);
    const capture = new SplatCapture({
      total: 6,
      boundsMin: source.boundsMin,
      boundsMax: source.boundsMax,
    });

    const first = capture.append(source.packed.subarray(0, 2 * SPLAT_WORDS), 2);
    expect(first).toEqual({ from: 0, count: 2 });
    expect(capture.ready).toBe(2);

    const second = capture.append(source.packed.subarray(2 * SPLAT_WORDS), 4);
    expect(second, 'so a caller uploads only what arrived').toEqual({ from: 2, count: 4 });
    expect(capture.ready).toBe(6);
    expect(Array.from(capture.data.positions)).toEqual(Array.from(source.positions));
  });

  it('refuses a block that would run past the capture it was told to expect', () => {
    /*
     * Loudly, and at the load rather than in the frame: a block written past the end would either
     * throw from a typed array or silently truncate depending on how it was copied, and both
     * produce a capture that is wrong in a way no picture explains.
     */
    const source = packed(4);
    const capture = new SplatCapture({ total: 3, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] });

    expect(() => capture.append(source.packed, 4)).toThrow(/3 splats/);
  });

  it('refuses a block whose records do not cover the splats it claims', () => {
    const capture = new SplatCapture({ total: 4, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1] });
    expect(() => capture.append(new Uint32Array(4), 4)).toThrow(/32 entries/);
  });

  it('carries the bounds and the coefficient count it was given', () => {
    const capture = new SplatCapture({
      total: 2,
      boundsMin: [-1, -2, -3],
      boundsMax: [4, 5, 6],
      sphericalHarmonics: 45,
    });

    expect(Array.from(capture.data.boundsMin)).toEqual([-1, -2, -3]);
    expect(Array.from(capture.data.boundsMax)).toEqual([4, 5, 6]);
    expect(capture.data.sphericalHarmonics).toBe(45);
  });
});

describe('splatsFromRecords', () => {
  it('turns a whole-file read back into exactly what was packed', () => {
    const source = packed(5);
    const rebuilt = splatsFromRecords({
      count: 5,
      records: source.packed,
      boundsMin: source.boundsMin,
      boundsMax: source.boundsMax,
      sphericalHarmonics: 0,
    });

    expect(rebuilt.count).toBe(5);
    expect(Array.from(rebuilt.positions)).toEqual(Array.from(source.positions));
    expect(Array.from(rebuilt.extents)).toEqual(Array.from(source.extents));
    expect(Array.from(rebuilt.packed)).toEqual(Array.from(source.packed));
  });
});

describe('splatRowSource', () => {
  it('covers the whole rectangle even when the capture ends mid-row', () => {
    /*
     * **The bug this exists because of.** A texture upload takes a rectangle, so a source shorter
     * than `rows * splatRowWords(w)` is not a short row — it is a validation failure on WebGPU and
     * a *silently skipped upload* on WebGL2, which leaves the last row holding whatever it held
     * and draws the capture with up to a thousand splats missing. It shipped on one backend and
     * not the other, and was found as 59,585 pixels between them on a streaming load.
     */
    const rows = 2;
    /* A capture ending a hundred splats into its second row. */
    const packed = new Uint32Array(SPLAT_STRIDE * SPLAT_WORDS + 100 * SPLAT_WORDS).fill(7);

    const source = splatRowSource(packed, 0, rows);

    expect(source.length, 'the full rectangle').toBe(rows * splatRowWords(8));
    expect(source[0]).toBe(7);
    expect(source[source.length - 1], 'and the tail is padding rather than absent').toBe(0);
  });

  it('is a view, not a copy, when the rows are whole', () => {
    const packed = new Uint32Array(SPLAT_STRIDE * 2 * SPLAT_WORDS);
    const source = splatRowSource(packed, 0, 2);
    expect(source.buffer, 'no copy on the common path').toBe(packed.buffer);
  });
});
