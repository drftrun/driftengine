/**
 * Movers on a graph's edges, ordered along each: who is on an edge, in the order they stand, and
 * who stands next ahead of whom — rebuilt from their edges and positions every tick, allocating
 * nothing.
 *
 * A counting sort by edge and an insertion sort within each, which is the cheap order for a few
 * movers an edge that barely change order between ticks. What would make it wrong: an edge holding
 * hundreds, where the insertion sort's quadratic worst case begins to show.
 */
export class EdgeBuckets {
  /** Movers on edge `e` are `order[start[e]]` up to `order[start[e + 1]]`, rearmost first. */
  readonly start: Uint32Array;
  readonly order: Uint32Array;
  /** Where each mover stands in `order`. */
  readonly rank: Uint32Array;

  constructor(edges: number, movers: number) {
    this.start = new Uint32Array(edges + 2);
    this.order = new Uint32Array(movers);
    this.rank = new Uint32Array(movers);
  }

  /** Bucket the first `count` movers by `edge`, each bucket ordered by `at`. */
  build(edge: Int32Array, at: Float32Array, count: number): void {
    const { start, order, rank } = this;
    /* Counts two along, summed, leave `start[e + 1]` at bucket e's beginning; placing each mover
       moves it to the end, which is bucket e + 1's beginning, so `start[e]` begins bucket e. */
    start.fill(0);
    for (let i = 0; i < count; i++) {
      const k = (edge[i] as number) + 2;
      start[k] = (start[k] as number) + 1;
    }
    for (let e = 2; e < start.length; e++)
      start[e] = (start[e] as number) + (start[e - 1] as number);
    for (let i = 0; i < count; i++) {
      const k = (edge[i] as number) + 1;
      const slot = start[k] as number;
      order[slot] = i;
      start[k] = slot + 1;
    }
    const edges = start.length - 2;
    for (let e = 0; e < edges; e++) {
      const lo = start[e] as number;
      const hi = start[e + 1] as number;
      for (let a = lo + 1; a < hi; a++) {
        const m = order[a] as number;
        const s = at[m] as number;
        let b = a - 1;
        while (b >= lo && (at[order[b] as number] as number) > s) {
          order[b + 1] = order[b] as number;
          b--;
        }
        order[b + 1] = m;
      }
      for (let a = lo; a < hi; a++) rank[order[a] as number] = a;
    }
  }

  /** The mover next ahead of `i` on its own edge, or −1. */
  ahead(i: number, e: number): number {
    const r = (this.rank[i] as number) + 1;
    return r < (this.start[e + 1] as number) ? (this.order[r] as number) : -1;
  }

  /** The rearmost mover on edge `e`, or −1. */
  rearmost(e: number): number {
    const lo = this.start[e] as number;
    return lo < (this.start[e + 1] as number) ? (this.order[lo] as number) : -1;
  }

  /** The foremost mover on edge `e`, or −1. */
  foremost(e: number): number {
    const hi = this.start[e + 1] as number;
    return hi > (this.start[e] as number) ? (this.order[hi - 1] as number) : -1;
  }
}
