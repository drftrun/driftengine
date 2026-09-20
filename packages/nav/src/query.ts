/**
 * Search and funnel, on the search that already ships.
 *
 * **`NavSearch` in `@driftengine/core` is reused rather than reimplemented.** It is A* over a CSR
 * graph, allocation-free, and tested; what it needs is a graph, and a polygon mesh is one — nodes
 * are polygons, edges are the adjacency the mesh already records. So this package supplies a
 * different graph to the same search rather than carrying a second one, and there is exactly one
 * A* in this repository.
 *
 * **The funnel is what makes a path a straight line.** A polygon path is a corridor, and walking
 * its centres is the defect that makes agents zigzag across open ground — visibly, and in a way
 * that reads as bad AI rather than as a missing algorithm. The funnel pulls a string through the
 * portals between consecutive polygons and the result is the shortest path inside the corridor,
 * which across an empty room is one segment.
 *
 * **And the corridor is chosen over portals rather than over polygon centres**, which is what makes
 * it the corridor holding the shortest path rather than one near it — `portalGraph.ts` carries that
 * argument and the measurement that opened it. The search hands back the portals themselves, so
 * nothing here reconstructs them from a polygon path any more.
 *
 * **Nothing here allocates.** A query runs inside a frame, possibly once per agent, and
 * `navSearch.ts` already holds that line; a funnel that allocated would give it back.
 */
import { NavSearch } from '@driftengine/core';

import { polyVertexCount, type PolyMesh } from './polymesh.ts';
import { attachGoal, attachStart, buildPortalGraph, type PortalGraph } from './portalGraph.ts';

/** Twice the signed area of the triangle, which is the sign of the turn and nothing more. */
function turn(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
}

/** A polygon's centre, which is what its graph node sits at. */
function centreOf(mesh: PolyMesh, poly: number, out: Float64Array): void {
  const count = polyVertexCount(mesh, poly);
  let x = 0;
  let z = 0;
  for (let at = 0; at < count; at += 1) {
    const vertex = mesh.polys[poly * mesh.maxVertsPerPoly + at] as number;
    x += mesh.vertices[vertex * 2] as number;
    z += mesh.vertices[vertex * 2 + 1] as number;
  }
  out[0] = count === 0 ? 0 : x / count;
  out[1] = count === 0 ? 0 : z / count;
}

/** Whether a point is inside a polygon, edges included. */
function insidePoly(mesh: PolyMesh, poly: number, x: number, z: number): boolean {
  const count = polyVertexCount(mesh, poly);
  if (count < 3) return false;
  let negative = false;
  let positive = false;
  for (let at = 0; at < count; at += 1) {
    const a = mesh.polys[poly * mesh.maxVertsPerPoly + at] as number;
    const b = mesh.polys[poly * mesh.maxVertsPerPoly + ((at + 1) % count)] as number;
    const side = turn(
      mesh.vertices[a * 2] as number,
      mesh.vertices[a * 2 + 1] as number,
      mesh.vertices[b * 2] as number,
      mesh.vertices[b * 2 + 1] as number,
      x,
      z,
    );
    if (side < 0) negative = true;
    if (side > 0) positive = true;
  }
  return !(negative && positive);
}

/** Distance from a point to a polygon, zero inside it. */
function distanceToPoly(mesh: PolyMesh, poly: number, x: number, z: number): number {
  if (insidePoly(mesh, poly, x, z)) return 0;
  const count = polyVertexCount(mesh, poly);
  let best = Infinity;
  for (let at = 0; at < count; at += 1) {
    const a = mesh.polys[poly * mesh.maxVertsPerPoly + at] as number;
    const b = mesh.polys[poly * mesh.maxVertsPerPoly + ((at + 1) % count)] as number;
    const ax = mesh.vertices[a * 2] as number;
    const az = mesh.vertices[a * 2 + 1] as number;
    const dx = (mesh.vertices[b * 2] as number) - ax;
    const dz = (mesh.vertices[b * 2 + 1] as number) - az;
    const lengthSq = dx * dx + dz * dz;
    let t = lengthSq === 0 ? 0 : ((x - ax) * dx + (z - az) * dz) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const px = x - (ax + t * dx);
    const pz = z - (az + t * dz);
    best = Math.min(best, Math.sqrt(px * px + pz * pz));
  }
  return best;
}

/**
 * The polygon a point is in, or the nearest within `extent`. `-1` beyond it. The point and the
 * extent are in metres, which the mesh's placement turns into its cells.
 *
 * **`-1` rather than the nearest whatever the distance**, because an agent asked to walk to a
 * place that is not on the mesh has to be told. Snapping across the map produces a path to
 * somewhere nobody asked for, which is worse than no path at all.
 */
export function nearestPoly(mesh: PolyMesh, x: number, z: number, extent: number): number {
  const cellX = (x - mesh.originX) / mesh.cellSize;
  const cellZ = (z - mesh.originZ) / mesh.cellSize;
  const reach = extent / mesh.cellSize;
  let best = -1;
  let bestDistance = Infinity;
  for (let poly = 0; poly < mesh.polyCount; poly += 1) {
    const distance = distanceToPoly(mesh, poly, cellX, cellZ);
    if (distance > reach || distance >= bestDistance) continue;
    best = poly;
    bestDistance = distance;
  }
  return best;
}

