import { describe, expect, it } from 'vitest';
import { buildContours } from './contour.ts';
import { buildRegions } from './regions.ts';
import { buildPolyMesh, type PolyMesh } from './polymesh.ts';
import { NavMeshQuery, nearestPoly } from './query.ts';
import { buildPortalGraph } from './portalGraph.ts';
import { fieldFromMap } from './testField.ts';
import { voxeliseWalkable } from './voxelise.ts';

function meshOf(rows: readonly string[], maxVerts = 6): PolyMesh {
  const field = fieldFromMap(rows);
  const regions = buildRegions(field, { minRegionSpans: 1, maxStep: 1 });
  return buildPolyMesh(buildContours(field, regions, 0.5), maxVerts, field);
}

const OPEN = ['..........', '..........', '..........', '..........', '..........', '..........'];

function points(out: Float64Array, count: number): number[][] {
  const result: number[][] = [];
  for (let at = 0; at < count; at += 1)
    result.push([out[at * 2] as number, out[at * 2 + 1] as number]);
  return result;
}

describe('the graph a mesh makes', () => {
  it('HAS A NODE PER PORTAL, AND THE START AND THE GOAL', () => {
    /*
     * **A node per shared border rather than per polygon**, because what a path costs is the
     * distance between the portals it crosses and centroid-to-centroid is not that — see
     * `portalGraph.ts`. Two nodes over the portal count: the start and the goal, which move per
     * query into slots reserved for them here.
     */
    const mesh = meshOf(OPEN);
    const portals = buildPortalGraph(mesh);
    let borders = 0;
    for (let poly = 0; poly < mesh.polyCount; poly += 1) {
      for (let edge = 0; edge < mesh.maxVertsPerPoly; edge += 1) {
        if ((mesh.neighbours[poly * mesh.maxVertsPerPoly + edge] as number) >= 0) borders += 1;
      }
    }
    expect(borders % 2, 'borders come in pairs').toBe(0);
    expect(portals.portalCount).toBe(borders / 2);
    expect(portals.graph.nodeCount).toBe(portals.portalCount + 2);
    expect(portals.startNode).toBe(portals.portalCount);
    expect(portals.goalNode).toBe(portals.portalCount + 1);
  });
});

describe('finding where a point is', () => {
  it('finds the polygon a point is inside', () => {
    const mesh = meshOf(OPEN);
    expect(nearestPoly(mesh, 5, 3, 0.1)).toBeGreaterThanOrEqual(0);
  });

  it('snaps a point just off the mesh to the nearest polygon', () => {
    const mesh = meshOf(OPEN);
    expect(nearestPoly(mesh, -0.5, 3, 1)).toBeGreaterThanOrEqual(0);
  });

  /** Snapping across the map produces a path to somewhere nobody asked for. */
  it('reports nothing beyond the extent rather than snapping across the map', () => {
    const mesh = meshOf(OPEN);
    expect(nearestPoly(mesh, -50, 3, 1)).toBe(-1);
  });
});

/**
 * **A path across open ground is one straight line, and walking polygon centres is the defect.**
 * An agent that zigzags across an empty room reads as bad AI and is a missing algorithm: the
 * polygon path is a corridor, and the funnel is what pulls a string through it.
 */
describe('a path across open ground', () => {
  it('is a straight line and not a walk along centres', () => {
    const query = new NavMeshQuery(meshOf(OPEN));
    const out = new Float64Array(64);
    const count = query.findPath(0.5, 0.5, 9.5, 5.5, 1, out);

    expect(count, 'start and end, nothing between').toBe(2);
    expect(points(out, count)).toEqual([
      [0.5, 0.5],
      [9.5, 5.5],
    ]);
  });

  it('is the same line whichever way it is walked', () => {
    const query = new NavMeshQuery(meshOf(OPEN));
    const there = new Float64Array(64);
    const back = new Float64Array(64);
    const a = query.findPath(0.5, 0.5, 9.5, 5.5, 1, there);
    const b = query.findPath(9.5, 5.5, 0.5, 0.5, 1, back);

    expect(a).toBe(b);
    expect(points(there, a)).toEqual(points(back, b).reverse());
  });
});

