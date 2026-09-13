import { expect, test } from 'vitest';

import { buildNavGraph, nearestNavNode } from './navGraph.ts';
import { NavSearch } from './navSearch.ts';
import { NavPath, createNavSteer } from './navPath.ts';

/**
 * A diamond with a cheap north side and an expensive south one.
 *
 * Both detours are the same shape — two edges of `hypot(10, 5)` = 11.1803398875 — so a search that
 * ignored costs would have a tie to break and could answer either. The south edges are declared at
 * 20 each, so north is 22.360679775 and south is 40, and the answer is one route rather than a
 * defensible one.
 */
function diamond(): ReturnType<typeof buildNavGraph> {
  return buildNavGraph(
    [0, 0, 0, 10, 0, -5, 10, 0, 5, 20, 0, 0],
    [
      { from: 0, to: 1 },
      { from: 1, to: 3 },
      { from: 0, to: 2, cost: 20 },
      { from: 2, to: 3, cost: 20 },
    ],
  );
}

test('the cheapest route wins, not the one with fewest turns', () => {
  const graph = diamond();
  const search = new NavSearch(graph);
  const path = new Uint32Array(8);
  expect(search.find(0, 3, path)).toBe(3);
  expect(Array.from(path.subarray(0, 3))).toEqual([0, 1, 3]);
});

/**
 * The property that makes a cost a cost rather than a slower name for a distance.
 *
 * A direct road a hundred metres long declared at a cost of 1000 — deep mud, a toll, a road an
 * agent should stay off — against a detour of 50 + 100 + 50 = 200 in real metres and in cost. The
 * detour is twice as far and five times cheaper, and an agent takes it.
 */
test('a long cheap way beats a short expensive one', () => {
  const graph = buildNavGraph(
    [0, 0, 0, 100, 0, 0, 0, 0, 50, 100, 0, 50],
    [
      { from: 0, to: 1, cost: 1000 },
      { from: 0, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 1 },
    ],
  );
  const path = new Uint32Array(8);
  const count = new NavSearch(graph).find(0, 1, path);
  expect(Array.from(path.subarray(0, count))).toEqual([0, 2, 3, 1]);
});

test('an unreachable node is an answer rather than an error', () => {
  /* A bridge out: two components. An agent asking for the other side has to be told, inside a
     frame, rather than thrown at. */
  const graph = buildNavGraph(
    [0, 0, 0, 10, 0, 0, 100, 0, 0, 110, 0, 0],
    [
      { from: 0, to: 1 },
      { from: 2, to: 3 },
    ],
  );
  const path = new Uint32Array(8);
  expect(new NavSearch(graph).find(0, 3, path)).toBe(0);
  expect(new NavSearch(graph).find(0, 1, path), 'and its own side still works').toBe(2);
});

/**
 * An edge cheaper than flying is refused where it is declared.
 *
 * A* is exact only while the heuristic never overestimates, and the heuristic here is the straight
 * line. One edge below its own span and the search still runs, still terminates, and returns routes
 * that are quietly not the cheapest — the worst kind of wrong, because every individual answer
 * looks reasonable.
 */
test('an edge that beats a straight line is refused at build time', () => {
  expect(() => buildNavGraph([0, 0, 0, 10, 0, 0], [{ from: 0, to: 1, cost: 5 }])).toThrow(
    /breaks the search heuristic/,
  );
  expect(
    () => buildNavGraph([0, 0, 0, 10, 0, 0], [{ from: 0, to: 1, cost: 10 }]),
    'exactly equal is fine',
  ).not.toThrow();
  expect(() => buildNavGraph([0, 0, 0], [{ from: 0, to: 7 }])).toThrow(/not a node of 1/);
});

test('a one-way edge is one way', () => {
  const graph = buildNavGraph([0, 0, 0, 10, 0, 0], [{ from: 0, to: 1, bidirectional: false }]);
  const path = new Uint32Array(4);
  expect(new NavSearch(graph).find(0, 1, path)).toBe(2);
  expect(new NavSearch(graph).find(1, 0, path), 'and not the other').toBe(0);
});

/**
 * Same graph, same endpoints, same nodes out — including where two routes are exactly as good.
 *
 * A grid is where this bites: from a corner to the opposite corner every monotone staircase costs
 * the same, and a heap pops equal keys in whatever order it happens to hold them. Ties break on the
 * node index instead, which is arbitrary and stable, so a replay walks the road it walked before.
 */
