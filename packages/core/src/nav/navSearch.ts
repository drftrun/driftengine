import type { NavGraph } from './navGraph.ts';

/**
 * A* over a `NavGraph`, allocating nothing per query and answering the same route every time.
 *
 * **Reused rather than constructed per search**, because the scratch is proportional to the graph
 * and a world with a dozen agents re-pathing on a schedule would otherwise allocate a dozen arrays
 * the size of the map every time somebody changed their mind. One of these per thread of control;
 * a search is not re-entrant and says so.
 *
 * **The route is a function of the graph and the two endpoints, and of nothing else.** Two runs, two
 * machines, a replay: same nodes out. That takes more than avoiding randomness — a heap pops ties in
 * whatever order it happens to hold them, and two equally good routes through a symmetric world are
 * exactly the case a road network produces constantly. So ties break on the node index, which is
 * arbitrary but *stable*, and the sequence is frozen the same way the engine's RNG is.
 *
 * **The heuristic is straight-line distance**, which is admissible precisely because
 * `buildNavGraph` refuses an edge cheaper than its own span. That refusal is what makes the first
 * route this returns the cheapest one rather than merely a good one, and it is why it is a build
 * error rather than a note.
 */
export class NavSearch {
  private readonly graph: NavGraph;
  private readonly gScore: Float64Array;
  private readonly fScore: Float64Array;
  private readonly cameFrom: Int32Array;
  /** 0 unseen, 1 open, 2 closed. */
  private readonly state: Uint8Array;
  /**
   * A binary heap of node indices, ordered by `fScore` then by index.
   *
   * **Sized by edges and not by nodes**, from an argument rather than from a measurement: a push
   * happens at most once per directed edge — a node goes on when it is first reached and again only
   * when an edge improves it — so an array of that length cannot overflow. A node count is *not* a
   * bound on that, and the failure it would allow is the quiet kind: a dropped push is not a slower
   * search, it is a node marked open that nothing will ever pop, so a route that exists comes back
   * as none.
   *
   * **No test here exhibits that**, and `nav.test.ts` says so where the dense graph is: occupancy
   * in practice sits far below either bound, so a graph that could tell the two sizings apart is
   * larger than a suite should carry. The argument is what the sizing rests on and the guard in
   * `push` is what stands behind the argument.
   */
  private readonly heap: Uint32Array;
  private heapSize = 0;
  /** How many nodes the last search took off the heap. Useful for a budget, and for a test. */
  private lastExpanded = 0;

  constructor(graph: NavGraph) {
    this.graph = graph;
    this.gScore = new Float64Array(graph.nodeCount);
    this.fScore = new Float64Array(graph.nodeCount);
    this.cameFrom = new Int32Array(graph.nodeCount);
    this.state = new Uint8Array(graph.nodeCount);
    this.heap = new Uint32Array(graph.edgeTarget.length + 1);
  }

  /** Nodes taken off the heap by the last `find`. */
  get expanded(): number {
    return this.lastExpanded;
  }