describe('a path around an obstacle', () => {
  /* A wall growing down from the top edge, so the walkable space is a U and not a ring. */
  const WALL = ['....##....', '....##....', '....##....', '..........', '..........'];

  /**
   * **A corner is a mesh vertex and the path is near the ideal, which is what hugging means here.**
   * Not "exactly the wall's two bottom corners": the watershed splits this U in two and puts a
   * portal corner at (6, 4), one cell below the wall's foot, so the funnel's shortest path through
   * the corridor A* chose is 10.75 against an ideal 9.81. The corridor is what costs the 10%, not
   * the funnel — see the length bound below, which is the honest claim and would catch a funnel
   * that had stopped working.
   */
  it('goes round, and every corner it turns is a corner of the mesh', () => {
    const mesh = meshOf(WALL);
    const query = new NavMeshQuery(mesh);
    const out = new Float64Array(64);
    const count = query.findPath(1, 0.5, 9, 0.5, 1, out);

    expect(count, 'a corner or two, not a straight line through the wall').toBeGreaterThan(2);
    const vertices = new Set<string>();
    for (let at = 0; at < mesh.vertexCount; at += 1) {
      vertices.add(`${mesh.vertices[at * 2]},${mesh.vertices[at * 2 + 1]}`);
    }
    for (const [x, z] of points(out, count).slice(1, -1)) {
      expect(vertices.has(`${x},${z}`), `corner at ${x},${z} is not a mesh vertex`).toBe(true);
    }
  });

  it('is close to the shortest way round', () => {
    const query = new NavMeshQuery(meshOf(WALL));
    const out = new Float64Array(64);
    const count = query.findPath(1, 0.5, 9, 0.5, 1, out);

    let length = 0;
    const path = points(out, count);
    for (let at = 0; at + 1 < path.length; at += 1) {
      const [ax, az] = path[at] as number[];
      const [bx, bz] = path[at + 1] as number[];
      length += Math.sqrt(
        ((bx as number) - (ax as number)) ** 2 + ((bz as number) - (az as number)) ** 2,
      );
    }

    /* Straight to (4, 3), along the wall's foot to (6, 3), straight out: 9.81. */
    const ideal = Math.sqrt(3 ** 2 + 2.5 ** 2) * 2 + 2;
    expect(length).toBeGreaterThan(ideal - 1e-6);
    /*
     * **The ideal itself, not a tenth over it**, and the difference is what the search is over.
     * A* over polygon *centres* optimises a quantity no agent walks, so the corridor it hands the
     * funnel is not always the one holding the shortest path — this returned 10.75 for as long as
     * that was true. Over portals, the cost of the route is the route, and the funnel inside the
     * corridor A* now picks is the shortest way round.
     */
    expect(length, 'the shortest way round, not a corridor near it').toBeCloseTo(ideal, 6);
  });

  it('never crosses the obstacle', () => {
    const query = new NavMeshQuery(meshOf(WALL));
    const out = new Float64Array(64);
    const count = query.findPath(1, 0.5, 9, 0.5, 1, out);
    const path = points(out, count);

    for (let at = 0; at + 1 < path.length; at += 1) {
      const [ax, az] = path[at] as number[];
      const [bx, bz] = path[at + 1] as number[];
      for (let t = 0; t <= 1; t += 0.02) {
        const x = (ax as number) + ((bx as number) - (ax as number)) * t;
        const z = (az as number) + ((bz as number) - (az as number)) * t;
        const inside = x > 4.02 && x < 5.98 && z >= 0 && z < 2.98;
        expect(inside, `the path passes through ${x.toFixed(2)},${z.toFixed(2)}`).toBe(false);
      }
    }
  });

  /**
   * **A free-standing pillar is a hole, and the mesh has holes as of 2026-09-16.** This test used to
   * pin the opposite — `buildContours` took the outer loop of a region and dropped any inner one, so
   * an agent walked through a column in the middle of a room.
   *
   * The limitation was worse than it was written down as. A ring's outer loop is the *room's* whole
   * perimeter, so simplifying it gave a rectangle covering the pillar and whatever else the
   * watershed had carved out of the middle: on this map the ring's polygon came out as the entire
   * ten-by-four field, area 40 where the region is 32. The mesh was not merely missing a pillar, it
   * was asserting that a wall and a neighbouring region were both walkable by the same agent.
   *
   * Holes are bridged into the outer loop now. What is left of the limitation is narrow and named
   * in `contour.ts`: a region that is *pinched* as well as holed already visits a corner twice
   * before anything is spliced into it, and those keep the old behaviour rather than a tangle.
   */
  it('WALKS ROUND A FREE-STANDING PILLAR, which the mesh models as a hole', () => {
    const PILLAR = ['..........', '....##....', '....##....', '..........'];
    const query = new NavMeshQuery(meshOf(PILLAR));
    const out = new Float64Array(64);
    const count = query.findPath(1, 1.5, 9, 1.5, 1, out);

    expect(count, 'a corner or two, not a straight line through the column').toBeGreaterThan(2);

    /* And no part of it passes through the pillar, which spans x 4..6 and z 1..3. */
    const path = points(out, count);
    for (let at = 0; at + 1 < path.length; at += 1) {
      const [ax, az] = path[at] as number[];
      const [bx, bz] = path[at + 1] as number[];
      for (let step = 0; step <= 40; step += 1) {
        const t = step / 40;
        const x = (ax as number) + ((bx as number) - (ax as number)) * t;
        const z = (az as number) + ((bz as number) - (az as number)) * t;
        const inside = x > 4.02 && x < 5.98 && z > 1.02 && z < 2.98;
        expect(inside, `the path passes through ${x.toFixed(2)},${z.toFixed(2)}`).toBe(false);
      }
    }
  });
});

