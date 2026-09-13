/** A capture that fills up as its blocks arrive, sized once from the count the first one names. */

import { SPLAT_WORDS, SPLAT_WORDS_SH1 } from './splatData.ts';
import type { SplatData } from './splatData.ts';

export interface SplatCaptureOptions {
  /** Splats in the whole capture. Every array is allocated for this and never grows. */
  readonly total: number;
  /** The whole capture's extent, which a `.drft` block carries in its own header. */
  readonly boundsMin: ArrayLike<number>;
  readonly boundsMax: ArrayLike<number>;
  /** Coefficients the source carried, of which the shader reads the first band. Recorded. */
  readonly sphericalHarmonics?: number;
  /**
   * Words in one record, from the block's own header.
   *
   * **Taken from the file rather than assumed**, which is what `FORMAT.md` §4.7 designed the field
   * for: a capture with degree-1 view-dependent colour writes twelve where one without writes
   * eight, and a streaming reader that hard-coded the width would read the second block's records
   * at the wrong offset and draw a cloud of noise. Defaults to `SPLAT_WORDS` so a caller with no
   * container behind it is unaffected.
   */
  readonly wordsPerSplat?: number;
}

/** Where a block landed, so a caller uploads what arrived rather than the whole texture. */
export interface SplatAppend {
  readonly from: number;
  readonly count: number;
}

/**
 * A capture assembled from blocks, one `.drft` chunk at a time.
 *
 * **Allocated once at the final count and filled progressively**, which is what makes a streaming
 * load cost nothing extra: the GPU textures are sized for the whole capture at registration, each
 * block is a sub-upload into storage that already exists, and the drawn count rises. Growing an
 * array as blocks land would mean reallocating and re-uploading a capture's worth of texels
 * several times during a load, which is more work than the load itself.
 *
 * **Every block is a sparse version of the whole capture**, because the container writes them
 * that way — see `coarseFirstOrder`. So a prefix of the arrived splats is a recognisable place at
 * lower density rather than one finished corner, and the load opens on something worth looking
 * at. That property lives in the writer; what lives here is that nothing is re-ordered or
 * re-allocated on the way in.
 *
 * The unarrived tail is zeroed, which puts it at the origin with no size. Nothing draws it: the
 * caller sorts and draws `ready` splats and the sorter is told the same number.
 */
export class SplatCapture {
  readonly data: SplatData;
  private arrived = 0;
  private readonly words: number;

  constructor(options: SplatCaptureOptions) {
    const total = Math.max(0, options.total);
    this.words = options.wordsPerSplat ?? SPLAT_WORDS;
    this.data = {
      count: total,
      positions: new Float32Array(total * 3),
      packed: new Uint32Array(total * this.words),
      wordsPerSplat: this.words,
      shDegree: this.words >= SPLAT_WORDS_SH1 ? 1 : 0,
      extents: new Float32Array(total),
      boundsMin: new Float32Array([
        options.boundsMin[0] ?? 0,
        options.boundsMin[1] ?? 0,
        options.boundsMin[2] ?? 0,
      ]),
      boundsMax: new Float32Array([
        options.boundsMax[0] ?? 0,
        options.boundsMax[1] ?? 0,
        options.boundsMax[2] ?? 0,
      ]),
      sphericalHarmonics: options.sphericalHarmonics ?? 0,
    };
  }

  /** How many splats have landed. The count to sort, to draw and to upload up to. */
  get ready(): number {
    return this.arrived;
  }

  /**
   * Copy one block's records in, deriving what the CPU needs from what the file carried.
   *
   * **Positions and extents come back out of the records rather than being stored beside them**,
   * which is the whole reason a `.drft` splat block is thirty-two bytes a splat rather than
   * forty-eight: the first three words are the position's own float bits and the eighth is the
   * extent's. See `packSplats`, which is what puts them there.
   */
  append(records: Uint32Array, count: number): SplatAppend {
    if (count < 0 || this.arrived + count > this.data.count) {
      throw new Error(
        `splats: a block of ${count} splats lands at ${this.arrived} in a capture of ` +
          `${this.data.count} splats, which does not fit`,
      );
    }
    if (records.length < count * this.words) {
      throw new Error(
        `splats: ${count} splats need ${count * this.words} entries and the block has ` +
          `${records.length}`,
      );
    }

    const from = this.arrived;
    this.data.packed.set(records.subarray(0, count * this.words), from * this.words);
    /*
     * Reinterpreting, not converting — the same inverse the shader applies. Going through a
     * `Float32Array` view of the destination rather than of the source, because the source may be
     * a view over the file at any four-byte offset and the destination is this capture's own
     * buffer at a known one.
     */
    const asFloat = new Float32Array(this.data.packed.buffer);
    for (let slot = 0; slot < count; slot++) {
      const splat = from + slot;
      const at = splat * this.words;
      this.data.positions[splat * 3] = asFloat[at] ?? 0;
      this.data.positions[splat * 3 + 1] = asFloat[at + 1] ?? 0;
      this.data.positions[splat * 3 + 2] = asFloat[at + 2] ?? 0;
      this.data.extents[splat] = asFloat[at + 7] ?? 0;
    }
    this.arrived += count;
    return { from, count };
  }
}

/**
 * A whole capture in one go, for a caller that read the file rather than streamed it.
 *
 * The same assembly `SplatCapture` does per block, without the object — `readDrft` hands back
 * every block already joined, so there is nothing left to append to.
 */
export function splatsFromRecords(source: {
  readonly count: number;
  readonly records: Uint32Array;
  readonly boundsMin: ArrayLike<number>;
  readonly boundsMax: ArrayLike<number>;
  readonly sphericalHarmonics?: number;
  /** The block's own record width. See `SplatCaptureOptions.wordsPerSplat`. */
  readonly wordsPerSplat?: number;
}): SplatData {
  const capture = new SplatCapture({
    total: source.count,
    boundsMin: source.boundsMin,
    boundsMax: source.boundsMax,
    ...(source.wordsPerSplat === undefined ? {} : { wordsPerSplat: source.wordsPerSplat }),
    ...(source.sphericalHarmonics === undefined
      ? {}
      : { sphericalHarmonics: source.sphericalHarmonics }),
  });
  capture.append(source.records, source.count);
  return capture.data;
}
