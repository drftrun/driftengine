/**
 * The wired `drift/*` surfaces other than audio, in one file because each is a table.
 *
 * A binding is a **description plus a lookup**. Nothing here is new engine code, and if a binding
 * needed the engine to grow a function, that function would belong in the package owning the
 * subsystem and this would then describe it like any other.
 *
 * **What is deliberately absent, and why**, because an empty module is a decision rather than an
 * oversight:
 *
 * - **`drift/core`.** §11 gives its provider as `startLoop` and `LoopHooks`. A script does not call
 *   those — they are what *drives* a script. There is nothing for a script to call, so the module
 *   is not registered rather than registered empty, and a target does not claim it.
 * - **`drift/xr`.** No provider: Track I is the one track nobody has taken, and the linker refuses
 *   the module by name. **Twelve names stood in this list beside it and every one of them has since
 *   been bound** — `render`, `ui`, `2d`, `terrain`, `ecs`, `prefab`, `navigation`, `behavior`,
 *   `network`, `rollback`, `editor` and `ai` — and this sentence went on calling them unprovided,
 *   because a comment listing what is missing has no guard on it and goes stale in the one
 *   direction nothing checks.
 */
import {
  type Aabb,
  ActionMap,
  CinematicCamera,
  type Collider,
  ColliderSet,
  type KeyValueStore,
  RemoteSaveStore,
  MessageQueue,
  PhysicsWorld,
  type QueuedMessage,
  type RayHit,
  SceneNode,
  type WindState,
  angleDelta,
  boxCollider,
  createRayHit,
  hashToUnit,
  mulberry32,
  wrapAngle,
} from '@driftengine/core';
import { type CapabilityDefinition, type OpaqueType, defineCapability } from 'driftscript';

export const TIME_MODULE = 'drift/time';
export const RANDOM_MODULE = 'drift/random';
export const EVENTS_MODULE = 'drift/events';
export const PERSISTENCE_MODULE = 'drift/persistence';
export const SCENE_MODULE = 'drift/scene';
export const PHYSICS_MODULE = 'drift/physics';
export const INPUT_MODULE = 'drift/input';
export const CAMERA_MODULE = 'drift/camera';

const define = (
  module: string,
  name: string,
  params: readonly { name: string; type: string }[],
  returns: string,
  effects: CapabilityDefinition['effects'],
  deterministic: boolean,
  doc: string,
): CapabilityDefinition =>
  defineCapability({
    module,
    name,
    signature: `fn(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returns}`,
    params: [...params],
    returns,
    effects,
    deterministic,
    doc,
    implementation: `${module}.${name}`,
  });

/**
 * Handles a script holds and passes back, never reads into.
 *
 * A field on any of these would be a promise about a representation the engine could then never
 * change — the design's safe-handle rule. `Node` is the one a script touches most, and it is still
 * opaque: a position is read through a capability rather than off the object.
 */
export const CORE_TYPES: readonly OpaqueType[] = [
  { module: SCENE_MODULE, name: 'Node', doc: 'A node in the transform hierarchy.' },
  /*
   * The frame's weather, already sampled. **A state and not a profile**, which is the whole of why
   * a script may read it inside the fixed step: a profile plus a clock is a wall-clock read, and a
   * `WindState` is what the field said at a time somebody else chose.
   */
  { module: SCENE_MODULE, name: 'Wind', doc: 'The wind as it was sampled this frame.' },
  {
    module: PHYSICS_MODULE,
    name: 'Colliders',
    doc: 'A set of convex colliders with a spatial hash.',
  },
  /*
   * `PhysicsWorld`, not `World`: `drift/ecs` already registers that name, and the registry refuses
   * two hosts claiming one — at registration, where somebody can act on it, rather than at a
   * resolution nobody can see. An entity world and a rigid body world are genuinely two things.
   */
  {
    module: PHYSICS_MODULE,
    name: 'PhysicsWorld',
    doc: 'A rigid body world, stepped on the fixed clock.',
  },
  {
    module: INPUT_MODULE,
    name: 'Actions',
    doc: 'A bound action map: what the player is pressing.',
  },
  { module: CAMERA_MODULE, name: 'Camera', doc: 'A cinematic camera.' },
  {
    module: EVENTS_MODULE,
    name: 'Queue',
    doc: 'A priority message queue with dedupe and a ceiling.',
  },
  { module: PERSISTENCE_MODULE, name: 'Store', doc: 'A key-value store the consumer supplied.' },
];

/**
 * `drift/time` — the loop's three clocks, and the one that is deterministic is not here.
 *
 * All three carry `clock.read`, so **none may be called from a `@deterministic` function** — and
 * that is right even for the fixed step. A simulation is *given* its delta as a parameter; a
 * simulation that reached out and read one has stopped being a function of its inputs, which is
 * what replay depends on.
 */
export const TIME_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    TIME_MODULE,
    'fixedDelta',
    [],
    'f32',
    ['clock.read'],
    false,
    'The fixed simulation step, in seconds. Prefer the `dt` your function was given.',
  ),
  define(
    TIME_MODULE,
    'frameDelta',
    [],
    'f32',
    ['clock.read'],
    false,
    'Seconds since the previous rendered frame, after clamping.',
  ),
  define(
    TIME_MODULE,
    'wallDelta',
    [],
    'f32',
    ['clock.read'],
    false,
    'Seconds of real time since the previous frame, unclamped. Outside the boundary in every sense.',
  ),
  define(
    TIME_MODULE,
    'elapsed',
    [],
    'f32',
    ['clock.read'],
    false,
    'Seconds since the loop started.',
  ),
];

/**
 * `drift/random` — a seeded generator whose sequence is **frozen**.
 *
 * Deterministic by construction, so a `@deterministic` function may call it. That is the whole
 * reason it is a capability rather than a `std/*` function: the sequence is a promise about *this
 * engine's* stored replays, and a standard library that shipped its own would either break that
 * promise or silently become the thing that defines it.
 */
export const RANDOM_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    RANDOM_MODULE,
    'unit',
    [{ name: 'seed', type: 'u32' }],
    'f32',
    ['pure'],
    true,
    'A value from 0 to 1 for a seed. The same seed always gives the same value.',
  ),
  define(
    RANDOM_MODULE,
    'range',
    [
      { name: 'seed', type: 'u32' },
      { name: 'low', type: 'f32' },
      { name: 'high', type: 'f32' },
    ],
    'f32',
    ['pure'],
    true,
    'A value between two bounds for a seed.',
  ),
  define(
    RANDOM_MODULE,
    'index',
    [
      { name: 'seed', type: 'u32' },
      { name: 'count', type: 'u32' },
    ],
    'u32',
    ['pure'],
    true,
    'An index into a collection of `count` items. Zero for an empty one.',
  ),
];

