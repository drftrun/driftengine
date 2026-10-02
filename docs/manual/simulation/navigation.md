---
title: Navigation
description: Routes over a graph of lanes and roads, and over a navigation mesh built from a level's geometry, with the following of a route in DriftScript.
packages: ['@driftengine/nav', '@driftengine/script']
covers: ['A navigation mesh']
areas: ['nav']
---

# Navigation

There are two shapes of world to find a way through. Some are already a network: roads, corridors,
rails, the lanes between doors. Core routes over those as a graph of places and the ways between
them. Others are open ground an agent may cross anywhere, and for those `@driftengine/nav` builds a
navigation mesh from the level's own geometry. Both search with the same A\*, and both answer the
same route every time for the same question, ties included, so a route can be decided inside the
fixed step and replayed.

The example is a town square. Six villagers walk the lanes from door to door, routed and steered by
a DriftScript module through `drift/navigation`. Three dogs run where they like across the open
ground, round the fountain and the market stalls, on a navigation mesh. Show the mesh or the lanes,
and pack the stalls away or put them out: the mesh is rebuilt round them while everyone keeps
walking.

<!-- run: navigation -->

## A graph

```ts sample=navigation/main.ts#lanes
/**
 * The lanes, as places and the ways between them: eight doors, then the middle of each street,
 * then eight points round the fountain. The doors come first, so a door is a node below eight.
 */
const lanePoints: number[] = [];
for (const [x, z] of BUILDINGS) {
  /* Each building has a door on the street running north and south, and one on the other. */
  lanePoints.push(Math.sign(x) * 6.2, 0, z, x, 0, Math.sign(z) * 6.2);
}
/* Nodes 8 to 11, the streets: south, east, north, west. */
for (const [x, z] of [
  [0, -13.5],
  [13.5, 0],
  [0, 13.5],
  [-13.5, 0],
]) {
  lanePoints.push(x ?? 0, 0, z ?? 0);
}
/* Nodes 12 to 19, the ring, starting east and turning toward the north. */
for (let k = 0; k < 8; k += 1) {
  lanePoints.push(Math.cos((k * Math.PI) / 4) * 4.5, 0, Math.sin((k * Math.PI) / 4) * 4.5);
}
/** Each door to its street, each street to the ring, and the ring round. Every way runs both ways. */
const DOOR_TO_STREET = [8, 11, 8, 9, 10, 11, 10, 9];
const STREET_TO_RING = [18, 12, 14, 16];
const laneEdges: NavEdge[] = [
  ...DOOR_TO_STREET.map((street, door) => ({ from: door, to: street })),
  ...STREET_TO_RING.map((ring, at) => ({ from: 8 + at, to: ring })),
  ...Array.from({ length: 8 }, (_, k) => ({ from: 12 + k, to: 12 + ((k + 1) % 8) })),
];
const lanes: NavGraph = buildNavGraph(lanePoints, laneEdges);
```

`buildNavGraph(positions, edges)` takes the places as `x`, `y` and `z` a node and the ways between
them as `NavEdge`s: `from` and `to`, a `cost`, which defaults to the distance between the two, and
`bidirectional`, true unless you say otherwise. A cost is how you prefer a road or avoid a hill, and
it may be more than the distance and never less: an edge cheaper than flying is refused, since the
search's estimate of what is left assumes it, and with it gone the first route found would not be
the cheapest.

`new NavSearch(graph)` is the search, made once and reused, since its scratch is the size of the
graph. `find(from, to, out)` writes the nodes of the cheapest route into `out` and answers how many,
0 for none, which is an answer and not an error: a graph with a gap in it has two sides.
`nearestNavNode(graph, x, y, z, maxDistance)` is how an agent gets onto the network, and the
distance keeps one that has wandered off from being snapped to the far side of the map; it is a
scan, fine for the hundreds of nodes of a road network.

A graph is the right shape when the ways through a world are a network already. An agent on one
takes the corners the graph has and no others, so open ground crossed by two nodes is crossed in a
straight line.

## Following a route

A route is a list of nodes, and walking it is a separate problem: when a waypoint counts as
reached, what to aim at, what to do when the walker is pushed off the line. `new NavPath(graph,
capacity, options)` holds one route and answers it:

- `set(nodes, count)` stores a route `find` wrote, and `clear()` forgets it.
- `steer(x, y, z, out)` writes into a `NavSteer`, from `createNavSteer()`, the point to aim at: a
  `lookaheadM` along the route, two metres unless you say otherwise, so a walker cuts a corner and
  does not zigzag from node to node. It writes `remainingM`, the distance left along the route, and
  `arrived`, true within `arriveM` of the end, half a metre by default, and true with no route at
  all.

