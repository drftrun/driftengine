/**
 * Which tile of the frame each splat lands in, so a device can draw a cloud one tile at a time.
 *
 * **A splat cannot be drawn by one invocation per splat**, because splats overlap and compositing
 * is ordered: two invocations writing the same pixel have no way to agree who was in front. The
 * answer every implementation reaches is to turn the problem inside out — one workgroup per tile
 * of the frame, each walking a list of the splats that touch it, each pixel accumulating its own
 * colour in a register. This builds those lists.
 *
 * **The lists keep the order the splats arrive in.** The scatter is stable, so a caller that hands
 * over a cloud already sorted by depth gets tiles whose lists are sorted by depth, and the
 * compositing is correct without a per-tile sort anywhere. That is the whole reason the sort is a
 * separate step rather than part of this one, and it is a *contract*: a caller that presents its
 * splats in an arbitrary order gets tiles that composite in that arbitrary order, which is a
 * picture rather than an error.
 *
 * **The tile range is derived from the same pixel box the rasteriser loops over**, not from the
 * ellipse again. Two derivations of one footprint drift, and the failure is a splat missing from a
 * tile it actually covers — a hole in the picture that moves with the camera and looks like a
 * culling bug.
 *
 * **The lists are built twice over, by tile and by splat, and the second is what makes a backward
 * pass deterministic.** A tile's gradients have to be added into the splats it walked, and many
 * tiles touch one splat — which on a device is a floating-point atomic. WGSL has none, and the
 * usual answer, a compare-and-swap loop over the bits, sums in whatever order the tiles happen to
 * finish: floating-point addition is not associative, so the same cloud gives a different gradient
 * every run and a fit stops reproducing. So every (tile, splat) pair gets a slot of its own,
 * `pairOf` says which, and a splat's slots are **contiguous** — a reduction over them is a loop in
 * a fixed order, which is the same answer every time on every device.
 */

/** The side of a tile in pixels; one workgroup covers one tile. */
export const SPLAT_TILE = 16;

/** Floats a splat's screen footprint occupies: `x`, `y`, `radius`, `depth`. */
export const SPLAT_BIN_FLOATS = 4;

/** How many tiles a frame of this size is cut into, across and down. */
export function splatTileGrid(width: number, height: number): { across: number; down: number } {
  return {
    across: Math.max(0, Math.ceil(width / SPLAT_TILE)),
    down: Math.max(0, Math.ceil(height / SPLAT_TILE)),
  };
}

/**
 * The pixel box a splat covers, clamped to the frame, into `out` as `left`, `top`, `right`,
 * `bottom` — or `false` where it covers nothing.
 *
 * **This is the rasteriser's own box.** A device that computed its footprint any other way would
 * be a second answer to the same question.
 */
export function splatPixelBox(
  bins: ArrayLike<number>,
  at: number,
  width: number,
  height: number,
  out: Int32Array,
): boolean {
  const x = bins[at * SPLAT_BIN_FLOATS] as number;
  const y = bins[at * SPLAT_BIN_FLOATS + 1] as number;
  const radius = bins[at * SPLAT_BIN_FLOATS + 2] as number;
  if (!(radius > 0)) return false;
  const left = Math.max(0, Math.floor(x - radius));
  const right = Math.min(width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius));
  const bottom = Math.min(height - 1, Math.ceil(y + radius));
  if (right < left || bottom < top) return false;
  out[0] = left;
  out[1] = top;
  out[2] = right;
  out[3] = bottom;
  return true;
}

/**
 * How many splats each tile holds, and how many entries the lists need in total.
 *
 * `counts` is cleared here rather than by the caller: a count buffer reused across steps without
 * clearing grows without bound, and the lists then run off the end of themselves.
 */
export function countSplatTiles(
  bins: ArrayLike<number>,
  count: number,
  width: number,
  height: number,
  counts: Uint32Array,
  tilesPerSplat?: Uint32Array,
): number {
  counts.fill(0);
  tilesPerSplat?.fill(0);
  const { across } = splatTileGrid(width, height);
  const box = new Int32Array(4);
  let total = 0;
  for (let at = 0; at < count; at += 1) {
    if (!splatPixelBox(bins, at, width, height, box)) continue;
    const first = Math.floor((box[0] as number) / SPLAT_TILE);
    const last = Math.floor((box[2] as number) / SPLAT_TILE);
    const top = Math.floor((box[1] as number) / SPLAT_TILE);
    const bottom = Math.floor((box[3] as number) / SPLAT_TILE);
    for (let row = top; row <= bottom; row += 1) {
      for (let column = first; column <= last; column += 1) {
        const tile = row * across + column;
        counts[tile] = (counts[tile] as number) + 1;
        total += 1;
      }
    }
    if (tilesPerSplat !== undefined) {
      tilesPerSplat[at] = (last - first + 1) * (bottom - top + 1);
    }
  }
  return total;
}

/**
 * Where each tile's list begins: the exclusive prefix sum of the counts. Answers the total.
 *
 * A tile with no splats gets a zero-length list at a real offset rather than no entry at all,
 * because the offsets are indexed by tile and dropping an empty one moves every later tile's list.
 */
export function splatTileOffsets(counts: Uint32Array, offsets: Uint32Array): number {
  let running = 0;
  for (let tile = 0; tile < counts.length; tile += 1) {
    offsets[tile] = running;
    running += counts[tile] as number;
  }
  return running;
}

/**
 * Every splat written into the list of each tile it touches, in the order the splats are given.
 *
 * `cursors` is where each tile has got to and starts as a copy of `offsets` — it cannot be the
 * offsets themselves, or the second splat of a tile overwrites the first's offset and every later
 * tile's list starts in the wrong place.
 */
export function fillSplatTiles(
  bins: ArrayLike<number>,
  count: number,
  width: number,
  height: number,
  offsets: Uint32Array,
  cursors: Uint32Array,
  lists: Uint32Array,
  pairs?: { readonly offsets: Uint32Array; readonly pairOf: Uint32Array },
): void {
  cursors.set(offsets);
  const { across } = splatTileGrid(width, height);
  const box = new Int32Array(4);
  for (let at = 0; at < count; at += 1) {
    if (!splatPixelBox(bins, at, width, height, box)) continue;
    const first = Math.floor((box[0] as number) / SPLAT_TILE);
    const last = Math.floor((box[2] as number) / SPLAT_TILE);
    const top = Math.floor((box[1] as number) / SPLAT_TILE);
    const bottom = Math.floor((box[3] as number) / SPLAT_TILE);
    let taken = 0;
    for (let row = top; row <= bottom; row += 1) {
      for (let column = first; column <= last; column += 1) {
        const tile = row * across + column;
        const slot = cursors[tile] as number;
        if (slot >= lists.length) continue;
        lists[slot] = at;
        cursors[tile] = slot + 1;
        if (pairs !== undefined) {
          pairs.pairOf[slot] = (pairs.offsets[at] as number) + taken;
          taken += 1;
        }
      }
    }
  }
}

/**
 * Where each splat's own run of partial-gradient slots begins: the prefix sum over `tilesPerSplat`.
 *
 * The same shape as `splatTileOffsets` and for the opposite index. A splat that covers no tile gets
 * an empty run rather than no entry, because a reduction is indexed by splat.
 */
export function splatPairOffsets(tilesPerSplat: Uint32Array, offsets: Uint32Array): number {
  let running = 0;
  for (let at = 0; at < tilesPerSplat.length; at += 1) {
    offsets[at] = running;
    running += tilesPerSplat[at] as number;
  }
  return running;
}