/** `drift/events` — the engine's priority queue, with dedupe over a window and a backlog ceiling. */
export const EVENTS_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    EVENTS_MODULE,
    'push',
    [
      { name: 'queue', type: 'Queue' },
      { name: 'id', type: 'String' },
      { name: 'priority', type: 'f32' },
      { name: 'holdFor', type: 'f32' },
    ],
    'void',
    ['pure'],
    true,
    'Queue a message by identity. A repeat of the same id inside the dedupe window is dropped.',
  ),
  define(
    EVENTS_MODULE,
    'current',
    [{ name: 'queue', type: 'Queue' }],
    'String?',
    ['pure'],
    true,
    "The id of the message showing now, if any. The queue carries identity and priority; the words are the consumer's.",
  ),
  define(
    EVENTS_MODULE,
    'clear',
    [{ name: 'queue', type: 'Queue' }],
    'void',
    ['pure'],
    true,
    'Drop everything queued.',
  ),
];

/** `drift/persistence` — the store the consumer supplied, which may be a browser, a server or nothing. */
export const PERSISTENCE_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    PERSISTENCE_MODULE,
    'read',
    [
      { name: 'store', type: 'Store' },
      { name: 'key', type: 'String' },
    ],
    'String?',
    ['persistence.read'],
    false,
    'What is stored under a key. Absent when nothing is, which is ordinary rather than exceptional.',
  ),
  define(
    PERSISTENCE_MODULE,
    'write',
    [
      { name: 'store', type: 'Store' },
      { name: 'key', type: 'String' },
      { name: 'value', type: 'String' },
    ],
    'void',
    ['persistence.write'],
    false,
    'Store a value under a key.',
  ),
  define(
    PERSISTENCE_MODULE,
    'remove',
    [
      { name: 'store', type: 'Store' },
      { name: 'key', type: 'String' },
    ],
    'void',
    ['persistence.write'],
    false,
    'Forget a key.',
  ),
  /*
   * **The two a script needs when the store answers later, and the one it cannot have.**
   *
   * A `RemoteSaveStore` writes into a queue that drains behind the synchronous surface, so a write
   * that reads back correctly may not have landed anywhere. A script drawing a "saving" indicator
   * has to be able to ask. Both answer honestly for a *synchronous* store too — a browser store
   * has nothing pending and is always idle — so this is not a capability that only works for one
   * implementation.
   *
   * **`flush` is not bound**, and the reason is the language rather than the engine: it answers a
   * promise and DriftScript has no await, so a binding would either block or hand back something
   * a script cannot hold. A consumer flushes from TypeScript, at the one place it knows it is
   * leaving.
   */
  define(
    PERSISTENCE_MODULE,
    'saveStatus',
    [{ name: 'store', type: 'Store' }],
    'String',
    ['persistence.read'],
    false,
    'Whether writes have landed: `idle`, `pending`, `saving` or `failed`. A store that writes synchronously is always `idle`, which is the true answer rather than a stub.',
  ),
  define(
    PERSISTENCE_MODULE,
    'pendingSaves',
    [{ name: 'store', type: 'Store' }],
    'u32',
    ['persistence.read'],
    false,
    'How many keys are waiting to reach the backend. Zero for a store that writes synchronously.',
  ),
];

/**
 * `drift/scene` — the transform hierarchy from Phase 1.1.
 *
 * Reads are deterministic and writes are not, which is the boundary drawn per capability rather
 * than per module. A simulation may ask where something is; moving it is a change to the world.
 */
export const SCENE_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    SCENE_MODULE,
    'positionX',
    [{ name: 'node', type: 'Node' }],
    'f32',
    ['scene.read'],
    true,
    "A node's local x.",
  ),
  define(
    SCENE_MODULE,
    'positionY',
    [{ name: 'node', type: 'Node' }],
    'f32',
    ['scene.read'],
    true,
    "A node's local y.",
  ),
  define(
    SCENE_MODULE,
    'positionZ',
    [{ name: 'node', type: 'Node' }],
    'f32',
    ['scene.read'],
    true,
    "A node's local z.",
  ),
  define(
    SCENE_MODULE,
    'setPosition',
    [
      { name: 'node', type: 'Node' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'z', type: 'f32' },
    ],
    'void',
    ['scene.write'],
    false,
    'Move a node, marking it and its subtree for a world update.',
  ),
  define(
    SCENE_MODULE,
    'setScale',
    [
      { name: 'node', type: 'Node' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'z', type: 'f32' },
    ],
    'void',
    ['scene.write'],
    false,
    'Scale a node.',
  ),
  define(
    SCENE_MODULE,
    'setRotation',
    [
      { name: 'node', type: 'Node' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'z', type: 'f32' },
      { name: 'radians', type: 'f32' },
    ],
    'void',
    ['scene.write'],
    false,
    'Rotate a node about an axis.',
  ),
  /*
   * **The wind, read by a behaviour rather than by the renderer.**
   *
   * The per-vertex channel bends geometry to this same wind in the vertex stage; these four let a
   * script ask the question a behaviour asks — take shelter in a gust, luff a sail, turn downwind.
   *
   * **Deterministic, and that is a claim rather than a convenience.** `wind.ts` builds the signal
   * as a fundamental plus integer harmonics, repeating exactly at the fundamental's period,
   * precisely so a replay watched an hour later sees the gust the original run saw. A non-integer
   * harmonic would look organic and never close, and these would then be reading a wall clock
   * through a handle. The comment in that file is the thing holding this up.
   *
   * **`f32` and not `float`**, which every capability here takes: `float` is width-polymorphic and
   * one returning it must also take one, or `defineCapability` throws. These take a `Wind`.
   */
  define(
    SCENE_MODULE,
    'windDirectionX',
    [{ name: 'wind', type: 'Wind' }],
    'f32',
    ['scene.read'],
    true,
    "The prevailing wind's x, normalised; zero when there is no wind to have a direction.",
  ),
  define(
    SCENE_MODULE,
    'windDirectionZ',
    [{ name: 'wind', type: 'Wind' }],
    'f32',
    ['scene.read'],
    true,
    "The prevailing wind's z, normalised; zero when there is no wind to have a direction.",
  ),
  define(
    SCENE_MODULE,
    'windSpeed',
    [{ name: 'wind', type: 'Wind' }],
    'f32',
    ['scene.read'],
    true,
    'How hard it is blowing, metres a second, never negative.',
  ),
  define(
    SCENE_MODULE,
    'windGust',
    [{ name: 'wind', type: 'Wind' }],
    'f32',
    ['scene.read'],
    true,
    'The gust alone, -1 to 1, for a behaviour that wants the deviation and not the total.',
  ),
  define(
    SCENE_MODULE,
    'distance',
    [
      { name: 'a', type: 'Node' },
      { name: 'b', type: 'Node' },
    ],
    'f32',
    ['scene.read'],
    true,
    'The distance between two nodes, in local space.',
  ),
];

