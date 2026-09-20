/**
 * The mesh as a graph over **portals**, which is what makes a path the shortest one.
 *
 * **A* over polygon centres optimises a quantity no agent walks.** A polygon path is a corridor and
 * the funnel is optimal inside whatever corridor it is handed — so if the corridor is not the one
 * holding the shortest path, the funnel cannot recover it. Measured on `query.test.ts`'s wall:
 * **10.75 against an ideal 9.81**, for as long as the nodes were centroids.
 *
 * **And a cost on the edge between two polygons cannot fix it**, which is worth knowing before
 * trying: what crossing a polygon costs depends on *which portal the path entered by*, and one
 * number between two polygons cannot carry that. The midpoint-to-midpoint distance across a shared
 * edge is zero, because it is one edge.
 *
 * **So the node is the portal.** An edge joins two portals of the same polygon and costs the
 * distance between their midpoints, which is a distance something walks. The start and the goal are
 * two more nodes, joined to the portals of the polygons holding them. What the search returns is
 * then the portal sequence itself, so the funnel is handed its corridor directly rather than
 * reconstructing it from a polygon path.
 *
 * **And a portal is where two polygons *overlap*, not where they share an edge — which is where the
 * tenth actually went.** `buildPolyMesh` records a neighbour only for edges with the same two
 * vertices, and two regions simplified independently do not agree about where a vertex goes: on the
 * wall map, one polygon's edge from (6,3) to (6,4) is the middle of another's from (6,4) to (6,0),
 * so the two are adjacent on the ground and strangers in the table. The path went the long way
 * round because **the short corridor was not in the graph at all**, which is a different fault from
 * the one the record had — see `docs/IMPROVEMENTS.md`, where the diagnosis was the search.
 *
 * Found by overlap in **exact integer arithmetic**: a mesh's vertices are cell indices, so two
 * edges are on one line when their reduced directions and offsets are equal, and their overlap is
 * an interval with endpoints drawn from their own four vertices. No tolerance is chosen, and none
 * is needed.
 *
 * **What it gives up**: the corridor is optimal *between portal midpoints*, which is still not
 * exactly the continuous shortest path — a route that should cross a portal near one end pays for
 * the midpoint. On the maps here that is under a thousandth; what would make it wrong is a mesh
 * with very long portals, where the fix is to keep the funnel and search over portal *intervals*.
 *
 * **Nothing here allocates per query.** The graph is built once; the start and the goal are written
 * into edge slots reserved for them at build time, which is why `attachStart` and `attachGoal` take
 * a graph and write to it rather than returning one.
 */
import { buildNavGraph } from '@driftengine/core';
import type { NavEdge, NavGraph } from '@driftengine/core';

import { polyNeighbour, polyVertexCount, type PolyMesh } from './polymesh.ts';

export interface PortalGraph {
  /** Nodes: one per portal, then the start, then the goal. */
  readonly graph: NavGraph;
  readonly portalCount: number;
  /** The two polygons each portal joins, near first: 2 per portal. */
  readonly sides: Int32Array;
  /**
   * The portal's two vertices as **each** of its polygons stores them: 4 per portal, near's pair
   * then far's.
   *
   * Both, rather than one pair flipped when the path crosses the other way. The funnel needs the
   * left end and the right end *for the direction of travel*, and which vertex is which depends on
   * the winding of the polygon being left — a mesh whose two polygons do not store a shared edge
   * in opposite orders would silently get the funnel's two sides swapped, which is a legal path and
   * a visibly worse one. Read at build time from both sides, so nothing assumes.
   */
  readonly ends: Int32Array;
  /** Which portals a polygon has: `polyStart[p]` to `polyStart[p + 1]` into `polyPortals`. */
  readonly polyStart: Uint32Array;
  readonly polyPortals: Uint32Array;
  readonly startNode: number;
  readonly goalNode: number;
  /** The edge slot each portal keeps for the goal, and the range the start node's slots occupy. */
  readonly goalSlot: Uint32Array;
  readonly startSlots: Uint32Array;
  /** The polygon whose portals currently point at the goal, or −1. */
  attachedGoal: number;
}

