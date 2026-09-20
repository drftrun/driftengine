/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * `@driftengine/nav` — a navigation mesh.
 *
 * **This reverses a refusal, and the refused module named its own trigger.**
 * `core/src/nav/navGraph.ts` says it is a graph rather than a mesh, that this is a decision rather
 * than a first step, and that *"if a world's walkable space genuinely is a region, this is the
 * wrong structure and a mesh is the row that is still open."* A streamed open world is that world.
 *
 * **The graph is not replaced.** It stays right for the case it was built for — roads, corridors,
 * rails, docking lanes — which is what consumers kept arriving with, and a mesh would have asked
 * them to throw that away. Two structures, two shapes of world, one search: the query here builds a
 * `NavGraph` over polygons and hands it to core's `NavSearch`, so there is one A* in this
 * repository and not two.
 *
 * **Steering is still refused.** §6.5 reverses the refusal of a navigation *mesh*, which is a
 * function from geometry to a graph. What an agent does with a path stays a game's decision, and
 * `ai/src/entities/context.ts`'s refusal is upheld on exactly that line.
 */
export { columnAt, spanCount, spanFloor, spanWalkable, voxeliseWalkable } from './voxelise.ts';
export type { NavGeometry, VoxelField, VoxeliseSettings } from './voxelise.ts';
export { buildRegions, regionOfSpan, regionsLinked, spanIndexAt } from './regions.ts';
export type { RegionField, RegionSettings } from './regions.ts';
export { buildContours, contourSelfIntersects, maxDeviationOf } from './contour.ts';
export type { Contour } from './contour.ts';
export {
  NO_NEIGHBOUR,
  buildPolyMesh,
  polyArea,
  polyIsConvex,
  polyNeighbour,
  polyVertexCount,
} from './polymesh.ts';
export type { NavPlacement, PolyMesh } from './polymesh.ts';
export { NavMeshQuery, nearestPoly } from './query.ts';
/*
 * **The graph is over portals, not polygons**, which is what makes a path the shortest one rather
 * than one about a tenth longer. `portalGraph.ts` carries the argument and the measurement that
 * opened it; `buildPolyGraph` is gone, because a node per polygon optimises a quantity no agent
 * walks and there is no reason to keep a second graph that does.
 */
export { attachGoal, attachStart, buildPortalGraph } from './portalGraph.ts';
export type { PortalGraph } from './portalGraph.ts';