/**
 * `drift/physics` — bodies, contacts, queries and forces. **Not joints, not the controller and not
 * ragdolls**, which is what this line said until 2026-08-27 and what none of the thirty-six
 * capabilities below has ever done.
 *
 * **This module was two read-only functions until 2026-08-26**, and its own comment said why: there
 * was no solver to write into, and a capability that pretended otherwise would have been the mock
 * the design refused. Track B built the solver, so the surface is real — but the sentence that
 * announced it was written from the *track's* deliverables rather than from this list, which is the
 * same failure as a binding written from memory of what a camera ought to have. A reader looking
 * for `joint` here found a comment that promised one.
 *
 * **Six of the thirty-six are `nearestWithin` and its accessors, added 2026-08-28**, and they exist
 * because a consumer reported that `anyWithin` answers *whether* and never *what*. A script could
 * already find the nearest entity — `drift/ecs` grew `findNearest` and `nearest` for that — and
 * could not find the nearest wall, so what is in reach of a character was decided in TypeScript.
 *
 * **The two `within` questions measure different volumes, and the names cannot say so on their
 * own.** `anyWithin` tests the axis-aligned *box* around the sphere, because that is what the
 * collider hash indexes and testing anything narrower would cost a pass it does not need for a
 * yes-or-no. `nearestWithin` is already walking each candidate to rank it, so it measures the
 * sphere exactly and answers false where `anyWithin` answers true — a collider that reaches only
 * the box corners. Both say which they do, on themselves, because a reader comparing the two names
 * would have no reason to suspect it.
 *
 * **It measures to a collider's bounds rather than to the shape inside them**, which is the one
 * place this surface is coarser than the sweep beside it. `ColliderSet`'s own header draws that
 * line: the bounds are the broad phase and the shape resolves a contact, so a proximity answer that
 * ran the convex sweep per candidate per frame would be paying contact prices for a distance. The
 * documentation on each accessor says bounds, so nobody reads a banked slab's box as its surface.
 *
 * **What is missing, and the design question that is why it is still missing**: `JointDesc` carries
 * twenty optional fields, so a script-side constructor is either an enormous signature or a builder
 * this language has no shape for. That is a decision somebody has to take deliberately, and taking
 * it badly would put a wrong-by-construction surface in front of every script author. Recorded here
 * rather than guessed at.
 *
 * **Two parameters are required here that TypeScript leaves optional**, which is step four of the
 * note at the top of `host.ts`, and both are the same shape of trap — an omission that produces a
 * *wrong result* rather than an error:
 *
 * - **A raycast's layer mask.** Omitted, the first thing a ray finds is very often the body it
 *   started inside, because `raycastWorld` reports that body at fraction zero deliberately. A
 *   TypeScript caller has the context to know when that matters; a script author meets it first and
 *   reads it as the engine seeing through walls.
 * - **An impulse's application point.** Omitted, the impulse goes through the centre of mass and
 *   produces no rotation whatever. Nothing throws; a crate simply slides instead of tumbling, which
 *   reads as a broken impulse rather than as a missing argument.
 *
 * **Every body and event index is `i32`, not `u32`.** `hitBody` has to be able to answer −1, and a
 * script has no cast, so a mixed surface would make the obvious code — raycast, check the body,
 * apply an impulse to it — impossible to write. One signed type throughout costs nothing and is
 * what a query result already is.
 *
 * **A raycast's result is read back through separate accessors**, in the same shape `input.axisX`
 * and `input.axisY` already use for a vector. A script has no way to receive an engine record, and
 * inventing a flattened signature would drift from the real one the first time a hit gains a field —
 * which is the reasoning `drift/camera` gives for leaving `cut` out. *What it costs* is that a hit
 * is only valid until the next `raycast` on the same world, and the documentation says so on every
 * accessor.
 */
