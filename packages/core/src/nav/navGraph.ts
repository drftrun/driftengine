/**
 * A graph to path over: nodes somewhere in the world, edges between them, and a cost per edge.
 *
 * **A graph rather than a navigation mesh, and that is a decision rather than a first step.** A
 * mesh is what you build when walkable space is an arbitrary region and an agent may cross it
 * anywhere; a graph is what you build when the ways through a world are *already* a network —
 * roads, corridors, rails, docking lanes, the connections between rooms. Consumers of this engine
 * keep arriving with the second: one reported that they extract a road graph from their world
 * already and that their agents still walk straight at the target and wedge against a wall on the
 * way, about once every two minutes of play. A mesh would have asked them to throw that away and
 * start from geometry.
 *
 * What it costs is honest and worth saying at the top: **an agent on a graph travels along edges,
 * so it takes corners the graph has and none it does not.** Open ground crossed by two nodes is
 * crossed in one straight line. If a world's walkable space genuinely is a region, this is the
 * wrong structure and a mesh is the row that is still open.
 *
 * **Structure of arrays, CSR adjacency, everything typed.** The search below runs inside a frame
 * budget against a graph a consumer may rebuild when the world changes, so nothing here holds an
 * object per node and nothing allocates during a query.
 */

export interface NavGraph {
  /** xyz per node, in world units. */
  readonly positions: Float32Array;
  readonly nodeCount: number;
  /** CSR offsets: node `i`'s edges are `[edgeStart[i], edgeStart[i + 1])`. Length `nodeCount + 1`. */
  readonly edgeStart: Uint32Array;
  /** The node at the far end of each edge. */
  readonly edgeTarget: Uint32Array;
  /** What each edge costs to traverse. Distance unless the caller said otherwise. */
  readonly edgeCost: Float32Array;
}

export interface NavEdge {
  readonly from: number;
  readonly to: number;
  /**
   * What crossing it costs. Defaults to the distance between its ends.
   *
   * **A cost is not a distance and the difference is the whole of route quality.** Mud, a hill, a
   * toll, a road an agent should prefer, a corridor it should avoid unless there is nothing else:
   * all of them are this number, and a consumer that never sets it gets shortest-path behaviour.
   * The one rule the search depends on is that a cost is **never less than the straight-line
   * distance between the two ends** — see `navSearch`, where the heuristic that makes A* exact
   * assumes exactly that. Faster-than-flying edges are refused at build time rather than producing
   * a route that is quietly not the best one.
   */
  readonly cost?: number;
  /** Whether it may also be crossed the other way. Default true. */
  readonly bidirectional?: boolean;
}

/**
 * Build the graph, checking the two things that make a wrong route look like a working one.
 *
 * An edge naming a node that does not exist, and an edge cheaper than flying: both produce a graph
 * that searches happily and answers wrongly, one by reading past the end of an array and one by
 * breaking the admissibility A* needs. Refused here, at build time, which is where this engine
 * refuses things.
 */
export function buildNavGraph(
  positions: Float32Array | readonly number[],
  edges: readonly NavEdge[],
): NavGraph {
  const points = positions instanceof Float32Array ? positions : new Float32Array(positions);
  if (points.length % 3 !== 0) {
    throw new Error(`buildNavGraph: positions must be xyz-packed, got ${points.length} floats`);
  }
  const nodeCount = points.length / 3;
  if (nodeCount === 0)
    throw new Error('buildNavGraph: a graph with no nodes has nothing to path over');

  const degree = new Uint32Array(nodeCount);
  for (const edge of edges) {
    check(edge.from, nodeCount, 'from');
    check(edge.to, nodeCount, 'to');
    degree[edge.from] = (degree[edge.from] ?? 0) + 1;
    if (edge.bidirectional !== false) degree[edge.to] = (degree[edge.to] ?? 0) + 1;
  }

  const edgeStart = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) edgeStart[i + 1] = (edgeStart[i] ?? 0) + (degree[i] ?? 0);
  const total = edgeStart[nodeCount] ?? 0;
  const edgeTarget = new Uint32Array(total);
  const edgeCost = new Float32Array(total);

  const cursor = new Uint32Array(nodeCount);
  for (const edge of edges) {
    const span = distance(points, edge.from, edge.to);
    const cost = edge.cost ?? span;
    if (!(cost >= span)) {
      throw new Error(
        `buildNavGraph: edge ${edge.from}->${edge.to} costs ${cost} over a span of ${span}. ` +
          'A cost below the straight-line distance breaks the search heuristic and returns routes ' +
          'that are not the cheapest, silently.',
      );
    }
    write(edgeStart, cursor, edgeTarget, edgeCost, edge.from, edge.to, cost);
    if (edge.bidirectional !== false) {
      write(edgeStart, cursor, edgeTarget, edgeCost, edge.to, edge.from, cost);
    }
  }

  return { positions: points, nodeCount, edgeStart, edgeTarget, edgeCost };
}

/**
 * The node nearest a world position, or −1 for a graph with none in reach.
 *
 * **A linear scan, and the ceiling is stated rather than discovered.** A road network is hundreds
 * of nodes and a scan over it is microseconds; a graph of tens of thousands wants a spatial index,
 * and a consumer with one should keep their own and pass the answer to `navSearch` directly, which
 * is why that function takes node indices and not positions.
 *
 * `maxDistance` is what stops an agent that has walked off the network being snapped onto the far
 * side of the map. Absent means the nearest node however far away it is.
 */
export function nearestNavNode(
  graph: NavGraph,
  x: number,
  y: number,
  z: number,
  maxDistance = Infinity,
): number {
  let best = -1;
  let bestSquared = maxDistance === Infinity ? Infinity : maxDistance * maxDistance;
  for (let i = 0; i < graph.nodeCount; i++) {
    const dx = (graph.positions[i * 3] ?? 0) - x;
    const dy = (graph.positions[i * 3 + 1] ?? 0) - y;
    const dz = (graph.positions[i * 3 + 2] ?? 0) - z;
    const squared = dx * dx + dy * dy + dz * dz;
    /* Strictly nearer, so an exact tie keeps the lower index and two runs agree. */
    if (squared < bestSquared) {
      bestSquared = squared;
      best = i;
    }
  }
  return best;
}

function check(node: number, count: number, which: string): void {
  if (!Number.isInteger(node) || node < 0 || node >= count) {
    throw new Error(`buildNavGraph: edge ${which} is ${node}, which is not a node of ${count}`);
  }
}

function distance(points: Float32Array, a: number, b: number): number {
  const dx = (points[a * 3] ?? 0) - (points[b * 3] ?? 0);
  const dy = (points[a * 3 + 1] ?? 0) - (points[b * 3 + 1] ?? 0);
  const dz = (points[a * 3 + 2] ?? 0) - (points[b * 3 + 2] ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function write(
  edgeStart: Uint32Array,
  cursor: Uint32Array,
  edgeTarget: Uint32Array,
  edgeCost: Float32Array,
  from: number,
  to: number,
  cost: number,
): void {
  const at = (edgeStart[from] ?? 0) + (cursor[from] ?? 0);
  cursor[from] = (cursor[from] ?? 0) + 1;
  edgeTarget[at] = to;
  edgeCost[at] = cost;
}
