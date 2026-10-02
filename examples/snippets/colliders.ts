/**
 * A body swept through a collider set one axis at a time, and scenery that streams in as one
 * static mesh body a region.
 *
 * A snippet, typechecked with the examples and quoted by the manual's queries chapter.
 */
import {
  AXIS_X,
  AXIS_Y,
  BODY_STATIC,
  ColliderSet,
  PhysicsWorld,
  StaticRegions,
  boxCollider,
  meshShape,
  moveAxis,
} from '@driftengine/physics';
import type { Body } from '@driftengine/physics';

// #region sweep
const colliders = new ColliderSet([boxCollider(0, -0.5, 0, 20, 0.5, 20)]);
const body: Body = { x: 0, y: 2, z: 0, hx: 0.35, hy: 0.9, hz: 0.35 };

/** How far it actually travelled along each axis, which is less where something was in the way. */
export const across = moveAxis(body, colliders, AXIS_X, 0.05);
export const down = moveAxis(body, colliders, AXIS_Y, -0.02);
// #endregion

// #region regions
/** One static mesh body a region, added as it streams in and removed as it streams out. */
const world = new PhysicsWorld();
const scenery = new StaticRegions(world);

export function streamIn(region: number, positions: Float32Array, indices: Uint32Array): void {
  scenery.add(region, { type: BODY_STATIC, shape: meshShape(positions, indices) });
}

export function streamOut(region: number): void {
  scenery.remove(region);
}

/** The body a region stands as now, which changes as other regions leave. */
export const bodyOf = (region: number): number => scenery.bodyOf(region);
// #endregion
