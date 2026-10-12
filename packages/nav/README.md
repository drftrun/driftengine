# `@driftengine/nav`

A navigation mesh: geometry in, convex walkable polygons out, and a straight line across them.

**9,051 bytes gzipped**, measured by `scripts/size-gate.test.mjs` against
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
  maxStep: 1,
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
- **A closed box's inside.** A column inside a box meets the floor, the box's bottom and its top,
  and nothing there says the space between is solid short of trusting every mesh's winding. So the
  floor a closed box encloses stays walkable: an island inside the box's walls that no route from
  outside reaches, but `nearestPoly` can still snap a point beside the box onto it. A test pins it.
- **More than one layer of polygons.** The voxel field keeps both floors under a bridge, and the
  regions keep them apart, but a contour follows the lowest walkable span in each column, so where
  two floors overlap only the lower one becomes polygons.

## Walls, pillars and the shortest way round

- **A wall is a solid.** A face too steep to stand on is clipped to every cell it crosses and
  stands in that column as a solid, so a building on the ground blocks, and so does a wall with no
  thickness and no top. Erosion judges a neighbour at the span's own height, so the agent keeps its
  radius from a wall even when the wall's top is walkable, and from a ledge higher than `maxStep`.
  Give the voxeliser the same `maxStep` as `buildRegions`: the polygons are flat, so two edges that
  touch are a portal whatever their heights, and erosion is what keeps a floor and a ledge apart.
- **A shared border is one line.** A room the watershed splits is several regions, and a portal is
  where two polygons' edges overlap. The points where a border changes what it faces are held in
  every outline through them, and each stretch between is simplified the same way from both sides,
  so the regions meet edge to edge at any deviation.
- **A pillar is a hole.** A region's inner loops are bridged into its outline, so a path goes round
  a free-standing pillar and no polygon claims the ground under it.
- **A path is the shortest way round.** The search runs over portals, the overlaps between
  neighbouring polygons' edges, so the corridor it hands the funnel holds the shortest path: 9.81
  on the wall in `query.test.ts`, where a search over polygon centres gives 10.75.