export const PHYSICS_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    PHYSICS_MODULE,
    'colliderCount',
    [{ name: 'colliders', type: 'Colliders' }],
    'u32',
    ['physics.read'],
    true,
    'How many colliders a set holds.',
  ),
  define(
    PHYSICS_MODULE,
    'colliderCapacity',
    [{ name: 'colliders', type: 'Colliders' }],
    'u32',
    ['physics.read'],
    true,
    'How many slots the set has allocated, live or not. Equal to `colliderCount` until a group is removed; after that the live colliders are sparse within it.',
  ),
  define(
    PHYSICS_MODULE,
    'colliderBytes',
    [{ name: 'colliders', type: 'Colliders' }],
    'u32',
    ['physics.read'],
    true,
    'What the set costs in memory, in bytes. The slots and shapes are exact; the spatial index includes an estimate of per-object overhead a JavaScript engine does not expose.',
  ),
  /*
   * **A builder rather than one call, because a script has no list to hand across.** A region is
   * many boxes and one group, so a per-box call returning a group would mint one group per box and
   * give a streamer nothing to drop.
   *
   * **`end` returns the handle, not `begin`.** The group does not exist until the boxes are in, and
   * a handle issued before that would be a promise the binding could only keep by inventing an id
   * the engine had not minted.
   */
  define(
    PHYSICS_MODULE,
    'beginColliderGroup',
    [{ name: 'colliders', type: 'Colliders' }],
    'void',
    ['physics.write'],
    false,
    'Open a group. Add boxes with `addColliderBox`, then `endColliderGroup` to put them in and get the handle back.',
  ),
  define(
    PHYSICS_MODULE,
    'addColliderBox',
    [
      { name: 'colliders', type: 'Colliders' },
      { name: 'cx', type: 'f32' },
      { name: 'cy', type: 'f32' },
      { name: 'cz', type: 'f32' },
      { name: 'hx', type: 'f32' },
      { name: 'hy', type: 'f32' },
      { name: 'hz', type: 'f32' },
    ],
    'void',
    ['physics.write'],
    false,
    'A box in the open group, by centre and half-extents — the same numbers a mesh builder takes, so nothing is authored twice. Nothing is queryable until `endColliderGroup`.',
  ),
  define(
    PHYSICS_MODULE,
    'endColliderGroup',
    [{ name: 'colliders', type: 'Colliders' }],
    'u32',
    ['physics.write'],
    false,
    'Put the open group into the set and return the handle that drops it again. Keep the handle: it is the only way to remove those colliders.',
  ),
  define(
    PHYSICS_MODULE,
    'removeColliderGroup',
    [
      { name: 'colliders', type: 'Colliders' },
      { name: 'group', type: 'u32' },
    ],
    'void',
    ['physics.write'],
    false,
    'Drop a group and everything in it. Refuses a handle the set does not hold, and refuses the colliders the set was constructed with — a set meant to stream is constructed empty.',
  ),
  define(
    PHYSICS_MODULE,
    'anyWithin',
    [
      { name: 'colliders', type: 'Colliders' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'z', type: 'f32' },
      { name: 'radius', type: 'f32' },
    ],
    'bool',
    ['physics.read'],
    true,
    'Whether any collider overlaps the *box* around a sphere. The cheapest answer there is, and it over-reports a collider that only reaches the box corners. `nearestWithin` measures the sphere.',
  ),
  define(
    PHYSICS_MODULE,
    'nearestWithin',
    [
      { name: 'colliders', type: 'Colliders' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'z', type: 'f32' },
      { name: 'radius', type: 'f32' },
    ],
    'bool',
    ['physics.read'],
    true,
    'Find the closest collider within a radius and record it. Read the result with the `near` functions. Valid until the next `nearestWithin` on this set.',
  ),
  define(
    PHYSICS_MODULE,
    'nearCollider',
    [{ name: 'colliders', type: 'Colliders' }],
    'i32',
    ['physics.read'],
    true,
    'The collider the last `nearestWithin` on this set found, or \u22121.',
  ),
  define(
    PHYSICS_MODULE,
    'nearX',
    [{ name: 'colliders', type: 'Colliders' }],
    'f32',
    ['physics.read'],
    true,
    'The closest point on that collider\u2019s bounds, along x \u2014 the point on the wall rather than the wall\u2019s centre.',
  ),
  define(
    PHYSICS_MODULE,
    'nearY',
    [{ name: 'colliders', type: 'Colliders' }],
    'f32',
    ['physics.read'],
    true,
    'The closest point on that collider\u2019s bounds, along y.',
  ),
  define(
    PHYSICS_MODULE,
    'nearZ',
    [{ name: 'colliders', type: 'Colliders' }],
    'f32',
    ['physics.read'],
    true,
    'The closest point on that collider\u2019s bounds, along z.',
  ),
  define(
    PHYSICS_MODULE,
    'nearDistance',
    [{ name: 'colliders', type: 'Colliders' }],
    'f32',
    ['physics.read'],
    true,
    'How far that collider\u2019s bounds are, in metres. Zero when the query point is inside them.',
  ),

  define(
    PHYSICS_MODULE,
    'bodyCount',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'i32',
    ['physics.read'],
    true,
    'How many bodies the world holds.',
  ),
  define(
    PHYSICS_MODULE,
    'bodyX',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'f32',
    ['physics.read'],
    true,
    "A body's world position along x.",
  ),
  define(
    PHYSICS_MODULE,
    'bodyY',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'f32',
    ['physics.read'],
    true,
    "A body's world position along y.",
  ),
  define(
    PHYSICS_MODULE,
    'bodyZ',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'f32',
    ['physics.read'],
    true,
    "A body's world position along z.",
  ),
  define(
    PHYSICS_MODULE,
    'bodyVelX',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'f32',
    ['physics.read'],
    true,
    "A body's velocity along x, in metres per second.",
  ),
  define(
    PHYSICS_MODULE,
    'bodyVelY',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'f32',
    ['physics.read'],
    true,
    "A body's velocity along y, in metres per second.",
  ),
  define(
    PHYSICS_MODULE,
    'bodyVelZ',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'f32',
    ['physics.read'],
    true,
    "A body's velocity along z, in metres per second.",
  ),
  define(
    PHYSICS_MODULE,
    'bodyMass',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'f32',
    ['physics.read'],
    true,
    "A body's mass in kilograms, or zero where it has none because it is static or kinematic.",
  ),
  define(
    PHYSICS_MODULE,
    'sleeping',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'bool',
    ['physics.read'],
    true,
    'Whether a body has been still long enough to stop being solved.',
  ),

  define(
    PHYSICS_MODULE,
    'raycast',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'z', type: 'f32' },
      { name: 'dx', type: 'f32' },
      { name: 'dy', type: 'f32' },
      { name: 'dz', type: 'f32' },
      { name: 'maxDistance', type: 'f32' },
      { name: 'mask', type: 'i32' },
    ],
    'bool',
    ['physics.read'],
    true,
    'Cast a ray and record what it hit. `mask` is required: without one the first thing a ray finds is often the body it started inside. Read the result with the `hit` functions.',
  ),
  define(
    PHYSICS_MODULE,
    'hitBody',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'i32',
    ['physics.read'],
    true,
    'The body the last `raycast` on this world found, or −1. Valid until the next raycast.',
  ),
  define(
    PHYSICS_MODULE,
    'hitX',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'f32',
    ['physics.read'],
    true,
    'Where the last raycast struck, along x. Valid until the next raycast.',
  ),
  define(
    PHYSICS_MODULE,
    'hitY',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'f32',
    ['physics.read'],
    true,
    'Where the last raycast struck, along y. Valid until the next raycast.',
  ),
  define(
    PHYSICS_MODULE,
    'hitZ',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'f32',
    ['physics.read'],
    true,
    'Where the last raycast struck, along z. Valid until the next raycast.',
  ),
  define(
    PHYSICS_MODULE,
    'hitNormalX',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'f32',
    ['physics.read'],
    true,
    'The surface normal the last raycast struck, along x.',
  ),
  define(
    PHYSICS_MODULE,
    'hitNormalY',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'f32',
    ['physics.read'],
    true,
    'The surface normal the last raycast struck, along y.',
  ),
  define(
    PHYSICS_MODULE,
    'hitNormalZ',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'f32',
    ['physics.read'],
    true,
    'The surface normal the last raycast struck, along z.',
  ),
  define(
    PHYSICS_MODULE,
    'hitFraction',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'f32',
    ['physics.read'],
    true,
    'How far along the ray the last hit was, from 0 to 1.',
  ),

  define(
    PHYSICS_MODULE,
    'contactCount',
    [{ name: 'world', type: 'PhysicsWorld' }],
    'i32',
    ['physics.read'],
    true,
    'How many contact events the last step produced. Drain them after stepping, never during.',
  ),
  define(
    PHYSICS_MODULE,
    'contactKind',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'index', type: 'i32' },
    ],
    'i32',
    ['physics.read'],
    true,
    "An event's kind: 0 entered, 1 still touching, 2 left.",
  ),
  define(
    PHYSICS_MODULE,
    'contactA',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'index', type: 'i32' },
    ],
    'i32',
    ['physics.read'],
    true,
    'The lower-indexed body of a contact event.',
  ),
  define(
    PHYSICS_MODULE,
    'contactB',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'index', type: 'i32' },
    ],
    'i32',
    ['physics.read'],
    true,
    'The higher-indexed body of a contact event.',
  ),

  define(
    PHYSICS_MODULE,
    'applyImpulse',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
      { name: 'px', type: 'f32' },
      { name: 'py', type: 'f32' },
      { name: 'pz', type: 'f32' },
      { name: 'atX', type: 'f32' },
      { name: 'atY', type: 'f32' },
      { name: 'atZ', type: 'f32' },
    ],
    'void',
    ['physics.write'],
    false,
    'Apply an impulse at a world point. The point is required: through the centre of mass an impulse produces no rotation at all, which reads as a broken impulse rather than a missing argument.',
  ),
  define(
    PHYSICS_MODULE,
    'applyForce',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
      { name: 'fx', type: 'f32' },
      { name: 'fy', type: 'f32' },
      { name: 'fz', type: 'f32' },
      { name: 'dt', type: 'f32' },
      { name: 'atX', type: 'f32' },
      { name: 'atY', type: 'f32' },
      { name: 'atZ', type: 'f32' },
    ],
    'void',
    ['physics.write'],
    false,
    'A force applied for one step, which is an impulse of force times dt. The point is required for the same reason.',
  ),
  define(
    PHYSICS_MODULE,
    'setVelocity',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
      { name: 'vx', type: 'f32' },
      { name: 'vy', type: 'f32' },
      { name: 'vz', type: 'f32' },
    ],
    'void',
    ['physics.write'],
    false,
    "Set a body's velocity outright, waking its island.",
  ),
  define(
    PHYSICS_MODULE,
    'setPosition',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'z', type: 'f32' },
    ],
    'void',
    ['physics.write'],
    false,
    'Move a body outright. A teleport rather than a push: the broadphase moves with it.',
  ),
  define(
    PHYSICS_MODULE,
    'wake',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'body', type: 'i32' },
    ],
    'void',
    ['physics.write'],
    false,
    'Wake a body and everything sharing its island, because a sleeping neighbour would settle it again.',
  ),
  define(
    PHYSICS_MODULE,
    'setGravity',
    [
      { name: 'world', type: 'PhysicsWorld' },
      { name: 'x', type: 'f32' },
      { name: 'y', type: 'f32' },
      { name: 'z', type: 'f32' },
    ],
    'void',
    ['physics.write'],
    false,
    "The world's gravity, in metres per second squared.",
  ),
];

