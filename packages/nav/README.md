# `@driftengine/nav`

A navigation mesh: geometry in, convex walkable polygons out, and a straight line across them.

**8,401 bytes gzipped**, measured by `scripts/size-gate.test.mjs` against
`scripts/fixtures/size/nav-only.ts`. Optional — nothing in `@driftengine/core` imports it, so a game
that does not path pays nothing.

## Why this exists when `NavGraph` already does

`core/src/nav/navGraph.ts` says in its own header that it is a graph rather than a mesh, that this
is a decision rather than a first step, and that _"if a world's walkable space genuinely is a
region, this is the wrong structure and a mesh is the row that is still open."_ A streamed open
world is that world. The module named its own trigger; this pulls it.

**The graph is not replaced.** It stays right for the case it was built for — roads, corridors,
rails, docking lanes — which is what consumers kept arriving with, and a mesh would have asked them
to throw that away. Two structures for two shapes of world, and **one search**: `NavMeshQuery`
builds a `NavGraph` over polygons and hands it to core's `NavSearch`, so there is exactly one A* in
this repository.

## The pipeline

| Step               | What it produces                                                               |
| ------------------ | ------------------------------------------------------------------------------ |
| `voxeliseWalkable` | Where an agent of a given size could stand, as spans in grid columns           |
| `buildRegions`     | Watershed partitioning, so a corridor splits two rooms instead of joining them |
| `buildContours`    | One closed boundary per region, simplified and checked for self-intersection   |
| `buildPolyMesh`    | Convex polygons that tile the region and border each other both ways           |
| `NavMeshQuery`     | A* over the polygons, then a funnel — so open ground is one straight line      |

```ts
const field = voxeliseWalkable(geometry, {
  cellSize: 0.3,
  cellHeight: 0.2,
  maxSlope: 45,
  agentHeight: 2,
  agentRadius: 0.5,
});
const regions = buildRegions(field, { minRegionSpans: 8, maxStep: 1 });
const mesh = buildPolyMesh(buildContours(field, regions, 1.3), 6, field);

const query = new NavMeshQuery(mesh);
const path = new Float64Array(256);
const count = query.findPath(from.x, from.z, to.x, to.z, 2, path);
```

`findPath` returns `0` for no route, which is an answer rather than an error: a world with a gap in
it has two components, and an agent that asks for the other side has to be told.

## What it does not do

- **Steering.** §6.5 of the design reverses the refusal of a navigation _mesh_, which is a function
  from geometry to a graph. What an agent does with a path stays a game's decision, and
  `ai/src/entities/context.ts`'s refusal is upheld on exactly that line.
- **Holes.** `buildContours` takes a region's outer loop and drops any inner one, so a room with a
  free-standing pillar becomes a room and an agent walks through the pillar. There is a test that
  pins that behaviour rather than a comment that hopes about it. The fix is a bridge edge joining
  the inner loop to the outer; until it is built, leave a gap between a pillar and the floor so the
  watershed splits around it.
- **Optimal paths.** The funnel gives the shortest path through the corridor A* chose, and the
  corridor comes from polygon centres. On the wall in `query.test.ts` that is 10.75 against an ideal
  9.81 — about a tenth, from the region split putting a portal corner a cell below the wall's foot.