/** One portal: the two polygons, and the overlap's two ends as each of them stores its direction. */
interface Portal {
  readonly near: number;
  readonly far: number;
  readonly nearFrom: number;
  readonly nearTo: number;
  readonly farFrom: number;
  readonly farTo: number;
}

interface Side {
  readonly poly: number;
  /** The edge's own two vertices, in the order its polygon stores them. */
  readonly from: number;
  readonly to: number;
  /** Where each end sits along the line, as an exact integer. */
  readonly fromAt: number;
  readonly toAt: number;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const held = y;
    y = x % y;
    x = held;
  }
  return x === 0 ? 1 : x;
}

/**
 * Every pair of polygon edges that lie on one line and overlap in more than a point.
 *
 * **Bucketed by the line itself**, so this is one pass over the edges and a small comparison inside
 * each bucket rather than every edge against every other. The line's key is its direction reduced
 * by the greatest common divisor, signed one way, and its offset — all integers, because a mesh's
 * vertices are cell indices, so two edges are on one line exactly or not at all.
 */
function overlappingEdges(mesh: PolyMesh): Portal[] {
  const lines = new Map<string, Side[]>();
  for (let poly = 0; poly < mesh.polyCount; poly += 1) {
    const verts = polyVertexCount(mesh, poly);
    for (let edge = 0; edge < verts; edge += 1) {
      const from = mesh.polys[poly * mesh.maxVertsPerPoly + edge] as number;
      const to = mesh.polys[poly * mesh.maxVertsPerPoly + ((edge + 1) % verts)] as number;
      const ax = mesh.vertices[from * 2] as number;
      const az = mesh.vertices[from * 2 + 1] as number;
      const dx = (mesh.vertices[to * 2] as number) - ax;
      const dz = (mesh.vertices[to * 2 + 1] as number) - az;
      if (dx === 0 && dz === 0) continue;
      const divisor = gcd(dx, dz);
      let ux = dx / divisor;
      let uz = dz / divisor;
      /* One sign per line, so an edge and its reverse land in the same bucket. */
      if (ux < 0 || (ux === 0 && uz < 0)) {
        ux = -ux;
        uz = -uz;
      }
      /* The cross of the direction with a point on it: constant along the line, so it names it. */
      const offset = ux * az - uz * ax;
      const key = `${ux},${uz},${offset}`;
      /* Along the line, measured on whichever axis the direction actually moves in. */
      const along = (vertex: number): number =>
        ux !== 0
          ? (mesh.vertices[vertex * 2] as number)
          : (mesh.vertices[vertex * 2 + 1] as number);
      const side: Side = { poly, from, to, fromAt: along(from), toAt: along(to) };
      const held = lines.get(key);
      if (held === undefined) lines.set(key, [side]);
      else held.push(side);
    }
  }

  const out: Portal[] = [];
  for (const sides of lines.values()) {
    for (let i = 0; i < sides.length; i += 1) {
      for (let j = i + 1; j < sides.length; j += 1) {
        const a = sides[i] as Side;
        const b = sides[j] as Side;
        if (a.poly === b.poly) continue;
        const low = Math.max(Math.min(a.fromAt, a.toAt), Math.min(b.fromAt, b.toAt));
        const high = Math.min(Math.max(a.fromAt, a.toAt), Math.max(b.fromAt, b.toAt));
        /* Touching at a point is not a way through, and a zero-length portal breaks the funnel. */
        if (!(high > low)) continue;
        const atLow = (side: Side): number => (side.fromAt === low ? side.from : side.to);
        const atHigh = (side: Side): number => (side.fromAt === high ? side.from : side.to);
        const lowVertex = a.fromAt === low || a.toAt === low ? atLow(a) : atLow(b);
        const highVertex = a.fromAt === high || a.toAt === high ? atHigh(a) : atHigh(b);
        /*
         * Each side names the overlap in **its own** direction of travel: the funnel wants a left
         * end and a right end for the polygon being left, and swapping them is a legal path that
         * bulges away from every corner instead of hugging it.
         */
        const forward = (side: Side): boolean => side.toAt > side.fromAt;
        out.push({
          near: a.poly,
          far: b.poly,
          nearFrom: forward(a) ? lowVertex : highVertex,
          nearTo: forward(a) ? highVertex : lowVertex,
          farFrom: forward(b) ? lowVertex : highVertex,
          farTo: forward(b) ? highVertex : lowVertex,
        });
      }
    }
  }
  return out;
}