/** `drift/input` — Track H, complete: action maps, rebinding, gamepad, pointer and touch. */
export const INPUT_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    INPUT_MODULE,
    'down',
    [
      { name: 'actions', type: 'Actions' },
      { name: 'action', type: 'String' },
    ],
    'bool',
    ['input.read'],
    false,
    'Whether an action is held.',
  ),
  define(
    INPUT_MODULE,
    'pressed',
    [
      { name: 'actions', type: 'Actions' },
      { name: 'action', type: 'String' },
    ],
    'bool',
    ['input.read'],
    false,
    'Whether an action went down this frame.',
  ),
  define(
    INPUT_MODULE,
    'axisX',
    [
      { name: 'actions', type: 'Actions' },
      { name: 'action', type: 'String' },
    ],
    'f32',
    ['input.read'],
    false,
    "A directional action's horizontal component, shortened to the rim with the vertical one so a keyboard diagonal is not faster than a straight line. For two independent controls such as throttle and steering, read rawAxisX instead.",
  ),
  define(
    INPUT_MODULE,
    'axisY',
    [
      { name: 'actions', type: 'Actions' },
      { name: 'action', type: 'String' },
    ],
    'f32',
    ['input.read'],
    false,
    "A directional action's vertical component, shortened to the rim with the horizontal one. For two independent controls, read rawAxisY instead.",
  ),
  /*
   * **The pair that is not normalised, and the reason both pairs exist.** `axisX` and `axisY` treat
   * an action's two axes as one direction, which is right on foot and wrong at a wheel: throttle
   * and steering are two controls that happen to share an action, and dividing both by √2 means a
   * driver holding forward and left can never reach full lock while accelerating. A consumer lost
   * two weeks to that in TypeScript before anybody looked at `ActionMap.vector`, and a script
   * author reading `axisX` would have met it identically, because this binding calls that method.
   *
   * Added rather than corrected in place: `axisX` behaves as it always has, because changing what
   * it returns would make every scripted character quietly faster on a diagonal.
   */
  define(
    INPUT_MODULE,
    'rawAxisX',
    [
      { name: 'actions', type: 'Actions' },
      { name: 'action', type: 'String' },
    ],
    'f32',
    ['input.read'],
    false,
    "An action's horizontal axis on its own, not shortened against the vertical one. This is what a throttle or a steering input wants: holding two keys gives a full 1 on each.",
  ),
  define(
    INPUT_MODULE,
    'rawAxisY',
    [
      { name: 'actions', type: 'Actions' },
      { name: 'action', type: 'String' },
    ],
    'f32',
    ['input.read'],
    false,
    "An action's vertical axis on its own, not shortened against the horizontal one.",
  ),
  /*
   * **Rumble answers a boolean and a script has to read it**, which is the whole reason this row
   * exists in the shape it does. Most pads on most browsers have no motors, so a settings screen
   * that offers the control unconditionally is offering something a player's hardware ignores. The
   * host layer answers false rather than accepting the call and doing nothing quietly, and these
   * three carry that answer across the language boundary unchanged.
   *
   * `input.write` does not exist as an effect and this does not invent one: driving a motor is a
   * write to the *host*, which is what `host` already means, and it is outside the deterministic
   * boundary for the same reason `audio.write` is — a replay must not be able to tell whether the
   * player's pad was plugged in.
   */
  define(
    INPUT_MODULE,
    'canRumble',
    [{ name: 'actions', type: 'Actions' }],
    'bool',
    ['host'],
    false,
    'Whether the pad these actions read has motors this browser can drive. Grey the control out when it is false; most pads on most browsers cannot.',
  ),
  define(
    INPUT_MODULE,
    'rumble',
    [
      { name: 'actions', type: 'Actions' },
      { name: 'durationMs', type: 'f32' },
      { name: 'strong', type: 'f32' },
      { name: 'weak', type: 'f32' },
    ],
    'bool',
    ['host'],
    false,
    'Rumble for a duration in milliseconds, at two magnitudes in [0, 1]: `strong` is the low-frequency motor and `weak` the high-frequency one. Answers whether the platform took it; false is a real answer, not an error.',
  ),
  define(
    INPUT_MODULE,
    'stopRumble',
    [{ name: 'actions', type: 'Actions' }],
    'bool',
    ['host'],
    false,
    'Stop whatever that pad is playing. Answers whether the platform took it.',
  ),
];

