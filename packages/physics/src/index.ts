/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */
/**
 * Collision shapes, the spatial hash over them, and the swept kinematic sweep.
 *
 * **This package imports no other engine package**, the same shape as `@driftengine/drft` and
 * `@driftengine/entities`. What it buys is a simulation that runs with no renderer in its module
 * graph — in Node, in a worker, or on a server — which is what a server-authoritative consumer
 * needs and what a peer dependency on core would have priced at core's whole gzipped weight.
 *
 * `@driftengine/core` re-exports every name here, so a consumer that reaches for collision through
 * the core barrel is unaffected by where the files live. **Core depends on this package rather
 * than the other way round**, which is the opposite direction from every other optional package
 * and is not a choice: the cameras, the contact probe and the ribbon builder all need the sweep.
 * **What would make it wrong** is the dynamics landing here becoming reachable from
 * `createRenderer`, which `scripts/size-gate.test.mjs` measures rather than trusts.
 */
export type { Aabb, Axis, Body, BodyPart } from './collide/index.ts';
export {
  AXIS_X,
  AXIS_Y,
  AXIS_Z,
  aabbFromCenter,
  bodyBounds,
  createBodyBounds,
  ejectFromSolid,
  moveAxis,
  segmentHit,
} from './collide/index.ts';
export { faceCount, faceVertices } from './faces.ts';
export type { BodyDesc, BodyType } from './bodies.ts';
export { BODY_DYNAMIC, BODY_KINEMATIC, BODY_SLEEPING, BODY_STATIC, BodySet } from './bodies.ts';
export { DynamicTree } from './tree.ts';
export { MAX_BODIES, PairSet, layersInteract, pairA, pairB, pairKey } from './pairs.ts';
export type { Manifold, ShapePose } from './manifold.ts';
export { MAX_CONTACTS, collideShapes, createManifold } from './manifold.ts';
export type { Parallelism, WorldOptions } from './world.ts';
export { PhysicsWorld } from './world.ts';
export {
  ContactConstraints,
  LINEAR_SLOP,
  MAX_BIAS_VELOCITY,
  RESTITUTION_THRESHOLD,
  applyRestitution,
  isDynamicBody,
  prepareContact,
  solveContacts,
  warmStart,
} from './solver.ts';
export { IslandSet } from './island.ts';
export type { FrictionModel } from './solver.ts';
export type { Executor, IslandOverlap, IslandSolver } from './executor.ts';
export { DisjointExecutor, SerialExecutor, ShuffledExecutor } from './executor.ts';
export type { IslandSolveState } from './islandSolve.ts';
export { solveIslandInto } from './islandSolve.ts';
/*
 * **The pool is not here, and its absence is the point.** `workerPool.ts` constructs its worker with
 * `new Worker(new URL(...))`, which a bundler rewrites at transform time — before tree-shaking
 * decides the pool is unreachable — so re-exporting it from this barrel wrote a 12 KB gzipped
 * worker chunk into the bundle of every consumer that merely imported `PhysicsWorld`.
 *
 * It lives at `@driftengine/physics/src/workers.ts`, which that file explains. A caller already had
 * to name `createIslandPool` at the call site for 3.54.0's own reason, so this costs a specifier.
 *
 * The *types* stay reachable from here, because a type import emits nothing and a consumer typing a
 * `PoolWorker` should not need a second specifier to do it.
 */