test('two searches over a graph full of ties agree exactly', () => {
  const positions: number[] = [];
  const edges: { from: number; to: number }[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      positions.push(col * 10, 0, row * 10);
      const here = row * 3 + col;
      if (col > 0) edges.push({ from: here - 1, to: here });
      if (row > 0) edges.push({ from: here - 3, to: here });
    }
  }
  const graph = buildNavGraph(positions, edges);

  const first = new Uint32Array(16);
  const second = new Uint32Array(16);
  const a = new NavSearch(graph).find(0, 8, first);
  const b = new NavSearch(graph).find(0, 8, second);
  expect(a, 'four edges of ten, so five nodes').toBe(5);
  expect(Array.from(second.subarray(0, b))).toEqual(Array.from(first.subarray(0, a)));
  expect(first[0]).toBe(0);
  expect(first[4]).toBe(8);
});

/**
 * The same graph declared in a different order still answers the same route.
 *
 * This is what the index tie-break actually buys, and the test above cannot see it: two runs of the
 * same code agree whether or not ties are broken deliberately. What ties break is the dependence on
 * *insertion order* — which equally-good route wins should not change because a consumer listed
 * their roads north-to-south this time. Reverse the edges, keep the nodes, get the same path.
 */
test('a route does not depend on the order the edges were declared in', () => {
  const positions: number[] = [];
  const edges: { from: number; to: number }[] = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      positions.push(col * 10, 0, row * 10);
      const here = row * 4 + col;
      if (col > 0) edges.push({ from: here - 1, to: here });
      if (row > 0) edges.push({ from: here - 4, to: here });
    }
  }
  const forward = new Uint32Array(32);
  const backward = new Uint32Array(32);
  const a = new NavSearch(buildNavGraph(positions, edges)).find(0, 15, forward);
  const b = new NavSearch(buildNavGraph(positions, [...edges].reverse())).find(0, 15, backward);
  expect(a, 'six edges of ten, so seven nodes').toBe(7);
  expect(Array.from(backward.subarray(0, b))).toEqual(Array.from(forward.subarray(0, a)));
});

test('a route longer than the buffer is refused rather than truncated', () => {
  /* Half a route is worse than none: an agent follows it confidently into the middle of nowhere
     and stops there. */
  const positions: number[] = [];
  const edges: { from: number; to: number }[] = [];
  for (let i = 0; i < 10; i++) {
    positions.push(i * 5, 0, 0);
    if (i > 0) edges.push({ from: i - 1, to: i });
  }
  const graph = buildNavGraph(positions, edges);
  expect(new NavSearch(graph).find(0, 9, new Uint32Array(4))).toBe(0);
  expect(new NavSearch(graph).find(0, 9, new Uint32Array(10))).toBe(10);
});

test('the nearest node can be out of reach', () => {
  const graph = diamond();
  expect(nearestNavNode(graph, 19, 0, 1)).toBe(3);
  expect(nearestNavNode(graph, 500, 0, 0), 'without a limit, however far').toBe(3);
  expect(nearestNavNode(graph, 500, 0, 0, 50), 'with one, nothing').toBe(-1);
});

/* ---------------------------------------------------------------- following */

/** A straight run east: (0,0,0) → (10,0,0) → (20,0,0), twenty metres of it. */
function straight(): { path: NavPath; steer: ReturnType<typeof createNavSteer> } {
  const graph = buildNavGraph(
    [0, 0, 0, 10, 0, 0, 20, 0, 0],
    [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ],
  );
  const path = new NavPath(graph, 8, { lookaheadM: 2, arriveM: 0.5 });
  path.set(Uint32Array.from([0, 1, 2]), 3);
  return { path, steer: createNavSteer() };
}

test('an agent aims a lookahead ahead of itself, along the path', () => {
  const { path, steer } = straight();
  expect(path.lengthM).toBe(20);

  path.steer(0, 0, 0, steer);
  expect(steer.x, 'two metres along').toBeCloseTo(2, 9);
  expect(steer.remainingM).toBeCloseTo(20, 9);
  expect(steer.arrived).toBe(false);

  path.steer(9, 0, 0, steer);
  expect(steer.x).toBeCloseTo(11, 9);
  expect(steer.remainingM).toBeCloseTo(11, 9);
});

test('near the end it aims at the end rather than past it', () => {
  const { path, steer } = straight();
  path.steer(19.9, 0, 0, steer);
  expect(steer.x, 'clamped to the goal').toBeCloseTo(20, 9);
  expect(steer.remainingM).toBeCloseTo(0.1, 9);
  expect(steer.arrived, 'inside the arrival radius').toBe(true);
});

