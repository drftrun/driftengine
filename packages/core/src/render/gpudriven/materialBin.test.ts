import { expect, test } from 'vitest';

import {
  BIN_DISPATCH_WORDS,
  BIN_GROUP_SIZE,
  binDispatchArgs,
  binOffsets,
  binsPresent,
  countBins,
  fillBins,
  materialAt,
} from './materialBin.ts';
import { VIS_EMPTY, packVisibility } from './visbuffer.ts';

/** Four materials declared; a frame need not contain all of them. */
const MATERIALS = 4;

/**
 * A little frame: sixteen pixels, some covered by clusters 0 to 3, some by nothing.
 *
 * Cluster `n` is material `n % MATERIALS` through `materialOf`, so the bins are easy to read and
 * the mapping is still a lookup rather than arithmetic the test could get right for both sides.
 */
function frame() {
  const materialOf = new Uint32Array([0, 1, 2, 1, 1]);
  const visibility = new Uint32Array(16).fill(VIS_EMPTY);
  /* Cluster 0 (material 0): two pixels. */
  visibility[0] = packVisibility(0, 5);
  visibility[9] = packVisibility(0, 0);
  /* Clusters 1, 3 and 4 (all material 1): four pixels. */
  visibility[1] = packVisibility(1, 0);
  visibility[2] = packVisibility(3, 17);
  visibility[7] = packVisibility(4, 1);
  visibility[15] = packVisibility(1, 127);
  /* Cluster 2 (material 2): one pixel. Material 3 has none at all. */
  visibility[12] = packVisibility(2, 2);
  return { visibility, materialOf };
}

test('a covered pixel names the material of the cluster it recorded', () => {
  const { visibility, materialOf } = frame();
  expect(materialAt(visibility, materialOf, 2)).toBe(1);
  expect(materialAt(visibility, materialOf, 12)).toBe(2);
});

test('AN UNCOVERED PIXEL LANDS IN NO BIN AT ALL', () => {
  const { visibility, materialOf } = frame();
  expect(materialAt(visibility, materialOf, 3)).toBe(-1);
  const counts = new Uint32Array(MATERIALS);
  expect(countBins(visibility, materialOf, counts)).toBe(7);
});

test('EVERY COVERED PIXEL LANDS IN EXACTLY ONE BIN', () => {
  const { visibility, materialOf } = frame();
  const counts = new Uint32Array(MATERIALS);
  const covered = countBins(visibility, materialOf, counts);
  const offsets = new Uint32Array(MATERIALS);
  const cursors = new Uint32Array(MATERIALS);
  const pixels = new Uint32Array(binOffsets(counts, offsets));
  fillBins(visibility, materialOf, offsets, cursors, pixels);

  expect(pixels.length).toBe(covered);
  const seen = new Set(pixels);
  expect(seen.size).toBe(covered);
  for (const pixel of seen)
    expect(materialAt(visibility, materialOf, pixel)).toBeGreaterThanOrEqual(0);
});

test('and every pixel in a bin belongs to that bin', () => {
  const { visibility, materialOf } = frame();
  const counts = new Uint32Array(MATERIALS);
  countBins(visibility, materialOf, counts);
  const offsets = new Uint32Array(MATERIALS);
  const cursors = new Uint32Array(MATERIALS);
  const pixels = new Uint32Array(binOffsets(counts, offsets));
  fillBins(visibility, materialOf, offsets, cursors, pixels);

  for (let material = 0; material < MATERIALS; material += 1) {
    const from = offsets[material] as number;
    const to = from + (counts[material] as number);
    for (let at = from; at < to; at += 1) {
      expect(materialAt(visibility, materialOf, pixels[at] as number)).toBe(material);
    }
  }
});

test('BIN OFFSETS ARE THE PREFIX SUM OF THE COUNTS', () => {
  const counts = new Uint32Array([2, 4, 1, 0]);
  const offsets = new Uint32Array(4);
  expect(binOffsets(counts, offsets)).toBe(7);
  expect(Array.from(offsets)).toEqual([0, 2, 6, 7]);
});

test('an empty bin does not consume a slot, so the bin after it starts where the last one ended', () => {
  const counts = new Uint32Array([0, 3, 0, 2]);
  const offsets = new Uint32Array(4);
  expect(binOffsets(counts, offsets)).toBe(5);
  expect(Array.from(offsets)).toEqual([0, 0, 3, 3]);
});

test('A MATERIAL WITH NO PIXELS STILL HAS A DISPATCH BLOCK, and it asks for zero groups', () => {
  /*
   * **Not an absent one.** The blocks are indexed by material identifier, so dropping an empty
   * material's shifts every later one and the scene shades with the wrong code — a picture that is
   * plausible, entirely wrong, and correlates with nothing a consumer changed.
   */
  const { visibility, materialOf } = frame();
  const counts = new Uint32Array(MATERIALS);
  countBins(visibility, materialOf, counts);
  const args = new Uint32Array(MATERIALS * BIN_DISPATCH_WORDS);
  binDispatchArgs(counts, args);

  expect(args.length).toBe(MATERIALS * BIN_DISPATCH_WORDS);
  expect(Array.from(args.subarray(3 * BIN_DISPATCH_WORDS))).toEqual([0, 1, 1]);
  /* And the ones that do have pixels ask for the groups their counts imply. */
  expect(args[0]).toBe(1);
  expect(args[BIN_DISPATCH_WORDS]).toBe(1);
});

test('a bin larger than one group asks for as many as it needs', () => {
  const counts = new Uint32Array([BIN_GROUP_SIZE * 2 + 1, 0]);
  const args = new Uint32Array(2 * BIN_DISPATCH_WORDS);
  binDispatchArgs(counts, args);
  expect(args[0]).toBe(3);
});

test('THE NUMBER OF BINS PRESENT IS NOT THE NUMBER DECLARED', () => {
  const { visibility, materialOf } = frame();
  const counts = new Uint32Array(MATERIALS);
  countBins(visibility, materialOf, counts);
  expect(binsPresent(counts)).toBe(3);
  expect(counts.length).toBe(MATERIALS);
});

test('a frame that drew nothing has no bins present and no pixels', () => {
  const visibility = new Uint32Array(16).fill(VIS_EMPTY);
  const materialOf = new Uint32Array([0, 1]);
  const counts = new Uint32Array(MATERIALS);
  expect(countBins(visibility, materialOf, counts)).toBe(0);
  expect(binsPresent(counts)).toBe(0);
});

test('COUNTS ARE CLEARED BY THE COUNT PASS, so a reused buffer does not grow every frame', () => {
  const { visibility, materialOf } = frame();
  const counts = new Uint32Array(MATERIALS);
  countBins(visibility, materialOf, counts);
  const first = Array.from(counts);
  countBins(visibility, materialOf, counts);
  expect(Array.from(counts)).toEqual(first);
});

test('a cluster whose material is past the table is skipped rather than binned somewhere', () => {
  const materialOf = new Uint32Array([0]);
  const visibility = new Uint32Array([packVisibility(0, 0), packVisibility(9, 0)]);
  expect(materialAt(visibility, materialOf, 1)).toBe(-1);
  const counts = new Uint32Array(MATERIALS);
  expect(countBins(visibility, materialOf, counts)).toBe(1);
});