/**
 * `drift/camera` — the cinematic cameras, and **only what they actually have**.
 *
 * The first version of this binding described `lookAt` and `setPosition`. `CinematicCamera` has
 * neither: it has `cut`, `snap`, `shotAgeSec` and `update`. The implementation reached them through
 * an optional-call cast, so a script calling `camera.lookAt(…)` compiled, linked, ran, and did
 * **nothing** — the silent no-op this repository's rules forbid, arriving by way of a binding
 * written from memory of what a camera ought to have rather than from the class.
 *
 * `cut` is deliberately still absent: it takes a `ShotParams`, and a script has no way to construct
 * an engine record yet. Binding it would mean inventing a flattened signature that drifts from the
 * real one the first time a shot gains a field. It waits for a way to express the record.
 */
export const CAMERA_CAPABILITIES: readonly CapabilityDefinition[] = [
  define(
    CAMERA_MODULE,
    'snap',
    [{ name: 'camera', type: 'Camera' }],
    'void',
    ['scene.write'],
    false,
    'Jump the camera to where it is heading, skipping the ease. What a scene cut needs.',
  ),
  define(
    CAMERA_MODULE,
    'shotAge',
    [{ name: 'camera', type: 'Camera' }],
    'f32',
    ['scene.read'],
    true,
    'Seconds since the current shot began. A read, so a deterministic function may ask.',
  ),
];

/** How the runtime represents an option. Matches what the compiler generates. */
type Option<T> = { readonly tag: 'some'; readonly value: T } | { readonly tag: 'none' };
const some = <T>(value: T): Option<T> => ({ tag: 'some', value });
const none: Option<never> = { tag: 'none' };

/** What a host must supply for each module it wants to provide. */
export interface CoreServices {
  readonly clocks?: {
    fixedDelta(): number;
    frameDelta(): number;
    wallDelta(): number;
    elapsed(): number;
  };
  readonly store?: KeyValueStore;
  readonly queue?: MessageQueue<QueuedMessage>;
  readonly actions?: ActionMap;
}

/**
 * Round a double to the nearest single, because every signature in this file is declared `f32`.
 *
 * **Still correct at language 1.5.0, and the reason is worth writing down beside it.** That release
 * introduced a `float` type meaning "`f32` or `f64`, the same one throughout the call", and moved
 * `std/math`'s rounding out of its implementations to the call site — because a library that
 * rounded every result would be destroying precision the moment a call resolved to double. The
 * language's own note to hosts is therefore: implement a `float` capability once, in double, and do
 * **not** round; and rounding stays right for a signature left written `f32`.
 *
 * Every capability here is written `f32` and none is written `float`, so this is the second case
 * and it is unchanged. **What would make it wrong** is somebody widening one of these signatures to
 * `float` and leaving the call here — at which point a double-precision call would be silently
 * narrowed by the host after the compiler had promised it would not be.
 */
const f = Math.fround;

export function timeImplementation(
  clocks: NonNullable<CoreServices['clocks']>,
): Record<string, unknown> {
  return {
    fixedDelta: () => f(clocks.fixedDelta()),
    frameDelta: () => f(clocks.frameDelta()),
    wallDelta: () => f(clocks.wallDelta()),
    elapsed: () => f(clocks.elapsed()),
  };
}

/**
 * The seeded generator, dispatching to core's frozen sequence.
 *
 * `index` returns 0 for an empty collection rather than an error, because "pick from nothing" has
 * one sane answer and a script asking is usually mid-way through a list that will have items next
 * frame.
 */
export function randomImplementation(): Record<string, unknown> {
  return {
    unit: (seed: number) => f(hashToUnit(seed)),
    range: (seed: number, low: number, high: number) => f(low + hashToUnit(seed) * (high - low)),
    index: (seed: number, count: number) =>
      count <= 0 ? 0 : Math.floor(hashToUnit(seed) * count) % count,
  };
}

export function eventsImplementation(): Record<string, unknown> {
  return {
    push(queue: MessageQueue<QueuedMessage>, id: string, priority: number, holdFor: number) {
      /* `holdFor` arrives in seconds because units erase to the base unit, and the queue counts in
         milliseconds. Converting here rather than exposing milliseconds to a script keeps every
         duration in the language one kind of number. */
      queue.push({ id, priority, durationMs: holdFor * 1000 });
    },
    current(queue: MessageQueue<QueuedMessage>): Option<string> {
      const message = queue.current;
      return message === null ? none : some(message.id);
    },
    clear(queue: MessageQueue<QueuedMessage>) {
      queue.clear();
    },
  };
}

export function persistenceImplementation(): Record<string, unknown> {
  return {
    read(store: KeyValueStore, key: string): Option<string> {
      const value = store.read(key);
      /* `null` becomes `none`, which is the whole reason this is a capability rather than a direct
         call: the language has no null, so the boundary is where one stops existing. */
      return value === null ? none : some(value);
    },
    write(store: KeyValueStore, key: string, value: string) {
      store.write(key, value);
    },
    remove(store: KeyValueStore, key: string) {
      store.remove(key);
    },
    /* `instanceof` rather than a duck-typed property check: a store that happens to carry a
       `status` field meaning something else would otherwise be read as this one. */
    saveStatus: (store: KeyValueStore) =>
      store instanceof RemoteSaveStore ? store.status : 'idle',
    pendingSaves: (store: KeyValueStore) => (store instanceof RemoteSaveStore ? store.pending : 0),
  };
}

