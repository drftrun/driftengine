/**
 * Grouping the frame's pixels by the material that has to shade them.
 *
 * **A visibility buffer defers the shading and does not organise it.** Neighbouring pixels can
 * hold triangles from different meshes with different materials, so shading it in place means
 * every invocation branching on a material it cannot know until it has read the buffer — which on
 * a wide machine is every lane in a group taking every branch. Binning first turns that into one
 * dispatch per material, each of which shades pixels that all want the same code.
 *
 * **A material with no pixels gets a zero-length bin and a zero-workgroup dispatch, never an
 * absent one.** The arguments are indexed by material identifier, so dropping an empty one shifts
 * every later material's block and the scene shades with the wrong code — a picture that is
 * plausible, entirely wrong, and correlates with nothing a consumer changed. `binsPresent` is the
 * separate question of how many materials actually appear, which is a number to report rather
 * than a length to index by.
 *
 * **Offsets are a prefix sum and the cursors are a copy of it.** The scatter needs somewhere to
 * count from that is not the offsets themselves, or the second pixel of a bin overwrites the
 * first's offset and every later bin starts in the wrong place.
 */

import { INDIRECT_DISPATCH_WORDS, writeDispatchArgs } from './indirect.ts';
import { VIS_TRIANGLE_BITS, visibilityCovered } from './visbuffer.ts';

/** Invocations a shading group covers. One pixel each; the bins are lists, not rectangles. */
export const BIN_GROUP_SIZE = 64;

/** Words in one material's dispatch block, so a caller can size the buffer. */
export const BIN_DISPATCH_WORDS = INDIRECT_DISPATCH_WORDS;

/**
 * Which material a pixel wants, or -1 where nothing covered it.
 *
 * **The sentinel test survives perturbation and is kept**, which is worth the sentence because it
 * looks like the load-bearing line and is not. `VIS_EMPTY` is `0xffffffff`, so its cluster field
 * reads as 33,554,431 — and the range test one line down refuses any cluster past the table, which
 * every real table is far smaller than. Deleting either check alone therefore changes no answer
 * this repository can produce. What the sentinel test decides is a table sized to the full
 * twenty-five bits, which is 134 MB and nothing allocates; what the range test decides is a
 * visibility buffer left over from a frame with more geometry in it, which is a real case and is
 * the one `gpu-parity.mjs` generates. Both are kept because they answer different questions and
 * one of them is cheap insurance against the other's assumption.
 */
export function materialAt(
  visibility: Uint32Array,
  materialOf: Uint32Array,
  pixel: number,
): number {
  const packed = visibility[pixel] as number;
  if (!visibilityCovered(packed)) return -1;
  const cluster = packed >>> VIS_TRIANGLE_BITS;
  const material = materialOf[cluster];
  return material === undefined ? -1 : material;
}

/**
 * How many pixels each material owns, and how many pixels were covered at all.
 *
 * `counts` is cleared here rather than by the caller, because a count buffer reused across frames
 * without clearing grows without bound and the bins then run off the end of the pixel list —
 * which appears as the shading reading a neighbouring bin's pixels.
 */
export function countBins(
  visibility: Uint32Array,
  materialOf: Uint32Array,
  counts: Uint32Array,
): number {
  counts.fill(0);
  let covered = 0;
  for (let pixel = 0; pixel < visibility.length; pixel += 1) {
    const material = materialAt(visibility, materialOf, pixel);
    if (material < 0 || material >= counts.length) continue;
    counts[material] = (counts[material] as number) + 1;
    covered += 1;
  }
  return covered;
}

/** Where each material's pixels begin: the exclusive prefix sum of the counts. */
export function binOffsets(counts: Uint32Array, offsets: Uint32Array): number {
  let running = 0;
  for (let material = 0; material < counts.length; material += 1) {
    offsets[material] = running;
    running += counts[material] as number;
  }
  return running;
}

/**
 * Write every covered pixel's index into its material's slice of `pixels`.
 *
 * `cursors` starts as a copy of `offsets` and is advanced as the scatter runs, so `offsets` stays
 * readable afterwards — which the shading dispatch needs, because it is what tells a group where
 * its material's list starts.
 */
export function fillBins(
  visibility: Uint32Array,
  materialOf: Uint32Array,
  offsets: Uint32Array,
  cursors: Uint32Array,
  pixels: Uint32Array,
): void {
  cursors.set(offsets);
  for (let pixel = 0; pixel < visibility.length; pixel += 1) {
    const material = materialAt(visibility, materialOf, pixel);
    if (material < 0 || material >= offsets.length) continue;
    const at = cursors[material] as number;
    pixels[at] = pixel;
    cursors[material] = at + 1;
  }
}

/** One dispatch block per **declared** material, zero groups where the bin is empty. */
export function binDispatchArgs(
  counts: Uint32Array,
  out: Uint32Array,
  groupSize: number = BIN_GROUP_SIZE,
): void {
  for (let material = 0; material < counts.length; material += 1) {
    writeDispatchArgs(out, material * BIN_DISPATCH_WORDS, counts[material] as number, groupSize);
  }
}

/** How many materials the frame actually contains, which is not how many it declares. */
export function binsPresent(counts: Uint32Array): number {
  let present = 0;
  for (let material = 0; material < counts.length; material += 1) {
    if ((counts[material] as number) > 0) present += 1;
  }
  return present;
}
