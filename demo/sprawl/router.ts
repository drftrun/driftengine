/**
 * The shortest walk over a graph held as neighbour lists — `next[first[n]]` up to
 * `next[first[n + 1]]`, each step `length` long — by Dijkstra's search over a binary heap whose
 * arrays are sized once, so a route allocates nothing.
 */
export class Router {
  private readonly dist: Float32Array;
  private readonly prev: Int32Array;
  private readonly heap: Int32Array;
  private readonly key: Float32Array;
  private size = 0;

  constructor(
    private readonly first: Uint32Array,
    private readonly next: Uint32Array,
    private readonly length: Float32Array,
  ) {
    const nodes = first.length - 1;
    this.dist = new Float32Array(nodes);
    this.prev = new Int32Array(nodes);
    this.heap = new Int32Array(next.length + 1);
    this.key = new Float32Array(next.length + 1);
  }

  /**
   * The shortest walk from `from` to `to`, its nodes after `from` written into `out` from `at`,
   * at most `max` of them — the first `max` of a longer one. Returns how many; 0 when unreachable
   * or already there.
   */
  route(from: number, to: number, out: Uint16Array, at: number, max: number): number {
    const { dist, prev, first, next, length } = this;
    dist.fill(Infinity);
    prev.fill(-1);
    dist[from] = 0;
    this.size = 0;
    this.push(from, 0);
    while (this.size > 0) {
      const d = this.key[0] as number;
      const n = this.pop();
      if (d > (dist[n] as number)) continue;
      if (n === to) break;
      for (let e = first[n] as number; e < (first[n + 1] as number); e++) {
        const m = next[e] as number;
        const nd = d + (length[e] as number);
        if (nd < (dist[m] as number)) {
          dist[m] = nd;
          prev[m] = n;
          this.push(m, nd);
        }
      }
    }
    if (from === to || prev[to] === -1) return 0;
    let steps = 0;
    for (let n = to; n !== from; n = prev[n] as number) steps++;
    const kept = Math.min(steps, max);
    let n = to;
    for (let i = steps; i > kept; i--) n = prev[n] as number;
    for (let i = kept - 1; i >= 0; i--) {
      out[at + i] = n;
      n = prev[n] as number;
    }
    return kept;
  }

  private push(n: number, d: number): void {
    const { heap, key } = this;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((key[p] as number) <= d) break;
      heap[i] = heap[p] as number;
      key[i] = key[p] as number;
      i = p;
    }
    heap[i] = n;
    key[i] = d;
  }

  /** Take the nearest off the heap, sifting the last down into its place. */
  private pop(): number {
    const { heap, key } = this;
    const top = heap[0] as number;
    const size = --this.size;
    const ln = heap[size] as number;
    const ld = key[size] as number;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && (key[c + 1] as number) < (key[c] as number)) c++;
      if ((key[c] as number) >= ld) break;
      heap[i] = heap[c] as number;
      key[i] = key[c] as number;
      i = c;
    }
    heap[i] = ln;
    key[i] = ld;
    return top;
  }
}