  /**
   * Fill `outPath` with the node indices from `from` to `to`, and return how many there are.
   *
   * Zero means there is no route, which is a real answer and not an error: a road network with a
   * bridge out is a graph with two components, and an agent that asks for the other side has to be
   * told rather than thrown at inside a frame.
   *
   * A path longer than `outPath` is refused by returning zero rather than by writing a prefix,
   * because half a route is worse than none — an agent would follow it confidently into the middle
   * of nowhere and stop.
   */
  find(from: number, to: number, outPath: Uint32Array): number {
    const { graph } = this;
    if (from < 0 || from >= graph.nodeCount || to < 0 || to >= graph.nodeCount) return 0;
    this.state.fill(0);
    this.heapSize = 0;
    this.lastExpanded = 0;

    this.gScore[from] = 0;
    this.fScore[from] = this.straightLine(from, to);
    this.cameFrom[from] = -1;
    this.state[from] = 1;
    this.push(from);

    while (this.heapSize > 0) {
      const current = this.pop();
      if (current === to) return this.unwind(from, to, outPath);
      /* A duplicate of a node already expanded, left behind by pushing instead of decreasing a
         key. Its cost is already final, so re-walking its edges would find nothing. */
      if (this.state[current] === 2) continue;
      this.state[current] = 2;
      this.lastExpanded++;

      const end = graph.edgeStart[current + 1] ?? 0;
      for (let e = graph.edgeStart[current] ?? 0; e < end; e++) {
        const next = graph.edgeTarget[e] ?? 0;
        if (this.state[next] === 2) continue;
        const tentative = (this.gScore[current] ?? 0) + (graph.edgeCost[e] ?? 0);
        if (this.state[next] === 1 && tentative >= (this.gScore[next] ?? 0)) continue;
        this.gScore[next] = tentative;
        this.fScore[next] = tentative + this.straightLine(next, to);
        this.cameFrom[next] = current;
        /*
         * Pushed again rather than decreased in place. A decrease-key needs every node's position
         * in the heap maintained on every swap, which is a second array and a write per sift step
         * for a graph where a node is rarely improved twice; the duplicate is popped later, found
         * closed, and skipped. The heap is sized for that: a node can be open once per edge into
         * it, and the loop below tolerates a full heap by dropping the worse copy.
         */
        this.state[next] = 1;
        this.push(next);
      }
    }
    return 0;
  }

  /**
   * Straight-line distance, the heuristic.
   *
   * Never an overestimate, because no edge may cost less than its own span — `buildNavGraph`
   * enforces it — so the first time the goal comes off the heap its cost is final.
   */
  private straightLine(a: number, b: number): number {
    const p = this.graph.positions;
    const dx = (p[a * 3] ?? 0) - (p[b * 3] ?? 0);
    const dy = (p[a * 3 + 1] ?? 0) - (p[b * 3 + 1] ?? 0);
    const dz = (p[a * 3 + 2] ?? 0) - (p[b * 3 + 2] ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Walk `cameFrom` back from the goal, then reverse it in place. */
  private unwind(from: number, to: number, outPath: Uint32Array): number {
    let length = 0;
    for (let node = to; node !== -1; node = this.cameFrom[node] ?? -1) {
      if (length >= outPath.length) return 0;
      outPath[length++] = node;
      if (node === from) break;
    }
    for (let i = 0, j = length - 1; i < j; i++, j--) {
      const swap = outPath[i] ?? 0;
      outPath[i] = outPath[j] ?? 0;
      outPath[j] = swap;
    }
    return length;
  }

  private better(a: number, b: number): boolean {
    const fa = this.fScore[a] ?? 0;
    const fb = this.fScore[b] ?? 0;
    if (fa !== fb) return fa < fb;
    /* The tie-break that makes a route reproducible. See the class note. */
    return a < b;
  }

  private push(node: number): void {
    /*
     * Unreachable with the heap sized by edges above, and kept because the alternative to a guard
     * here is writing past the end of the array in a frame. If it ever fires, the sizing argument
     * is wrong and a route will be missed rather than a crash reported — which is why the sizing
     * argument is written out where the array is declared.
     */
    if (this.heapSize >= this.heap.length) return;
    let at = this.heapSize++;
    this.heap[at] = node;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.better(this.heap[at] ?? 0, this.heap[parent] ?? 0)) break;
      const swap = this.heap[at] ?? 0;
      this.heap[at] = this.heap[parent] ?? 0;
      this.heap[parent] = swap;
      at = parent;
    }
  }

  private pop(): number {
    const top = this.heap[0] ?? 0;
    this.heapSize--;
    if (this.heapSize > 0) {
      this.heap[0] = this.heap[this.heapSize] ?? 0;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let best = at;
        if (left < this.heapSize && this.better(this.heap[left] ?? 0, this.heap[best] ?? 0))
          best = left;
        if (right < this.heapSize && this.better(this.heap[right] ?? 0, this.heap[best] ?? 0))
          best = right;
        if (best === at) break;
        const swap = this.heap[at] ?? 0;
        this.heap[at] = this.heap[best] ?? 0;
        this.heap[best] = swap;
        at = best;
      }
    }
    return top;
  }
}