describe('a destination that cannot be reached', () => {
  it('reports failure rather than a partial path presented as complete', () => {
    const query = new NavMeshQuery(meshOf(['....#....', '....#....', '....#....']));
    const out = new Float64Array(64);
    expect(query.findPath(1, 1, 7, 1, 1, out)).toBe(0);
  });

  it('reports failure for a destination that is not on the mesh at all', () => {
    const query = new NavMeshQuery(meshOf(OPEN));
    expect(query.findPath(1, 1, 500, 500, 1, new Float64Array(64))).toBe(0);
  });

  it('writes a short path rather than overrunning the caller’s array', () => {
    const query = new NavMeshQuery(meshOf(OPEN));
    const tiny = new Float64Array(2);
    expect(query.findPath(1, 1, 9, 5, 1, tiny)).toBeLessThanOrEqual(1);
  });
});

/**
 * **Two peers in a rollback session have to agree**, so the same question must give the same answer
 * every time — not merely a correct one.
 */
describe('determinism and allocation', () => {
  it('gives the same path every time', () => {
    const query = new NavMeshQuery(
      meshOf(['..........', '....##....', '....##....', '..........']),
    );
    const first = new Float64Array(64);
    const count = query.findPath(1, 0.5, 9, 3.5, 1, first);

    for (let again = 0; again < 20; again += 1) {
      const out = new Float64Array(64);
      expect(query.findPath(1, 0.5, 9, 3.5, 1, out)).toBe(count);
      expect(points(out, count)).toEqual(points(first, count));
    }
  });

  /**
   * **Measured as growth against query count and not as an absolute**, because the absolute is
   * mostly the compiler. The first version of this ran two thousand queries and saw 466 kB, which
   * looked exactly like an allocation per query; two hundred thousand saw 10 kB. What it had
   * measured was warm-up. Ten times the work allocating no more than the smaller run is the claim
   * that actually means "nothing per query".
   */
  it('allocates no more for a hundred times the queries', () => {
    /* Through `globalThis` rather than by naming `process`: this repo has no node types, and
       `core/src/input/input.test.ts` reaches the same object the same way for the same reason. */
    const heap = (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } })
      .process;
    const query = new NavMeshQuery(meshOf(OPEN));
    const out = new Float64Array(64);
    for (let at = 0; at < 5_000; at += 1) query.findPath(1, 1, 9, 5, 1, out);

    /*
     * **The least of three rounds, because a heap figure in a test runner is not only this code's.**
     * Everything else in the worker allocates while the window is open and a collection may or may
     * not land inside it, so a single delta is a measurement of the runner as much as of the query
     * — it read under a kilobyte on most runs and megabytes on about one in six. Only noise adds,
     * so the smallest round is the one closest to the truth. Measured directly, outside the runner:
     * **16,472 bytes over 200,000 queries on the open map and 33,216 on the wall**, which is a
     * fifth of a byte each and is the arrays growing once rather than anything per query.
     */
    let grew = Infinity;
    for (let round = 0; round < 3; round += 1) {
      const before = heap.memoryUsage().heapUsed;
      for (let at = 0; at < 200_000; at += 1) query.findPath(1, 1, 9, 5, 1, out);
      grew = Math.min(grew, heap.memoryUsage().heapUsed - before);
    }

    /* Two hundred thousand queries allocating one small object each would be megabytes. */
    expect(grew).toBeLessThan(1_000_000);
  });
});