export function sceneImplementation(): Record<string, unknown> {
  return {
    positionX: (node: SceneNode) => f(node.position[0]),
    positionY: (node: SceneNode) => f(node.position[1]),
    positionZ: (node: SceneNode) => f(node.position[2]),
    setPosition: (node: SceneNode, x: number, y: number, z: number) => node.setPosition(x, y, z),
    setScale: (node: SceneNode, x: number, y: number, z: number) => node.setScale(x, y, z),
    setRotation: (node: SceneNode, x: number, y: number, z: number, radians: number) =>
      node.setRotationAxisAngle(x, y, z, radians),
    /* Normalised on the way out rather than stored that way: `WindState` carries a velocity, and
       a direction is what a behaviour asks for. Zero speed has no direction, and zero is the
       honest answer rather than a NaN from dividing by it. */
    windDirectionX: (wind: WindState) => f(wind.speed > 1e-5 ? wind.velocityX / wind.speed : 0),
    windDirectionZ: (wind: WindState) => f(wind.speed > 1e-5 ? wind.velocityZ / wind.speed : 0),
    windSpeed: (wind: WindState) => f(wind.speed),
    windGust: (wind: WindState) => f(wind.gust),
    distance: (a: SceneNode, b: SceneNode) => {
      const dx = a.position[0] - b.position[0];
      const dy = a.position[1] - b.position[1];
      const dz = a.position[2] - b.position[2];
      return f(Math.sqrt(dx * dx + dy * dy + dz * dz));
    },
  };
}

export function physicsImplementation(): Record<string, unknown> {
  /* One scratch buffer, reused. `query` writes indices into an out-parameter and returns how many
     it wrote, so a fresh array per call would allocate on a path a script runs every frame — which
     is the rule the whole engine is built on. Sized generously; a broad-phase answer only needs to
     know whether the count was non-zero. */
  const hits = new Int32Array(256);
  /*
   * The last raycast, per world, held **here rather than on the engine**.
   *
   * A script cannot receive a record, so a hit is read back through accessors — and putting the
   * state in the binding keeps `PhysicsWorld` free of a field that exists only because of a
   * language limitation. A `WeakMap` rather than one shared slot, because two worlds are two
   * questions and a shared slot would let one answer the other's.
   */
  const lastHit = new WeakMap<PhysicsWorld, RayHit>();
  const hitOf = (world: PhysicsWorld): RayHit => {
    let hit = lastHit.get(world);
    if (!hit) {
      hit = createRayHit();
      lastHit.set(world, hit);
    }
    return hit;
  };
  const filter = { mask: 0xffffffff };

  /*
   * The last `nearestWithin`, per collider set, in the same shape and for the same reasons.
   *
   * A consumer reported the gap this closes: `anyWithin` answered *whether* something was near and
   * never *what*, so a script could find the nearest person through `drift/ecs` and could not find
   * the nearest wall at all — and the rule for what is in reach moved into TypeScript, which is
   * exactly the rule somebody wants to edit with the game running.
   *
   * **The answer is a search plus accessors rather than a value**, which is the third time this
   * file has drawn that conclusion — `raycast` with its `hit` functions, `findNearest` with
   * `nearest`, and now this. A script cannot receive a record, and returning an option would
   * allocate one object per call on a path an agent runs every frame.
   */
  const lastNear = new WeakMap<
    ColliderSet,
    {
      collider: number;
      distance: number;
      x: number;
      y: number;
      z: number;
    }
  >();
  const nearOf = (colliders: ColliderSet) => {
    let near = lastNear.get(colliders);
    if (!near) {
      near = { collider: -1, distance: 0, x: 0, y: 0, z: 0 };
      lastNear.set(colliders, near);
    }
    return near;
  };
  /* One reused box for the scan, because `bounds` writes into a caller's object and a fresh one
     per candidate is the per-frame allocation the engine forbids. */
  const box: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  /*
   * The boxes of a group being built, per set. A `WeakMap` for the same reason `nearOf` uses one:
   * two sets are two builders, and a shared slot would let one set's region land in the other.
   */
  const pending = new WeakMap<ColliderSet, Collider[]>();

  return {
    colliderCount: (colliders: ColliderSet) => colliders.count,
    colliderCapacity: (colliders: ColliderSet) => colliders.capacity,
    colliderBytes: (colliders: ColliderSet) => colliders.bytes().total,
    beginColliderGroup(colliders: ColliderSet): void {
      if (pending.has(colliders)) {
        throw new Error(
          'beginColliderGroup: a group is already open on this set. Close it with ' +
            '`endColliderGroup` before opening another.',
        );
      }
      pending.set(colliders, []);
    },
    addColliderBox(
      colliders: ColliderSet,
      cx: number,
      cy: number,
      cz: number,
      hx: number,
      hy: number,
      hz: number,
    ): void {
      const open = pending.get(colliders);
      if (open === undefined) {
        throw new Error(
          'addColliderBox: no group is open on this set. Call `beginColliderGroup` first.',
        );
      }
      open.push(boxCollider(cx, cy, cz, hx, hy, hz));
    },
    endColliderGroup(colliders: ColliderSet): number {
      const open = pending.get(colliders);
      if (open === undefined) {
        throw new Error('endColliderGroup: no group is open on this set.');
      }
      pending.delete(colliders);
      return colliders.add(open);
    },
    removeColliderGroup(colliders: ColliderSet, group: number): void {
      colliders.remove(group);
    },
    anyWithin(colliders: ColliderSet, x: number, y: number, z: number, radius: number): boolean {
      const found = colliders.query(
        x - radius,
        y - radius,
        z - radius,
        x + radius,
        y + radius,
        z + radius,
        hits,
      );
      return found > 0;
    },
    nearestWithin(
      colliders: ColliderSet,
      x: number,
      y: number,
      z: number,
      radius: number,
    ): boolean {
      const near = nearOf(colliders);
      near.collider = -1;
      near.distance = 0;
      near.x = 0;
      near.y = 0;
      near.z = 0;

      const found = colliders.query(
        x - radius,
        y - radius,
        z - radius,
        x + radius,
        y + radius,
        z + radius,
        hits,
      );

      let best = radius * radius;
      for (let i = 0; i < found; i += 1) {
        const index = hits[i] as number;
        colliders.bounds(index, box);
        /* The closest point on the box, which is the clamp and nothing more. Inside it, the clamp
           is the query point itself and the distance is zero — which is the right answer for a
           character standing in a wall and the one a square root would also give. */
        const px = x < box.minX ? box.minX : x > box.maxX ? box.maxX : x;
        const py = y < box.minY ? box.minY : y > box.maxY ? box.maxY : y;
        const pz = z < box.minZ ? box.minZ : z > box.maxZ ? box.maxZ : z;
        const dx = px - x;
        const dy = py - y;
        const dz = pz - z;
        const squared = dx * dx + dy * dy + dz * dz;
        /* Squared throughout the scan and rooted once at the end: the comparison is the same and
           this runs over every candidate the hash returned, every frame an agent looks around. */
        if (squared > best) continue;
        best = squared;
        near.collider = index;
        near.distance = squared;
        near.x = px;
        near.y = py;
        near.z = pz;
      }

      if (near.collider < 0) return false;
      near.distance = Math.sqrt(near.distance);
      return true;
    },
    nearCollider: (colliders: ColliderSet) => nearOf(colliders).collider,
    nearX: (colliders: ColliderSet) => f(nearOf(colliders).x),
    nearY: (colliders: ColliderSet) => f(nearOf(colliders).y),
    nearZ: (colliders: ColliderSet) => f(nearOf(colliders).z),
    nearDistance: (colliders: ColliderSet) => f(nearOf(colliders).distance),

    bodyCount: (world: PhysicsWorld) => world.bodies.count,
    bodyX: (world: PhysicsWorld, body: number) => f(world.bodies.posX[body] ?? 0),
    bodyY: (world: PhysicsWorld, body: number) => f(world.bodies.posY[body] ?? 0),
    bodyZ: (world: PhysicsWorld, body: number) => f(world.bodies.posZ[body] ?? 0),
    bodyVelX: (world: PhysicsWorld, body: number) => f(world.bodies.velX[body] ?? 0),
    bodyVelY: (world: PhysicsWorld, body: number) => f(world.bodies.velY[body] ?? 0),
    bodyVelZ: (world: PhysicsWorld, body: number) => f(world.bodies.velZ[body] ?? 0),
    bodyMass: (world: PhysicsWorld, body: number) => f(world.bodyMass(body)),
    sleeping: (world: PhysicsWorld, body: number) => world.sleeping(body),

    raycast(
      world: PhysicsWorld,
      x: number,
      y: number,
      z: number,
      dx: number,
      dy: number,
      dz: number,
      maxDistance: number,
      mask: number,
    ): boolean {
      filter.mask = mask;
      return world.raycast(x, y, z, dx, dy, dz, maxDistance, hitOf(world), filter);
    },
    hitBody: (world: PhysicsWorld) => hitOf(world).body,
    hitX: (world: PhysicsWorld) => f(hitOf(world).x),
    hitY: (world: PhysicsWorld) => f(hitOf(world).y),
    hitZ: (world: PhysicsWorld) => f(hitOf(world).z),
    hitNormalX: (world: PhysicsWorld) => f(hitOf(world).nx),
    hitNormalY: (world: PhysicsWorld) => f(hitOf(world).ny),
    hitNormalZ: (world: PhysicsWorld) => f(hitOf(world).nz),
    hitFraction: (world: PhysicsWorld) => f(hitOf(world).fraction),

    contactCount: (world: PhysicsWorld) => world.events.count,
    contactKind: (world: PhysicsWorld, index: number) => world.events.data[index * 3] ?? 0,
    contactA: (world: PhysicsWorld, index: number) => world.events.data[index * 3 + 1] ?? 0,
    contactB: (world: PhysicsWorld, index: number) => world.events.data[index * 3 + 2] ?? 0,

    applyImpulse: (
      world: PhysicsWorld,
      body: number,
      px: number,
      py: number,
      pz: number,
      atX: number,
      atY: number,
      atZ: number,
    ) => world.applyImpulse(body, px, py, pz, atX, atY, atZ),
    applyForce: (
      world: PhysicsWorld,
      body: number,
      fx: number,
      fy: number,
      fz: number,
      dt: number,
      atX: number,
      atY: number,
      atZ: number,
    ) => world.applyForce(body, fx, fy, fz, dt, atX, atY, atZ),
    setVelocity: (world: PhysicsWorld, body: number, vx: number, vy: number, vz: number) =>
      world.setVelocity(body, vx, vy, vz),
    setPosition: (world: PhysicsWorld, body: number, x: number, y: number, z: number) =>
      world.setPosition(body, x, y, z),
    wake: (world: PhysicsWorld, body: number) => world.wakeIsland(body),
    setGravity(world: PhysicsWorld, x: number, y: number, z: number): void {
      world.gravityX = x;
      world.gravityY = y;
      world.gravityZ = z;
    },
  };
}

