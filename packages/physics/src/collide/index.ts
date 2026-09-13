/**
 * Axis-separated collision, in four parts.
 *
 * Split from one 1,064-line file along the concerns its sixteen exports already described:
 * an axis-aligned box and the arithmetic on it, a body and the bounds it presents, the sweep
 * that resolves movement one axis at a time, and the segment test that answers what a ray
 * hits.
 *
 * Everything the single file exported is re-exported here, so `from './collide'` resolves
 * exactly as it did and no caller moved.
 */
export type { Aabb } from './aabb.ts';
export { aabbFromCenter } from './aabb.ts';
export type { Axis, Body, BodyBounds, BodyFrame, BodyPart } from './body.ts';
export {
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
  bodyBounds,
  bodyFrame,
  createBodyBounds,
  createBodyFrame,
} from './body.ts';
export { ejectFromSolid } from './eject.ts';
export { moveAxis } from './sweep.ts';
export { segmentHit } from './segment.ts';