/** A portal's midpoint is its graph node's position, and the graph is in metres as a path is. */
export function buildPortalGraph(mesh: PolyMesh): PortalGraph {
  const slots = mesh.maxVertsPerPoly;
  const found = overlappingEdges(mesh);
  const portalCount = found.length;

  const startNode = portalCount;
  const goalNode = portalCount + 1;
  const positions = new Float32Array((portalCount + 2) * 3);
  const sides = new Int32Array(portalCount * 2);
  const ends = new Int32Array(portalCount * 4);
  const degree = new Uint32Array(mesh.polyCount);

  for (let at = 0; at < portalCount; at += 1) {
    const portal = found[at] as Portal;
    sides[at * 2] = portal.near;
    sides[at * 2 + 1] = portal.far;
    ends[at * 4] = portal.nearFrom;
    ends[at * 4 + 1] = portal.nearTo;
    ends[at * 4 + 2] = portal.farFrom;
    ends[at * 4 + 3] = portal.farTo;
    positions[at * 3] = midpoint(mesh, portal.nearFrom, portal.nearTo, 0);
    positions[at * 3 + 2] = midpoint(mesh, portal.nearFrom, portal.nearTo, 1);
    degree[portal.near] = (degree[portal.near] as number) + 1;
    degree[portal.far] = (degree[portal.far] as number) + 1;
  }

  /* Which portals each polygon has, as a CSR the attach step walks. */
  const polyStart = new Uint32Array(mesh.polyCount + 1);
  for (let poly = 0; poly < mesh.polyCount; poly += 1) {
    polyStart[poly + 1] = (polyStart[poly] as number) + (degree[poly] as number);
  }
  const cursor = Uint32Array.from(polyStart.subarray(0, mesh.polyCount));
  const polyPortals = new Uint32Array(polyStart[mesh.polyCount] as number);
  for (let portal = 0; portal < portalCount; portal += 1) {
    for (let side = 0; side < 2; side += 1) {
      const poly = sides[portal * 2 + side] as number;
      polyPortals[cursor[poly] as number] = portal;
      cursor[poly] = (cursor[poly] as number) + 1;
    }
  }

  /*
   * An edge between every two portals of one polygon, both ways. `buildNavGraph` costs an edge at
   * the distance between its ends, which here is midpoint to midpoint — a distance something
   * walks, and the straight line A*'s heuristic needs it never to undercut.
   */
  const edges: NavEdge[] = [];
  for (let poly = 0; poly < mesh.polyCount; poly += 1) {
    const from = polyStart[poly] as number;
    const to = polyStart[poly + 1] as number;
    for (let i = from; i < to; i += 1) {
      for (let j = from; j < to; j += 1) {
        if (i !== j) {
          edges.push({ from: polyPortals[i] as number, to: polyPortals[j] as number });
        }
      }
    }
  }

  /*
   * **A slot per portal for the goal, and `maxVertsPerPoly` for the start**, written as self-loops
   * and rewritten per query. A self-loop is inert in a search with no negative costs — reaching a
   * node from itself can never improve what it already cost to get there — so a slot nobody is
   * using is a slot that does nothing, rather than a route with a large number on it that a
   * "no path" query would return as a path.
   */
  for (let portal = 0; portal < portalCount; portal += 1) edges.push({ from: portal, to: portal });
  for (let slot = 0; slot < slots; slot += 1) edges.push({ from: startNode, to: startNode });

  const graph = buildNavGraph(positions, edges);
  const goalSlot = new Uint32Array(portalCount);
  for (let portal = 0; portal < portalCount; portal += 1) {
    goalSlot[portal] = selfLoopOf(graph, portal);
  }
  const startSlots = new Uint32Array(slots);
  for (let slot = 0; slot < slots; slot += 1) {
    startSlots[slot] = (graph.edgeStart[startNode] as number) + slot;
  }

  return {
    graph,
    portalCount,
    sides,
    ends,
    polyStart,
    polyPortals,
    startNode,
    goalNode,
    goalSlot,
    startSlots,
    attachedGoal: -1,
  };
}