export function inputImplementation(): Record<string, unknown> {
  const scratch = { x: 0, y: 0 };
  return {
    down: (actions: ActionMap, action: string) => actions.down(action),
    pressed: (actions: ActionMap, action: string) => actions.pressed(action),
    axisX(actions: ActionMap, action: string) {
      /* One scratch object reused, because `vector` writes into an out-parameter and a fresh
         literal per call would allocate on a path a script runs every frame. */
      actions.vector(action, scratch);
      return f(scratch.x);
    },
    axisY(actions: ActionMap, action: string) {
      actions.vector(action, scratch);
      return f(scratch.y);
    },
    /* No scratch: `axis` returns the number rather than filling an out-parameter, because one axis
       is one value and there was nothing to write into. */
    rawAxisX: (actions: ActionMap, action: string) => f(actions.axis(action, 'x')),
    rawAxisY: (actions: ActionMap, action: string) => f(actions.axis(action, 'y')),
    canRumble: (actions: ActionMap) => actions.canRumble,
    rumble: (actions: ActionMap, durationMs: number, strong: number, weak: number) =>
      actions.rumble(durationMs, strong, weak),
    stopRumble: (actions: ActionMap) => actions.stopRumble(),
  };
}

export function cameraImplementation(): Record<string, unknown> {
  /* Called directly, with no optional-call cast anywhere. A cast that tolerates a missing method is
     a binding that cannot fail when the engine renames one — which is how the first version of this
     described two methods the class does not have. */
  return {
    snap: (camera: CinematicCamera) => camera.snap(),
    shotAge: (camera: CinematicCamera) => f(camera.shotAgeSec),
  };
}

/* Referenced so the imports that document what this binds are not dropped as unused. `mulberry32`,
   `angleDelta` and `wrapAngle` are the engine's, named here because a reader looking for what a
   binding dispatches to should find it in one place. */
void mulberry32;
void angleDelta;
void wrapAngle;