/**
 * Progress is recovered from the agent's own position, which is what a shove costs and does not
 * break.
 *
 * An index into the waypoints only counts up, so an agent knocked backwards past one keeps aiming
 * at the waypoint behind it and walks into whatever pushed it. Here the agent is put at 15 m and
 * then at 2 m, and the second answer is the second position's.
 */
test('an agent carried backwards is following from where it actually is', () => {
  const { path, steer } = straight();
  path.steer(15, 0, 0, steer);
  expect(steer.x).toBeCloseTo(17, 9);

  path.steer(2, 0, 0, steer);
  expect(steer.x, 'not still ahead of where it was').toBeCloseTo(4, 9);
  expect(steer.remainingM).toBeCloseTo(18, 9);
});

test('an agent pushed off the line is projected back onto it', () => {
  const { path, steer } = straight();
  /* Five metres to the south of the halfway point: it projects to 10 m along, and aims at 12. */
  path.steer(10, 0, 5, steer);
  expect(steer.x).toBeCloseTo(12, 9);
  expect(steer.z, 'the target is on the path, not beside it').toBeCloseTo(0, 9);
});

/**
 * A corner, cut rather than snapped at.
 *
 * East ten metres then north ten. An agent at 9 m has one metre of the first leg left, so a
 * two-metre lookahead lands one metre up the second leg: `(10, 0, 1)`. Aiming at the corner node
 * itself is what makes an agent stop, turn and set off again at every waypoint, which is the
 * zigzag that follows from steering at nodes.
 */
test('the aim point turns the corner before the agent reaches it', () => {
  const graph = buildNavGraph(
    [0, 0, 0, 10, 0, 0, 10, 0, 10],
    [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ],
  );
  const path = new NavPath(graph, 8, { lookaheadM: 2 });
  path.set(Uint32Array.from([0, 1, 2]), 3);
  const steer = createNavSteer();

  path.steer(9, 0, 0, steer);
  expect(steer.x).toBeCloseTo(10, 9);
  expect(steer.z, 'already round the corner').toBeCloseTo(1, 9);
});

test('no route is arrival, so a caller needs one check and not two', () => {
  const graph = buildNavGraph([0, 0, 0, 10, 0, 0], [{ from: 0, to: 1 }]);
  const path = new NavPath(graph, 4);
  const steer = createNavSteer();

  path.steer(3, 0, 0, steer);
  expect(steer.arrived).toBe(true);
  expect(steer.x, 'aim where you stand').toBe(3);
  expect(path.active).toBe(false);

  /* A route of one node is a route to where the agent already is: also no route. */
  path.set(Uint32Array.from([1]), 1);
  expect(path.active).toBe(false);
});

/**
 * A dense graph, searched with a heuristic too weak to prune.
 *
 * Eight by eight, connected to all eight neighbours, with every cost ten times its own span. The
 * costs are legal — never below the straight line — and they make the straight-line heuristic so
 * optimistic that A* stops pruning and behaves much like Dijkstra, which is the shape that
 * exercises the heap rather than skipping past it.
 *
 * **What this does not test is the heap's sizing, and saying so is the honest version.** That
 * bound is an argument — a push happens at most once per directed edge, so an array of that length
 * cannot overflow — and the array is sized from it. Occupancy in practice stays far below either
 * bound, so a graph big enough to tell a correct sizing from an incorrect one is bigger than a test
 * worth running: this one passes at both sizes. The guard in `push` is what stands behind the
 * argument if it is ever wrong.
 */
test('a dense graph with a weak heuristic still finds the corner', () => {
  const side = 8;
  const positions: number[] = [];
  const edges: { from: number; to: number; cost: number }[] = [];
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) positions.push(col * 10, 0, row * 10);
  }
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const here = row * side + col;
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
      ] as const) {
        const r = row + dr;
        const c = col + dc;
        if (r >= side || c < 0 || c >= side) continue;
        const there = r * side + c;
        edges.push({ from: here, to: there, cost: Math.hypot(dr, dc) * 10 * 10 });
      }
    }
  }

  const graph = buildNavGraph(positions, edges);
  const search = new NavSearch(graph);
  const path = new Uint32Array(side * side);
  const count = search.find(0, side * side - 1, path);

  expect(count, 'seven diagonal steps, so eight nodes').toBe(8);
  expect(path[0]).toBe(0);
  expect(path[count - 1]).toBe(side * side - 1);
  expect(search.expanded, 'and it really did have to look around').toBeGreaterThan(side);
});