/**
 * **A mesh built from real geometry is queried in the world's units, and answers in them.**
 *
 * The field records where it stands — an origin at the geometry's corner and a cell size — and the
 * polygon mesh kept its vertices in cell units and dropped both. So a query given world positions
 * compared them against cell indices and a path came back as the caller's own endpoints strung
 * between corners in cell units. Every test here built its field from a picture at the origin with
 * one-unit cells, where the two units are the same number, so none of them could tell.
 *
 * An L of floor well away from the origin with half-metre cells: the path from one arm to the other
 * has to turn inside the L, and every point of it has to stand on the floor, in metres.
 */
describe('a mesh built away from the origin', () => {
  const quad = (x0: number, z0: number, x1: number, z1: number, base: number) => ({
    positions: [x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1],
    indices: [base, base + 2, base + 1, base, base + 3, base + 2],
  });
  const floor = (() => {
    const a = quad(100, 100, 110, 104, 0);
    const b = quad(106, 104, 110, 110, 4);
    return {
      positions: new Float32Array([...a.positions, ...b.positions]),
      indices: new Uint32Array([...a.indices, ...b.indices]),
    };
  })();
  const onFloor = (x: number, z: number): boolean =>
    (x >= 99.99 && x <= 110.01 && z >= 99.99 && z <= 104.01) ||
    (x >= 105.99 && x <= 110.01 && z >= 103.99 && z <= 110.01);

  const settings = { cellSize: 0.5, cellHeight: 0.2, maxSlope: 45, agentHeight: 2, agentRadius: 0 };
  const field = voxeliseWalkable(floor, settings);
  const regions = buildRegions(field, { minRegionSpans: 1, maxStep: 1 });
  const mesh = buildPolyMesh(buildContours(field, regions, 0.25), 6, field);

  it('FINDS THE POLYGON UNDER A POINT GIVEN IN METRES', () => {
    expect(nearestPoly(mesh, 102, 102, 0.1)).toBeGreaterThanOrEqual(0);
    expect(nearestPoly(mesh, 108, 108, 0.1)).toBeGreaterThanOrEqual(0);
    /* And not under one off the L, in its missing corner. */
    expect(nearestPoly(mesh, 102, 108, 0.1)).toBe(-1);
  });

  it('READS AN EXTENT IN METRES: 0.4 m off the edge is within half a metre and not within 0.3', () => {
    /* 0.8 of a cell. Read as cells, the half-metre reach would be 0.5 of one and miss it. */
    expect(nearestPoly(mesh, 99.6, 102, 0.5)).toBeGreaterThanOrEqual(0);
    expect(nearestPoly(mesh, 99.6, 102, 0.3)).toBe(-1);
  });

  it('ANSWERS A PATH IN METRES, EVERY POINT ON THE FLOOR, TURNING INSIDE THE L', () => {
    const query = new NavMeshQuery(mesh);
    const out = new Float64Array(64);
    const count = query.findPath(101, 102, 108, 109, 0.5, out);
    expect(count).toBeGreaterThanOrEqual(3);
    const path = points(out, count);
    expect(path[0]).toEqual([101, 102]);
    expect(path[count - 1]).toEqual([108, 109]);
    for (const [x, z] of path) expect(onFloor(x as number, z as number), `${x},${z}`).toBe(true);
    /* The turn: somewhere between, a corner inside the L's elbow, not a cut across its gap. */
    const turn = path.slice(1, -1);
    expect(turn.some(([x, z]) => (x as number) >= 105.99 && (z as number) <= 104.01)).toBe(true);
  });
});
