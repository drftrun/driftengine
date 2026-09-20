import { expect, test } from 'vitest';

import type { PolyMesh } from './polymesh.ts';
import { attachGoal, attachStart, buildPortalGraph } from './portalGraph.ts';
import { NavMeshQuery } from './query.ts';

/**
 * **A portal is where two polygons overlap, not where they share an edge.**
 *
 * The meshes here are written out rather than built from a map, because what is under test is the
 * one case a builder will not produce on demand: two polygons that are adjacent on the ground and
 * strangers in the adjacency table. `buildPolyMesh` records a neighbour only for edges with the
 * same two vertices, and two regions simplified apart from each other do not agree where a vertex
 * goes — which is the whole of the tenth that nav paths used to be long.
 */

/** A mesh from loops of `[x, z]` corners, with no adjacency recorded at all. */
function meshOf(loops: readonly (readonly (readonly [number, number])[])[]): PolyMesh {
  const slots = Math.max(3, ...loops.map((loop) => loop.length));
  const coords: number[] = [];
  const index = new Map<string, number>();
  const at = (x: number, z: number): number => {
    const key = `${x},${z}`;
    const held = index.get(key);
    if (held !== undefined) return held;
    const made = coords.length / 2;
    coords.push(x, z);
    index.set(key, made);
    return made;
  };

  /* −1 is the padding `polyVertexCount` counts by, as `buildPolyMesh` writes it. */
  const polys = new Int32Array(loops.length * slots).fill(-1);
  loops.forEach((loop, poly) => {
    loop.forEach(([x, z], corner) => {
      polys[poly * slots + corner] = at(x, z);
    });
  });
  return {
    vertices: Int32Array.from(coords),
    vertexCount: coords.length / 2,
    polys,
    /* Deliberately empty: a portal is found from the geometry, not read from here. */
    neighbours: new Int32Array(loops.length * slots).fill(-1),
    polyCount: loops.length,
    maxVertsPerPoly: slots,
    polyRegion: new Int32Array(loops.length),
    originX: 0,
    originZ: 0,
    cellSize: 1,
  };
}

test('A PORTAL IS THE OVERLAP OF TWO EDGES, NOT A SHARED ONE', () => {
  /*
   * A T-junction, which is what two independently simplified regions produce: the left polygon's
   * right side runs from (4,0) to (4,2), and the right polygon's left side runs the whole way from
   * (4,4) to (4,0). They are adjacent along two units of wall and share no edge at all.
   */
  const mesh = meshOf([
    [
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ],
    [
      [4, 0],
      [8, 0],
      [8, 4],
      [4, 4],
    ],
  ]);
  const portals = buildPortalGraph(mesh);
  expect(portals.portalCount).toBe(1);
  expect(portals.sides[0]).toBe(0);
  expect(portals.sides[1]).toBe(1);

  /* The overlap is (4,0) to (4,2), so its midpoint — the graph node — is (4,1). */
  expect(portals.graph.positions[0]).toBeCloseTo(4, 6);
  expect(portals.graph.positions[2]).toBeCloseTo(1, 6);

  /*
   * **Named in each polygon's own direction of travel.** The left polygon stores that side running
   * from (4,0) up to (4,2); the right one stores its side running down. The funnel wants a left end
   * and a right end for the polygon being left, and one pair used for both directions swaps them.
   */
  const point = (vertex: number): [number, number] => [
    mesh.vertices[vertex * 2] as number,
    mesh.vertices[vertex * 2 + 1] as number,
  ];
  expect(point(portals.ends[0] as number)).toEqual([4, 0]);
  expect(point(portals.ends[1] as number)).toEqual([4, 2]);
  expect(point(portals.ends[2] as number)).toEqual([4, 2]);
  expect(point(portals.ends[3] as number)).toEqual([4, 0]);
});

test('two polygons that meet at a point are not a way through', () => {
  /*
   * Colinear and touching at (4,0) and nowhere else. **A zero-length portal is not a door**: an
   * agent cannot pass through a point, and the funnel handed one has a left end and a right end in
   * the same place, which pins its apex there and drags the path to it.
   */
  const mesh = meshOf([
    [
      [0, 0],
      [4, 0],
      [4, -2],
      [0, -2],
    ],
    [
      [4, 0],
      [8, 0],
      [8, 2],
      [4, 2],
    ],
  ]);
  expect(buildPortalGraph(mesh).portalCount).toBe(0);
});