/**
 * Where the reserved slot landed, found rather than computed.
 *
 * `buildNavGraph` groups edges by their `from`, and the order inside a group is the order they were
 * given in — so the reserved one is last. Searching for it instead costs one pass at build time and
 * keeps this file from depending on that.
 */
function selfLoopOf(graph: NavGraph, node: number): number {
  for (
    let edge = graph.edgeStart[node] as number;
    edge < (graph.edgeStart[node + 1] as number);
    edge += 1
  ) {
    if ((graph.edgeTarget[edge] as number) === node) return edge;
  }
  throw new Error(`nav: node ${node} has no reserved slot`);
}

function midpoint(mesh: PolyMesh, a: number, b: number, axis: number): number {
  const origin = axis === 0 ? mesh.originX : mesh.originZ;
  const first = mesh.vertices[a * 2 + axis] as number;
  const second = mesh.vertices[b * 2 + axis] as number;
  return origin + ((first + second) / 2) * mesh.cellSize;
}

/** Point the start node at the portals of the polygon holding it. */
export function attachStart(portals: PortalGraph, poly: number, x: number, z: number): void {
  const { graph, startNode } = portals;
  graph.positions[startNode * 3] = x;
  graph.positions[startNode * 3 + 1] = 0;
  graph.positions[startNode * 3 + 2] = z;

  const from = portals.polyStart[poly] as number;
  const to = portals.polyStart[poly + 1] as number;
  for (let slot = 0; slot < portals.startSlots.length; slot += 1) {
    const edge = portals.startSlots[slot] as number;
    const held = from + slot < to ? (portals.polyPortals[from + slot] as number) : -1;
    graph.edgeTarget[edge] = held < 0 ? startNode : held;
    graph.edgeCost[edge] = held < 0 ? 0 : reach(graph, held, x, z);
  }
}

/** Point the portals of the goal's polygon at the goal node, and let the previous ones go. */
export function attachGoal(portals: PortalGraph, poly: number, x: number, z: number): void {
  const { graph, goalNode } = portals;
  graph.positions[goalNode * 3] = x;
  graph.positions[goalNode * 3 + 1] = 0;
  graph.positions[goalNode * 3 + 2] = z;

  const previous = portals.attachedGoal;
  if (previous >= 0) {
    for (
      let at = portals.polyStart[previous] as number;
      at < (portals.polyStart[previous + 1] as number);
      at += 1
    ) {
      const portal = portals.polyPortals[at] as number;
      const edge = portals.goalSlot[portal] as number;
      graph.edgeTarget[edge] = portal;
      graph.edgeCost[edge] = 0;
    }
  }
  for (
    let at = portals.polyStart[poly] as number;
    at < (portals.polyStart[poly + 1] as number);
    at += 1
  ) {
    const portal = portals.polyPortals[at] as number;
    const edge = portals.goalSlot[portal] as number;
    graph.edgeTarget[edge] = goalNode;
    graph.edgeCost[edge] = reach(graph, portal, x, z);
  }
  portals.attachedGoal = poly;
}

function reach(graph: NavGraph, portal: number, x: number, z: number): number {
  const dx = (graph.positions[portal * 3] as number) - x;
  const dz = (graph.positions[portal * 3 + 2] as number) - z;
  return Math.sqrt(dx * dx + dz * dz);
}