export type { LanePlan, StagePlan } from './stage.ts';
export type { PoolOutcome, PoolRequest, PoolWorker } from './workerPool.ts';
export type { DofMode, JointDesc, JointType } from './joints.ts';
export {
  DOF_COUNT,
  DOF_FREE,
  DOF_LIMITED,
  DOF_LOCKED,
  JOINT_CONE_TWIST,
  JOINT_DISTANCE,
  JOINT_FIXED,
  JOINT_PRISMATIC,
  JOINT_REVOLUTE,
  JOINT_SIX_DOF,
  JOINT_SPHERICAL,
  JointSet,
  resetJointImpulses,
  solveJoints,
} from './joints.ts';
export type { QueryFilter, RayHit } from './query.ts';
export { createRayHit, isStaticBody, overlapWorld, raycastWorld, shapecastWorld } from './query.ts';
export type { EventKind } from './events.ts';
export { ContactEvents, EVENT_ENTER, EVENT_EXIT, EVENT_STAY } from './events.ts';
export { BODY_SENSOR } from './bodies.ts';
export type {
  ControllerInput,
  ControllerOptions,
  ControllerState,
  GroundProbe,
} from './controller.ts';
export { AIRBORNE, CharacterController, GROUNDED, SLIDING } from './controller.ts';
export type { PoseTarget, Ragdoll, RagdollOptions } from './ragdoll.ts';
export { ragdollFromBones } from './ragdoll.ts';
export type { TyreCurve, VehicleInput, VehicleOptions, WheelOptions } from './vehicle.ts';
export { Vehicle, defaultTyreCurve, sampleTyreCurve } from './vehicle.ts';
export type { SweptState, SweptStepOptions, WorldOpinion } from './sweptStep.ts';
export { SweptStep } from './sweptStep.ts';
export type { PlanarState } from './groundMotor.ts';
export { accelerateAlong } from './groundMotor.ts';
export type { Buoyancy, BuoyancyOptions, BuoyantState } from './buoyancy.ts';
export { applyBuoyancy, createBuoyancy } from './buoyancy.ts';
export type { EscapeResult, EscapeVeto, StallEscapeOptions, StallInput } from './stallEscape.ts';
export {
  ESCAPE_EASED,
  ESCAPE_IDLE,
  ESCAPE_PUSHED,
  ESCAPE_SEALED,
  StallEscape,
} from './stallEscape.ts';
export type { ClothOptions } from './cloth.ts';
export { ClothBody, makeClothGrid } from './cloth.ts';
export type { Collider, ColliderBytes, ColliderGroup } from './colliderSet.ts';
export { ColliderSet, boxCollider, colliderFromShape } from './colliderSet.ts';
export { fingerprintBodies, fingerprintColliders } from './fingerprint.ts';
export type { MassProperties } from './mass.ts';
export { combineMassProperties, createMassProperties, shapeMassProperties } from './mass.ts';
export type { TriangleMesh } from './meshShape.ts';
export { meshShape } from './meshShape.ts';
/*
 * A heightfield as a collider: the samples, and every triangle generated from them.
 *
 * `Heightfield` is deliberately shaped so that a `Terrain` from `@driftengine/terrain` *is* one —
 * same names, same meanings — which is how a package that imports no other engine package still
 * takes one. See `heightfieldShape.ts`.
 */
export { heightfieldShape } from './heightfieldShape.ts';
export type { Heightfield } from './heightfieldShape.ts';
export type { ConvexShape } from './shape.ts';
export {
  boxShape,
  capsuleShape,
  cylinderShape,
  hullShape,
  shapeBounds,
  sphereShape,
} from './shape.ts';
/*
 * Convex decomposition: offline, and the only thing in this package that is not meant for a frame.
 *
 * Exported from the barrel because it produces `ConvexShape` point sets and belongs beside
 * `hullShape`. A consumer who never names it never bundles it — the package is `sideEffects: false`
 * and `physics-only` measures the consequence.
 */
/* A body made of several shapes: the half of convex decomposition that lives in the tick. */
export {
  MAX_BODY_PARTS,
  MAX_PAIR_MANIFOLDS,
  collideCompound,
  partsBoundRadius,
} from './compoundContact.ts';
export type { ConvexPart, Decomposition, DecomposeFill, DecomposeOptions } from './decompose.ts';
export {
  DEFAULT_MAX_HULLS,
  DEFAULT_RESOLUTION,
  MAX_RESOLUTION,
  SUPPORT_DIRECTIONS,
  decomposeConvex,
} from './decompose.ts';