Where the walker is along the route is worked out from where it stands, every time, so a walker
shoved backwards past a node aims at the right place and does not turn round for a node already
behind it. `NavPath` moves nothing: speed, turning and collision are the game's, which is the same
line the character controller draws.

## Walking it in DriftScript

```drs sample=navigation/walk.drs#walk
// One frame of one villager: rest at a door, choose the next, or walk toward the point its route
// says to aim at, which is a little way along the lane and so cuts corners the way people do.
fn walk(villager: mut Villager, route: NavPath, lanes: NavGraph, dt: f32) {
    if navigation.arrived(route, villager.x, 0, villager.z) {
        if villager.resting > 0 {
            villager.resting = villager.resting - dt
            return
        }
        // The doors are the lanes' first eight nodes.
        let door = random.index(villager.seed + villager.trips, 8)
        let here = navigation.nearest(lanes, villager.x, 0, villager.z)
        if navigation.routeBetween(route, lanes, here, i32.clamp(door)) {
            villager.trips = villager.trips + 1
            villager.resting = 2.5
        }
        return
    }
    let dx = navigation.steerX(route, villager.x, 0, villager.z) - villager.x
    let dz = navigation.steerZ(route, villager.x, 0, villager.z) - villager.z
    let distance = math.sqrt(dx * dx + dz * dz)
    if distance > 0.01 {
        villager.x = villager.x + dx / distance * villager.pace * dt
        villager.z = villager.z + dz / distance * villager.pace * dt
        villager.heading = math.atan2(dx, dz)
    }
}
```

```ts sample=navigation/main.ts#script
/** The villagers' walking, hosted with the lanes it routes over, and a route for each villager. */
const walking = hostScript(walkScript, {
  navigation: { graph: lanes, search: new NavSearch(lanes) },
});
interface Villager {
  x: number;
  z: number;
  heading: number;
  pace: number;
  resting: number;
  trips: number;
  seed: number;
}
type Walk = (villager: Villager, route: NavPath, lanes: NavGraph, dt: number) => void;
const villagers = Array.from({ length: 6 }, (_, at) => {
  const villager = exported<() => Villager>(walking, 'createVillager')();
  villager.x = lanePoints[at * 3] ?? 0;
  villager.z = lanePoints[at * 3 + 2] ?? 0;
  villager.seed = at * 97;
  villager.pace = 1.1 + hashToUnit(at) * 0.5;
  return { villager, route: new NavPath(lanes, 32, { lookaheadM: 1.2, arriveM: 0.3 }) };
});
if (import.meta.hot) {
  import.meta.hot.accept('./walk.drs', (next) => {
    if (next !== undefined) {
      patchModule(walking, next as Record<string, unknown>, {
        Villager: villagers.map(({ villager }) => villager),
      });
    }
  });
}
```

`drift/navigation` needs the network it routes over, so the host passes `navigation`, a graph and a
search over it, to `bindModule`, with `maxRouteNodes` for the longest route it will store, 256 if
absent; a longer one is refused and not cut short. A module then has:

- `nearest` and `nearestWithin`, the node nearest a place, or `-1`.
- `route`, from one place to another, and `routeBetween`, between two nodes you have. Both store
  the route in a `NavPath` and answer whether there was one.
- `path`, the route the host keeps for an entity between steps, and `clear` and `following`.
- `steerX`, `steerY` and `steerZ`, the point to aim at; `remaining`, the distance left along the
  route; and `arrived`.

The route is a function of the graph and its ends, so these are deterministic and a
`@deterministic` system may call them. In the example each villager's `NavPath` is made by the page
and handed in, and the module chooses doors with `drift/random`, seeded by the villager's own
count of trips, so a run replays exactly. Under `npm run examples`, change the rest at a door or
the pace and save: the villagers keep where they are and walk by the new rule.

## A navigation mesh

```ts sample=navigation/main.ts#square
/** Four buildings round a cross of streets, a fountain in the middle, and four market stalls. */
const BUILDINGS: [number, number][] = [
  [-13.5, -13.5],
  [13.5, -13.5],
  [-13.5, 13.5],
  [13.5, 13.5],
];
const STALLS: [number, number][] = [
  [5, -3.5],
  [-4.5, 5],
  [3.5, 5.5],
  [-5.5, -4],
];

/** The square as triangles: what is drawn, and what the navigation mesh is built from. */
function square(stalls: boolean): MeshData {
  const builder = new MeshBuilder().addBox([0, -0.25, 0], [20, 0.25, 20], [0.55, 0.52, 0.47]);
  for (const [x, z] of BUILDINGS) builder.addBox([x, 2.5, z], [6.5, 2.5, 6.5], [0.78, 0.66, 0.52]);
  builder.addCylinder([0, 0.4, 0], 2.5, 0.4, 'y', [0.62, 0.62, 0.66], 0, 24);
  if (stalls) {
    for (const [x, z] of STALLS) builder.addBox([x, 0.6, z], [1.2, 0.6, 0.8], [0.55, 0.38, 0.24]);
  }
  return builder.build();
}
```

