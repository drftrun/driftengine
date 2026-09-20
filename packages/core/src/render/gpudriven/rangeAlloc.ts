/**
 * A free list over one axis of units, and nothing else.
 *
 * **Four of these make a streaming scene** — vertices, indices, clusters and meshes — and none of
 * them needs to know what a cluster is. Keeping it that way is what lets "a returned range is
 * reusable" be a test that does not build a mesh.
 *
 * **Best fit rather than first fit**, because the workload that motivated this remeshes a chunk
 * into a slightly different size on every block a player breaks. First fit hands the front of the
 * largest hole to whatever asks next, so the large holes disappear first and the request that
 * needed one is refused while the total says there is room.
 *
 * **Refusal is `-1` rather than an exception**, because a streaming consumer calls `claim` from a
 * frame loop: an exception there is a crashed demo where a refusal is a chunk that arrives a frame
 * later.
 */

/** A free run: where it starts and how many units it holds. */
interface Hole {
  at: number;
  units: number;
}

export class RangeAlloc {
  /**
   * The free runs, kept sorted by `at` and never touching.
   *
   * **Sorted and coalesced is an invariant rather than a convenience**: it is what makes the
   * layout independent of the order ranges were released in, which a capture would otherwise
   * expose as an image that differs between runs with nothing failing.
   */
  private holes: Hole[];
  private readonly total: number;
  private usedUnits = 0;
  private high = 0;

  constructor(capacity: number) {
    const units = Math.max(0, Math.floor(capacity));
    this.total = units;
    this.holes = units > 0 ? [{ at: 0, units }] : [];
  }

  get capacity(): number {
    return this.total;
  }

  get used(): number {
    return this.usedUnits;
  }

  /** The most units ever live at once. `scripts/stream-fragmentation.mjs` reads this. */
  get highWater(): number {
    return this.high;
  }

  /**
   * The first unit of a run of `units`, or -1 where no single run is long enough.
   *
   * A request for nothing succeeds at 0 and occupies nothing: a mesh with no clusters is legal,
   * and `buildGpuDrivenScene`'s header says what dropping one would do to every mesh after it.
   */
  claim(units: number): number {
    const want = Math.max(0, Math.floor(units));
    if (want === 0) return 0;

    let best = -1;
    for (let i = 0; i < this.holes.length; i += 1) {
      const hole = this.holes[i] as Hole;
      if (hole.units < want) continue;
      if (best < 0 || hole.units < (this.holes[best] as Hole).units) best = i;
    }
    if (best < 0) return -1;

    const hole = this.holes[best] as Hole;
    const at = hole.at;
    if (hole.units === want) this.holes.splice(best, 1);
    else {
      hole.at += want;
      hole.units -= want;
    }
    this.usedUnits += want;
    if (this.usedUnits > this.high) this.high = this.usedUnits;
    return at;
  }

  /**
   * Give a run back, merging it with whatever it now touches.
   *
   * **Merged on the way in rather than swept later**, which is what keeps the invariant true at
   * every moment a caller could look and makes the order releases arrived in stop mattering.
   */
  release(at: number, units: number): void {
    const count = Math.max(0, Math.floor(units));
    if (count === 0) return;
    const start = Math.max(0, Math.floor(at));

    let index = 0;
    while (index < this.holes.length && (this.holes[index] as Hole).at < start) index += 1;
    this.holes.splice(index, 0, { at: start, units: count });
    this.usedUnits = Math.max(0, this.usedUnits - count);

    /* Merge with the one before and the one after, in that order, so three runs become one. */
    const previous = index > 0 ? (this.holes[index - 1] as Hole) : null;
    if (previous !== null && previous.at + previous.units === start) {
      previous.units += count;
      this.holes.splice(index, 1);
      index -= 1;
    }
    const merged = this.holes[index] as Hole;
    const next = index + 1 < this.holes.length ? (this.holes[index + 1] as Hole) : null;
    if (next !== null && merged.at + merged.units === next.at) {
      merged.units += next.units;
      this.holes.splice(index + 1, 1);
    }
  }

  /** Back to one free run, keeping the high-water mark, which is a record of the run so far. */
  reset(): void {
    this.holes = this.total > 0 ? [{ at: 0, units: this.total }] : [];
    this.usedUnits = 0;
  }
}