/**
 * A query, holding everything a search needs so that running one allocates nothing.
 *
 * One per agent, or one shared by a caller that queries serially. The scratch is sized by the mesh
 * because a polygon path cannot be longer than the mesh has polygons.
 */
export class NavMeshQuery {
  readonly mesh: PolyMesh;
  readonly portals: PortalGraph;
  private readonly search: NavSearch;
  /** The nodes a search returns: the start, the portals it crosses, then the goal. */
  private readonly nodePath: Uint32Array;
  /** Portal ends, two points per portal: left x, left z, right x, right z. */
  private readonly corridor: Float64Array;
  private readonly centre = new Float64Array(2);

  constructor(mesh: PolyMesh) {
    this.mesh = mesh;
    this.portals = buildPortalGraph(mesh);
    this.search = new NavSearch(this.portals.graph);
    this.nodePath = new Uint32Array(this.portals.portalCount + 2);
    this.corridor = new Float64Array((this.portals.portalCount + 1) * 4);
  }

  /**
   * The polygons from `from` to `to`, written into `out`. Zero where there is no route.
   *
   * Asked between the two polygons' centres, because a polygon is a region and a search over
   * portals needs a point. What comes back is the corridor a path between those two points would
   * be funnelled through, which is what a caller asking this question wants.
   */
  findPolyPath(from: number, to: number, out: Uint32Array): number {
    if (from < 0 || to < 0 || from >= this.mesh.polyCount || to >= this.mesh.polyCount) return 0;
    if (from === to) {
      if (out.length < 1) return 0;
      out[0] = from;
      return 1;
    }
    centreOf(this.mesh, from, this.centre);
    const fromX = this.mesh.originX + (this.centre[0] as number) * this.mesh.cellSize;
    const fromZ = this.mesh.originZ + (this.centre[1] as number) * this.mesh.cellSize;
    centreOf(this.mesh, to, this.centre);
    const toX = this.mesh.originX + (this.centre[0] as number) * this.mesh.cellSize;
    const toZ = this.mesh.originZ + (this.centre[1] as number) * this.mesh.cellSize;

    const crossed = this.search_(from, fromX, fromZ, to, toX, toZ);
    if (crossed < 0) return 0;
    return this.walkPolygons(from, crossed, out);
  }

  /**
   * A path from one point to another, as world positions in `out`, x and z per step.
   *
   * Returns how many points were written, or zero for no route — which is a real answer, not an
   * error: a mesh with two components is a world with a gap in it, and an agent that asks for the
   * other side has to be told rather than thrown at inside a frame.
   */
  findPath(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    extent: number,
    out: Float64Array,
  ): number {
    const startPoly = nearestPoly(this.mesh, fromX, fromZ, extent);
    const endPoly = nearestPoly(this.mesh, toX, toZ, extent);
    if (startPoly < 0 || endPoly < 0) return 0;
    if (startPoly === endPoly) {
      if (out.length < 4) return 0;
      out[0] = fromX;
      out[1] = fromZ;
      out[2] = toX;
      out[3] = toZ;
      return 2;
    }

    const crossed = this.search_(startPoly, fromX, fromZ, endPoly, toX, toZ);
    if (crossed < 0) return 0;
    if (crossed === 0) {
      /* Two polygons the search joined with no portal between them cannot happen; say so rather
         than returning a straight line through whatever is in the way. */
      return 0;
    }
    this.fillCorridor(startPoly, crossed);
    return funnel(this.corridor, crossed, fromX, fromZ, toX, toZ, out);
  }

  /** The search itself: how many portals the path crosses, or −1 for no route. */
  private search_(
    startPoly: number,
    fromX: number,
    fromZ: number,
    endPoly: number,
    toX: number,
    toZ: number,
  ): number {
    attachStart(this.portals, startPoly, fromX, fromZ);
    attachGoal(this.portals, endPoly, toX, toZ);
    const count = this.search.find(this.portals.startNode, this.portals.goalNode, this.nodePath);
    /* The start and the goal are nodes too, so a route of N portals comes back as N + 2. */
    return count === 0 ? -1 : count - 2;
  }