```ts sample=navigation/main.ts#mesh
/** Geometry in, convex walkable polygons out, sized for a dog: a metre tall and 0.4 m across. */
function bake(stalls: boolean): { mesh: PolyMesh; query: NavMeshQuery; ms: number } {
  const started = performance.now();
  const field = voxeliseWalkable(square(stalls), {
    cellSize: 0.3,
    cellHeight: 0.2,
    maxSlope: 45,
    agentHeight: 1,
    agentRadius: 0.4,
    maxStep: 2,
  });
  const regions = buildRegions(field, { minRegionSpans: 40, maxStep: 2 });
  const mesh = buildPolyMesh(buildContours(field, regions, 1.3), 6, field);
  return { mesh, query: new NavMeshQuery(mesh), ms: performance.now() - started };
}
```

A navigation mesh is the walkable ground as convex polygons, built from triangles. Four steps:

1. `voxeliseWalkable(geometry, settings)` finds where an agent could stand, as spans in columns on
   a grid. Its settings are the grid, `cellSize` and `cellHeight`, and the agent: `maxSlope` in
   degrees, `agentHeight`, `agentRadius`, and `maxStep`, how many cells high a step it can climb. A
   face too steep to stand on is a solid in every cell it crosses, so a wall is in the way however
   thin it is; a floor with too little headroom above it is not walkable; and the walkable ground is
   eroded by the agent's radius from every edge, wall and ledge higher than `maxStep`. Two floors at
   one place, a bridge over a road, are two spans.
2. `buildRegions(field, settings)` divides it into regions by watershed, so a corridor between two
   rooms is where they divide. `maxStep` is the same number again, and `minRegionSpans` is the
   smallest region kept: smaller ones are merged into a neighbour. Where two obstacles sit
   diagonally from each other, such as the fountain and a building's corner, the watershed leaves
   strips a cell wide; the example's 40 folds them in.
3. `buildContours(field, regions, maxDeviation)` outlines each region, simplified to within
   `maxDeviation` cells of the true edge. Holes are kept, so a path goes round a pillar, and where
   two regions meet, their shared border is simplified the same way from both sides, so they meet
   edge to edge.
4. `buildPolyMesh(contours, maxVertsPerPoly, field)` cuts the outlines into convex polygons of up
   to that many corners, each knowing its neighbours.

The `PolyMesh` it returns holds `polyCount` polygons and their corners in cells, with `originX`,
`originZ` and `cellSize` to turn them into metres; `polyVertexCount`, `polyNeighbour`, `polyArea`
and `polyIsConvex` read a polygon. The example draws every polygon's edges from these.

The polygons are flat and one layer deep. Where two floors overlap, only the lower becomes polygons,
and the floor sealed inside a closed box stays walkable inside its walls, an island no route from
outside reaches. Building one is a bake: the square takes 40 to 110 milliseconds here, so do it when
a level loads or changes, as the stalls switch does, and never every frame.

## Paths across it

```ts sample=navigation/main.ts#route
/** Path from where the dog is to its goal, over whichever mesh is current. */
function route(dog: Dog): boolean {
  dog.count = baked.query.findPath(dog.x, dog.z, dog.goalX, dog.goalZ, 1.5, dog.path);
  dog.next = 1;
  return dog.count > 1;
}
```

`new NavMeshQuery(mesh)` searches the mesh, and `findPath(fromX, fromZ, toX, toZ, extent, out)`
writes the path as `x` and `z` pairs and answers how many points, 0 for none. `extent` is how far
off the mesh a point may be and still be snapped onto it, so a goal inside a building or past the
edge of the square answers no path and the dog picks another. The search runs over the portals
between polygons, the overlaps of their edges, and then pulls the path tight through them, so a
path across open ground is one straight line and a path round an obstacle is the shortest way
round it.

`findPolyPath(from, to, out)` answers the polygons a path crosses, and `nearestPoly(mesh, x, z,
extent)` the polygon under a point. A query holds scratch for its mesh, so make one per mesh and
reuse it, and a new mesh needs a new query.

What a mesh does not do is avoidance: the dogs run through the villagers and through each other.
How an agent moves along a path is the game's, as with a graph.

`@driftengine/nav` is 8.8 KB gzipped, and nothing in core imports it; the graph, the search and
`NavPath` are core's.