test('a polygon’s own slit is not a portal to itself', () => {
  /*
   * **A hole is carried into a loop by a bridge**, and a bridge is the same segment walked out and
   * back — so a polygon holding both sides of one has two colinear edges overlapping along their
   * whole length. They are the same wall, not a way from a room to itself, and a portal between a
   * polygon and itself is a node the search can loop through.
   */
  const mesh = meshOf([
    [
      [0, 0],
      [6, 0],
      [6, 6],
      [3, 6],
      [3, 2],
      [3, 6],
      [0, 6],
    ],
  ]);
  const portals = buildPortalGraph(mesh);
  for (let portal = 0; portal < portals.portalCount; portal += 1) {
    expect(portals.sides[portal * 2]).not.toBe(portals.sides[portal * 2 + 1]);
  }
});

test('THE START PAYS FOR THE DISTANCE TO EVERY PORTAL IT COULD LEAVE BY', () => {
  /*
   * Three rooms in a row, so the middle one has two portals: at (4,1) and at (8,1). A start at
   * (5,1) is one metre from the first and three from the second, and **a search that charged
   * nothing for reaching either would choose its corridor as though the start were at both** —
   * which is how a path comes back going the wrong way round something.
   */
  const mesh = meshOf([
    [
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ],
    [
      [4, 0],
      [8, 0],
      [8, 2],
      [4, 2],
    ],
    [
      [8, 0],
      [12, 0],
      [12, 2],
      [8, 2],
    ],
  ]);
  const portals = buildPortalGraph(mesh);
  expect(portals.portalCount).toBe(2);

  attachStart(portals, 1, 5, 1);
  const { graph } = portals;
  const costs: number[] = [];
  for (const slot of portals.startSlots) {
    const target = graph.edgeTarget[slot] as number;
    /* A slot nobody is using points at the start itself, which a search can never improve on. */
    if (target === portals.startNode) {
      expect(graph.edgeCost[slot]).toBe(0);
      continue;
    }
    costs.push(graph.edgeCost[slot] as number);
  }
  expect(costs.sort((a, b) => a - b).map((cost) => Math.round(cost * 1e6) / 1e6)).toEqual([1, 3]);

  /* And the goal is paid for the same way, from whichever portals its own polygon has. */
  attachGoal(portals, 0, 1, 1);
  const goalCosts: number[] = [];
  for (let portal = 0; portal < portals.portalCount; portal += 1) {
    const slot = portals.goalSlot[portal] as number;
    if ((graph.edgeTarget[slot] as number) === portals.goalNode) {
      goalCosts.push(graph.edgeCost[slot] as number);
    }
  }
  expect(goalCosts).toEqual([3]);
});

/** Three rooms in a row, each four by two, sharing their sides by overlap and not by index. */
function rooms(): PolyMesh {
  return meshOf([
    [
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ],
    [
      [4, 0],
      [8, 0],
      [8, 2],
      [4, 2],
    ],
    [
      [8, 0],
      [12, 0],
      [12, 2],
      [8, 2],
    ],
  ]);
}

test('AN OVERLAP TAKES ONE END FROM EACH POLYGON WHERE THAT IS WHERE THEY ARE', () => {
  /*
   * Neither side contains the other: the left room's wall runs (4,0) to (4,2) and the right room's
   * runs (4,1) to (4,5), so the way through is (4,1) to (4,2) — **a low end from one and a high end
   * from the other**. Taking both from the same edge gives a portal with its two ends in one place,
   * which the funnel reads as a door the width of a point.
   */
  const mesh = meshOf([
    [
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ],
    [
      [4, 1],
      [8, 1],
      [8, 5],
      [4, 5],
    ],
  ]);
  const portals = buildPortalGraph(mesh);
  expect(portals.portalCount).toBe(1);
  expect(portals.graph.positions[0]).toBeCloseTo(4, 6);
  expect(portals.graph.positions[2]).toBeCloseTo(1.5, 6);
  const point = (vertex: number): [number, number] => [
    mesh.vertices[vertex * 2] as number,
    mesh.vertices[vertex * 2 + 1] as number,
  ];
  expect(point(portals.ends[0] as number)).toEqual([4, 1]);
  expect(point(portals.ends[1] as number)).toEqual([4, 2]);
});

test('a corridor is one straight line walked either way', () => {
  /*
   * **Both directions, because a portal is crossed from one side or the other** and the funnel
   * wants its left and right ends for the polygon being *left*. A path that used one polygon's
   * naming whichever way it travelled would tighten the wrong way going back and come home with
   * corners in an empty corridor.
   */
  const query = new NavMeshQuery(rooms());
  const out = new Float64Array(64);
  expect(query.findPath(1, 1, 11, 1, 0.5, out), 'there and').toBe(2);
  expect(query.findPath(11, 1, 1, 1, 0.5, out), 'back again').toBe(2);
});