  /**
   * The portals the path crosses, as the funnel wants them: a left end and a right end **for the
   * direction of travel**, in metres.
   *
   * Swapping the two is a legal path and a visibly worse one — the funnel tightens the wrong way
   * and bulges away from every corner instead of hugging it. Measured on three maps rather than
   * reasoned about, because the convention depends on the winding, on which way `z` runs and on the
   * order `buildPolyMesh` emits an edge in: 10.75 against 18.30 on a wall, 8.75 against 12.65 on a
   * corner, 8.60 against 24.70 on a zigzag.
   */
  private fillCorridor(startPoly: number, crossed: number): void {
    const { originX, originZ, cellSize, vertices } = this.mesh;
    let current = startPoly;
    for (let at = 0; at < crossed; at += 1) {
      const portal = this.nodePath[at + 1] as number;
      const near = this.portals.sides[portal * 2] as number;
      const leaving = current === near ? 0 : 2;
      const a = this.portals.ends[portal * 4 + leaving] as number;
      const b = this.portals.ends[portal * 4 + leaving + 1] as number;
      this.corridor[at * 4] = originX + (vertices[a * 2] as number) * cellSize;
      this.corridor[at * 4 + 1] = originZ + (vertices[a * 2 + 1] as number) * cellSize;
      this.corridor[at * 4 + 2] = originX + (vertices[b * 2] as number) * cellSize;
      this.corridor[at * 4 + 3] = originZ + (vertices[b * 2 + 1] as number) * cellSize;
      current = current === near ? (this.portals.sides[portal * 2 + 1] as number) : near;
    }
  }

  /** The polygons a portal path passes through, which is the corridor named the other way. */
  private walkPolygons(startPoly: number, crossed: number, out: Uint32Array): number {
    if (out.length < crossed + 1) return 0;
    let current = startPoly;
    out[0] = current;
    for (let at = 0; at < crossed; at += 1) {
      const portal = this.nodePath[at + 1] as number;
      const near = this.portals.sides[portal * 2] as number;
      current = current === near ? (this.portals.sides[portal * 2 + 1] as number) : near;
      out[at + 1] = current;
    }
    return crossed + 1;
  }
}

/**
 * Pull a string through the portals: the shortest path inside the corridor.
 *
 * The funnel narrows as each portal end tightens it and, when the two sides cross, the apex moves
 * to whichever side caused the crossing and a corner is emitted. Across an empty room no portal
 * ever crosses, so the whole path is two points — which is the property that stops agents
 * zigzagging.
 */
function funnel(
  portals: Float64Array,
  portalCount: number,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  out: Float64Array,
): number {
  /*
   * Written open rather than through a closure, and that is not style. A closure is an allocation,
   * and this runs once per agent per re-path — two thousand queries with one in them cost half a
   * megabyte, which the allocation test measured before this was changed.
   */
  let written = 0;
  if (out.length < 2) return 0;
  out[0] = fromX;
  out[1] = fromZ;
  written = 1;

  let apexX = fromX;
  let apexZ = fromZ;
  let leftX = fromX;
  let leftZ = fromZ;
  let rightX = fromX;
  let rightZ = fromZ;
  let leftAt = 0;
  let rightAt = 0;

  for (let at = 0; at <= portalCount; at += 1) {
    const px = at < portalCount ? (portals[at * 4] as number) : toX;
    const pz = at < portalCount ? (portals[at * 4 + 1] as number) : toZ;
    const qx = at < portalCount ? (portals[at * 4 + 2] as number) : toX;
    const qz = at < portalCount ? (portals[at * 4 + 3] as number) : toZ;

    if (turn(apexX, apexZ, rightX, rightZ, qx, qz) <= 0) {
      if (apexX === rightX && apexZ === rightZ) {
        rightX = qx;
        rightZ = qz;
        rightAt = at;
      } else if (turn(apexX, apexZ, leftX, leftZ, qx, qz) > 0) {
        rightX = qx;
        rightZ = qz;
        rightAt = at;
      } else {
        /* The right side crossed the left: the left vertex is a corner of the path. */
        if (written * 2 + 1 >= out.length) return written;
        if (out[(written - 1) * 2] !== leftX || out[(written - 1) * 2 + 1] !== leftZ) {
          out[written * 2] = leftX;
          out[written * 2 + 1] = leftZ;
          written += 1;
        }
        apexX = leftX;
        apexZ = leftZ;
        rightX = apexX;
        rightZ = apexZ;
        rightAt = leftAt;
        at = leftAt;
        continue;
      }
    }

    if (turn(apexX, apexZ, leftX, leftZ, px, pz) >= 0) {
      if (apexX === leftX && apexZ === leftZ) {
        leftX = px;
        leftZ = pz;
        leftAt = at;
      } else if (turn(apexX, apexZ, rightX, rightZ, px, pz) < 0) {
        leftX = px;
        leftZ = pz;
        leftAt = at;
      } else {
        if (written * 2 + 1 >= out.length) return written;
        if (out[(written - 1) * 2] !== rightX || out[(written - 1) * 2 + 1] !== rightZ) {
          out[written * 2] = rightX;
          out[written * 2 + 1] = rightZ;
          written += 1;
        }
        apexX = rightX;
        apexZ = rightZ;
        leftX = apexX;
        leftZ = apexZ;
        leftAt = rightAt;
        at = rightAt;
        continue;
      }
    }
  }

  /* A corner emitted twice is a step of zero length, which a follower would stall on. */
  if (
    written * 2 + 1 < out.length &&
    (out[(written - 1) * 2] !== toX || out[(written - 1) * 2 + 1] !== toZ)
  ) {
    out[written * 2] = toX;
    out[written * 2 + 1] = toZ;
    written += 1;
  }
  return written;
}
