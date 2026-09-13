# @driftengine/physics

Convex collision shapes, the spatial hash over them, ray and segment queries, and the swept
kinematic sweep that resolves a moving body against a static world one axis at a time.

**It imports no other engine package.** Together with `@driftengine/entities` that makes a
deterministic simulation you can run with no renderer in its module graph — in Node, in a worker,
or on a server, which is what an authoritative host needs. **45.0 KB gzipped** standalone, measured
by `scripts/size-gate.test.mjs` against `scripts/fixtures/size/physics-only.ts`.

**`@driftengine/core` re-exports every name here**, so reaching for collision through the core
barrel works exactly as it did before these files lived in a package of their own. Core _depends on_
this package rather than the other way round, which is the opposite direction from every other
optional package and is not a preference: the cinematic and third-person cameras, the contact probe
and the ribbon builder all need the sweep.

```ts
import {
  AXIS_X,
  AXIS_Y,
  ColliderSet,
  boxCollider,
  hullShape,
  moveAxis,
} from '@driftengine/physics';
import type { Body } from '@driftengine/physics';

const world = new ColliderSet([boxCollider(0, -0.5, 0, 20, 0.5, 20)]);
const body: Body = { x: 0, y: 2, z: 0, hx: 0.35, hy: 0.9, hz: 0.35 };

moveAxis(body, world, AXIS_X, 0.05); // returns how far it actually travelled
moveAxis(body, world, AXIS_Y, -0.02);
```

## Rigid bodies

```ts
import { BODY_DYNAMIC, BODY_STATIC, PhysicsWorld, boxShape } from '@driftengine/physics';

const world = new PhysicsWorld({ substeps: 4 });
world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, friction: 0.8 });
const crate = world.addBody({ type: BODY_DYNAMIC, shape: boxShape(0.5, 0.5, 0.5), y: 4 });

world.step(1 / 60); // fixed clock, always
world.bodies.posY[crate];
```

Constraints are **soft**: each carries a stiffness in hertz and a damping ratio rather than a
fraction of penetration per step. That is what makes `substeps` a quality dial — raise it and a
stack rests at the same height and a ball bounces to the same height, so the option buys accuracy
without changing behaviour.

Contacts persist across ticks by **feature id**, never by proximity within a tolerance, which is
what makes warm starting correct rather than order-dependent.

Islands are connected components over **dynamic bodies only**, so two towers standing on one floor
are two islands rather than one. Sleeping is island-gated and counted in ticks. An executor seam
runs the islands, and a gate asserts a serial runner and a deliberately reordered one produce
identical state — no two islands share a body, so order cannot matter, and that is asserted rather
than argued.

## Joints, queries and sensors

```ts
import { JOINT_REVOLUTE, createRayHit } from '@driftengine/physics';

world.addJoint({
  type: JOINT_REVOLUTE,
  bodyA: post,
  bodyB: door,
  anchorAX: 0.1,
  anchorBX: -0.8,
  axisY: 1,
  lower: -0.5,
  upper: 0.5,
  motorSpeed: 2,
  motorMaxForce: 400,
});

const hit = createRayHit();
if (world.raycast(0, 2, 0, 0, -1, 0, 50, hit, { ignore: player })) hit.body;
```

Seven types — distance, spherical, revolute, prismatic, fixed, cone-twist and a configurable
six-DOF — with motors, **one-sided** limits and a breaking threshold. `addJoint` captures the
relative pose the bodies are in now, so a rig can be posed and then jointed without anything
snapping on the first tick. No angle appears anywhere in the solve: limits compare cosines and
quaternion components, which is what a clamp wants and what the determinism gate permits.

```ts
world.addJoint({
  type: JOINT_SIX_DOF,
  bodyA: hips,
  bodyB: thigh,
  /* linear x, y, z then angular x, y, z, in the hips' own frame */
  dof: [DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LIMITED, DOF_FREE, DOF_LOCKED],
  dofLower: [0, 0, 0, -Math.sin(Math.PI / 8), 0, 0],
  dofUpper: [0, 0, 0, Math.sin(Math.PI / 8), 0, 0],
});
```

Three things to know before reaching for it. **Nothing said is everything locked**, so a joint you
forgot to describe is rigid rather than one whose bodies fly apart. **Angular bounds are sines of
half angles**, the same unit `swingCos` and `twistSin` use, because no angle appears in this solver
— a quarter turn is `Math.sin(Math.PI / 4)`. And **an all-locked six-DOF joint is softer than
`JOINT_FIXED`**: it solves six independent scalar rows where the fixed joint solves two coupled 3x3
blocks, so use the fixed one when you want all six. It has no motor, and says so on the console
rather than accepting one and never driving.

**A cylinder is a shape here**, and the number that put it there is worth knowing
because it is what a prism costs you. `cylinderShape(radius, halfHeight)` stands along y and turns
with its body, so a wheel is a cylinder with a quarter turn on it. The workaround it replaces was an
n-gon prism through `hullShape`: a hull takes at most 64 points, a prism spends two a side, so 32
sides is the wall, and a 32-sided wheel of radius 1 rolling at 6 m/s **bobs 16 mm** with no sides
left to add. The same wheel as a cylinder bobs **under 2 mm**, which is inside the solver's own
5 mm slop. `prismRoll.test.ts` measures both, side by side.

The difference is a second kind of rounding rather than a second kind of shape: `sideRadius` grows a
shape by a _disc_ perpendicular to the segment through its two points, where `radius` grows it by a
ball. Two flat caps, a curved side, a sharp rim between them. Everything reads both — contacts,
inertia, bounds, rays and cloth — and a cylinder's support across its axis is exactly its radius at
every angle, which is the property a prism cannot have and the reason a wheel stops bobbing.

**Friction is a box by default and an ellipse if you ask for one.** Each tangent row is clamped to
`mu * N` on its own, so a slide along the diagonal between the two axes meets `sqrt(2)` times the
grip it meets along an axis — measured, 0.737 m of travel against 1.064 m from the same 4 m/s.
`frictionModel: 'elliptical'` couples the rows and the distance is 1.06 m whatever the heading,
which is what friction physically is. It is not the default: every stacking result moves under it,
and a golden fingerprint or a stored replay is a thing consumers keep.

Queries fill caller-owned buffers and allocate nothing. A ray starting inside a body reports that
body at fraction zero, because a line-of-sight test that says a wall it started inside is not there
is worse than useless.

A **sensor** reports overlap and resolves none of it. Events drain into `world.events` after the
tick, ordered by pair key, rather than firing callbacks mid-solve — a callback that removes a body
during the solve invalidates every index the solver is holding.

## Characters and ragdolls

```ts
import { CharacterController, ragdollFromBones } from '@driftengine/physics';

const player = new CharacterController({ coyoteTicks: 6, jumpBufferTicks: 6 });
player.teleport(0, 2, 0);
player.move(world, 1 / 60, { moveX: 4, moveZ: 0, jump: held });

// A skeleton already has both of these; nothing is imported in either direction.
const doll = ragdollFromBones(
  world,
  skeleton.joints.map((j) => j.parent),
  skeleton.world,
);
doll.drive(world, animatedPose, 0.6); // a hit reaction, not a body gone limp
doll.writePose(currentPose);
```

The controller is **kinematic**, not a dynamic body: a dynamic character falls over and turns every
question about movement into a question about torque. Its feel parameters live on it — acceleration,
air control, variable jump height, slide boost — and **coyote time and jump buffering are counted in
ticks**, never accumulated in a float of seconds, so a replay matches after an hour of uptime.

The ragdoll takes a parent array and a flat array of joint world matrices, and writes back through a
structural target that an animation `Pose` satisfies. Neither package names the other. **`sync` puts
every body back on its bones and clears its velocities**, which is what a hit reaction needs and
what nothing had: a ragdoll is built once, so between reactions its bodies sit where the last one
left them while the character keeps moving — and blending toward _that_ snaps the character to a
stale shape somewhere else, carrying the speed of however long the bodies had been falling.

## When the geometry has stopped cooperating

```ts
import { ESCAPE_SEALED, StallEscape, applyBuoyancy, createBuoyancy } from '@driftengine/physics';

const escape = new StallEscape({ stalledTicks: 30, budgetM: 4 });
// Last in the tick, after the move has resolved: it reads where the body ended up.
const out = escape.step(body, colliders, { trying, refused, grounded, supported }, veto);
if (out === ESCAPE_SEALED) respawn(); // your decision, not the engine's

const sea = createBuoyancy({ level: 0, drag: 3, sinkSpeed: -1.2 });
const submerged = applyBuoyancy(sea, body.y, velocity, 1 / 60);
```

**A controller resolves a move against geometry; it has no opinion about a body that has been asking
to move for half a second and going nowhere.** That gap is where players get stuck, and the rules
that close it only show up in a shipped game:

- **Progress is net travel over a window**, never this tick's displacement — a body jammed under a
  low ceiling _jitters_ by thirty times any per-tick threshold while sitting at the same
  coordinates for as long as the key is held.
- **Grounded, supported and headroom are three separate facts.** A body with all three can jump out
  and turn and walk away, and is not stuck however blocked it is — being blocked is what a wall is
  _for_. Without that gate this arms on somebody merely leaning on scenery and carries them sideways
  with the controls doing nothing.
- **A direction the world would refuse is not an escape route.** `EscapeVeto` is taken structurally,
  the same way `GroundProbe` is on the controller: a deck edge carrying no collider at all reports
  clear air to a probe that asks only the colliders.
- **Sealed is reported, never acted on.** The engine says there is nowhere to put the body; what
  that costs a player belongs to you. Pressing into a wall is allowed to achieve nothing, and is not
  allowed to be fatal.

`applyBuoyancy` is the other half of a body meeting the world: drag on **every** axis, because
killing horizontal momentum is what makes falling in a setback rather than a shortcut, and a
terminal sink speed so a drop settles instead of accelerating into the seabed. `accelerateAlong` is
Quake's accelerate with its trap named — the amount added is clamped against the shortfall _along
the wish direction_, which is also what buys air-strafing.

## Vehicles and cloth

```ts
import { ClothBody, Vehicle, makeClothGrid } from '@driftengine/physics';

const car = new Vehicle(chassis, { wheels: [...], lateral: myTyreCurve });
car.update(world, 1 / 60, { throttle: 1, brake: 0, steer });

const grid = makeClothGrid(20, 20, 0.1);
const cape = new ClothBody(grid.positions, grid.links, grid.bendLinks);
cape.step(world, 1 / 60);   // after world.step
```

The vehicle is a **raycast** vehicle: wheels are rays, not bodies. A raycast wheel cannot wedge in
geometry or collide with another wheel, and in exchange it is stable at ordinary substep counts,
which rigid wheels on joints are not. Grip comes from a **table you supply** rather than a magic
formula, because the tick may not use `sin` or `atan` — a curve is edited by moving a point.

**Both the controller and the vehicle take a `ground` probe**, so a world whose floor is analytic
has one floor rather than one per thing that stands on it. Anything answering "how high is the
ground at this column, and which way does it face" satisfies it, and `@driftengine/core` has three
that do: `RibbonSurface` for a route, `BoxSurface` for pads, and `heightSurface(heightAt)` around a
function of your own. A wheel consults it only where its ray found no body, and the character does
the same: a body is a thing that is there, and a surface is a description of where the ground is.

**A road can pass under a road**, and this is worth saying plainly because it reads like something a
height field cannot do. `heightSurface` takes a **list** of fields as well as one:

```ts
const ground = heightSurface([
  (x, z) => terrainAt(x, z), // the carriageway, everywhere
  (x, z) => deckAt(x, z), // the flyover, NaN off the structure
]);
```

**A layer answers `NaN` where it is not there**, so a deck is a floor exactly over its span and
nothing at all beside it. Which floor a query gets is decided by the height the asker is at, and
every caller already passes it — the character controller, the vehicle, the third-person camera and
the rain field all do. A caller with no position, a generator placing a lamp, gets the highest,
which is what it wants.

Order in the list carries no meaning: the rule is nearness to the asker, with a tie broken toward
the floor below, so a body on the lower road stays on it directly beneath a span.

**And a collider can be the ground, so a deck can be a slab instead of a height.** A collider set
was solid to walk _into_ and not to stand _on_: the sweep resolves a body against it laterally, and
the character controller senses ground through bodies and through a `GroundSurface`, which a
collider set was neither. Measured: a character dropped over a `ColliderSet` slab whose lid is at
5.5 m fell to −84 m in three seconds, which is what it does with no slab at all.

```ts
import { colliderSurface } from '@driftengine/core';

const ground = heightSurface([...]);            // or any other surface
const decks = colliderSurface(set, { minY: -20, maxY: 60 });
const world = new CompositeSurface([ground, decks]);
```

`minY` and `maxY` are the vertical extent the column search walks and they are **required**: the
spatial hash visits every cell in that column, so an unbounded one is half a million cells and a
frozen frame. You know how tall your world is; the engine does not.

**A sloped hull holds you up at the slope, not at its bounding box.** The lid is solved against the
solid's own face planes, so a ramp supports a body along its face and hands back a normal that tilts
with it — treating the broad-phase box as the answer would stand a body on thin air over the low
half of every ramp.

**Drawing cloth needs `updateMesh` in `@driftengine/core`**, which is what a deforming surface has
instead of a model matrix — a mesh is otherwise immutable, and recreating one per frame is a GPU
buffer allocation per frame. Create it with `{ dynamic: true }` and hand it positions and normals
each frame.

Cloth is XPBD. Bending resists **bowing** rather than orientation, so it will not hold a cantilever
out — that is a property of a skip-one distance constraint, and the alternative is noted where the
links are built.

**A sheet pushes what it lands on, if you ask it to.** `coupling` is 0 to 1 and 0 is the default; at
anything above, a particle pushed out of a body hands the body back the momentum it lost, at the
contact point, so a sheet landing on one end of a plank tips it. `particleMass` is what that
momentum is measured in, in kilograms, and is deliberately not `invMass` — that array is a relative
weight the compliance is tuned against. The exchange is explicit, so the body answers on the next
tick: a very heavy sheet on a very light body rings, and turning `coupling` down is the answer.
Merging cloth particles into the rigid solver's islands would converge in one solve and is still
refused, because merged islands are what the parallel executor is made of.

**A sheet stops passing through itself, if you ask it to.** `selfDistance` is in metres and 0 is the
default, because its tuning is the half that decides whether it looks right: a little under the grid
spacing is the honest starting point. Particles a link joins are exempt — a stretch link's rest
length _is_ the spacing, so anything else would have every neighbour fighting its own link and the
sheet would inflate rather than drape.

## A level is a mesh, and everything in it is a hull

```ts
import { meshShape } from '@driftengine/physics';

world.addBody({ type: BODY_STATIC, shape: meshShape(positions, indices) });
```

`meshShape` takes triangles and builds their planes, an edge classification and a tree over them.
**Static only, and it is enforced**: `addBody` refuses one on a moving body and `colliderFromShape`
refuses one outright. A moving concave thing wants convex decomposition into hulls, which `decomposeConvex` produces and `BodyDesc.shapes` accepts; before 2026-09-03 that sentence named something the dynamics could not do, which the
runtime already accepts.

Every triangle goes through the same narrow phase everything else does, so a box, a sphere, a
capsule, a cylinder and a hull are all exact against a mesh with no second implementation of any of
them. A mesh pair produces **several** contact planes rather than one, because a body in a corner
has two or three and reducing them to one picks a wall and lets the body through the others.

**Contacts are one-sided and rays are two-sided.** A level mesh is a surface: a two-sided contact
fires anything that has sunk below it back out the wrong way, while a sight line that saw through a
wall from behind is a worse answer than one that did not.

**Interior edges are filtered**, which is the part that decides whether a mesh floor feels like a
floor. Without it a box sliding across two coplanar triangles catches on their seam — a character
stumbling on a flat floor once a metre. Measured: a box slid at 6 m/s across sixteen quads keeps
**80% of its speed with the filter and 1% without it**.

## A world whose colliders stream

```ts
import { ColliderSet } from '@driftengine/physics';

const world = new ColliderSet([]); // empty, because a streamer builds by group
const groups = new Map<number, number>(); // region -> handle

function crossInto(region: number): void {
  for (const r of ring(region)) {
    if (!groups.has(r)) groups.set(r, world.add(collidersFor(r)));
  }
  for (const [r, group] of [...groups]) {
    if (inRing(r, region)) continue;
    world.remove(group); // the grid is updated for this group and no other
    groups.delete(r);
  }
}
```

**One set follows the player, and an index is an index.** That is the whole point of the shape:
with a set per region, a query result means nothing without the set that answered it, so every
consumer of a hit carries a pair where it once carry a number.

Measured by `npm run check:streaming`, driving a body across region boundaries at five frame rates:
**a crossing costs 0.090 ms** where rebuilding a set of the same size costs about 41 ms, and
**queries on the streamed set run at 1.25 to 1.31 times** a freshly built one's. The alternative of
keeping one set per region and asking the nine around the player measured a **7.5x** multiplier on
every collision query in the game.

`world.bytes()` answers what the resident ring costs, which is the question that decides a region
size: `slots` and `shapes` are exact, and `index` carries an estimate of per-object overhead a
JavaScript engine does not expose. `world.absorb(other)` folds one set into another by copying its
packed bounds and offsetting its buckets, with nothing rehashed.

**Three things worth knowing before you build on it.**

`count` is the live count and `capacity` is the slot count. They are equal until the first
`remove`; after that the live colliders are sparse, so a walk over `data` runs to `capacity` and
skips `!liveAt(i)`. Nothing that never removes has to change.

**A set built by the constructor cannot be streamed.** Those colliders belong to a reserved group
`remove` refuses, so build empty and put everything in through `add`.

**`fingerprintColliders` answers a narrower question on a set that has been mutated**: "the same set
with the same history", not "the same world". Replay is unaffected — the same inputs drive the same
path and so the same slots — but two sessions that reached the same world by different routes will
not agree.

## Two kinds of rounding, and what they can and cannot be

A `ConvexShape` is **a point cloud plus two kinds of rounding**, with its separating features
enumerated once at build time. A box is its eight corners; a sphere is one point and its `radius`; a
capsule is two points and its `radius`; a cylinder is two points and its `sideRadius`. The face
normals and edge directions are the separating axes SAT tests, and a fixed, data-driven axis list
per shape pair is what lets two machines replay the same run bit for bit.

**A cylinder is the one shape a single radius cannot express**, which is why there are two: a
uniform radius grows around every feature and would round the rim along with the side, and the rim
is what a wheel rolls on. `sideRadius` grows the shape by a disc perpendicular to its axis instead.
Its curved side has no separating axis to enumerate, so a pair involving one builds its axis list
against the _other_ shape — `cylinderContact.ts` — and answers every axis exactly from the support
function. That costs about 5 KB gzipped and it is most of what the section header once called the
one representation.

`hullShape` is O(n⁴) in the point count and caps at 64 points, deliberately. Shapes come from the
few points that _define_ an element, never from a render mesh.

## Islands on other threads, if your site can pay for it

No two islands share a body, so solving them in any order or all at once gives the same bits. The
`Executor` seam has been in this package since islands landed and `ShuffledExecutor` has been
asserting that property since. What kept a pool out was never the engine.

```ts
import { PhysicsWorld } from '@driftengine/physics';
import { createIslandPool } from '@driftengine/physics/src/workers.ts';

const world = new PhysicsWorld({ workers: 4, pool: createIslandPool });
world.parallelism; // { requested: 4, running: 4, reason: '' }
world.dispose(); // terminates them; a world with a pool must be disposed
```

**`pool` is passed in, and it lives behind its own specifier, and both are measurements.** A world
that reached the pool on its own put 2,629 bytes gzipped into every bundle, including everyone who
never asks for a worker. That was half of it. The other half cost 4.7 times as much: a bundler
rewrites `new Worker(new URL(...))` at transform time, before tree-shaking decides anything is
unreachable, so a barrel that merely re-exported the factory still wrote **12,259 gzipped bytes** of
worker to disk in builds where nothing could fetch it. Reported by one consumer and reproduced on a
second the same day.

So the factory is at `@driftengine/physics/src/workers.ts`. A caller already had to name it, so the
cost is the specifier and nothing else, and importing `PhysicsWorld` now names no worker at all.

**Read `parallelism` instead of assuming the option took.** Every path that does not start a pool
sets `reason` to a whole sentence: the page is not cross-origin isolated, the bundler could not build
the worker, no pool was passed. `running: 0` with correct serial physics is this design working, and
a silent fallback is the one outcome it refuses.

### The headers, which are the actual price

`SharedArrayBuffer` does not exist on a page that is not cross-origin isolated. Two header pairs get
you there, and they cost very different things:

|                                                                                            |                                                                                                                  |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`   | Every cross-origin resource that does not send CORP stops loading. Fonts, CDN images, embedded video, analytics. |
| `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` | Cross-origin resources still load, sent without credentials.                                                     |

**Both were measured in Chrome 151, not remembered**: `npm run check:pool` grants isolation under
either and runs the pool identically. `credentialless` is the one to reach for first. Safari has not
been tested here, and this sentence is the whole of what is known about it.

The headers go on the document. In Vite, `server.headers`; on Cloudflare Pages, a `_headers` file;
in nginx, `add_header`. `demo/dev/vite.isolated.config.ts` is a working example of the first.

### What it is worth, and the two bounds it is held between

Measured on a 24-core desktop, 256 islands of ten boxes, by `npm run bench:islands`:

| workers | 1     | 2     | 4     | 8     |
| ------- | ----- | ----- | ----- | ----- |
| speedup | 1.05x | 1.22x | 1.26x | 1.39x |

**Neither bound is a promise and both belong to your scene.** Amdahl's is `1 / (1 - solve share)`,
and the bench prints that share. The other is `total island cost / largest island cost`: the tick
cannot end before its slowest island does, so a hundred jointed boxes are one island and gain
nothing at any worker count. The figures above are well under the first bound, and the staging copy
accounts for 1.7% of the gap and no more; what accounts for the rest has not been measured, so this
does not guess.

### When your bundler cannot build the worker

The default is `new Worker(new URL('./islandWorker.ts', import.meta.url), { type: 'module' })`, which
Vite, webpack 5 and Parcel resolve. If yours does not, `parallelism.reason` says so and you pass your
own:

```ts
// islandWorker.ts, in your app
import '@driftengine/physics/src/islandWorker.ts';
```

```ts
new PhysicsWorld({
  workers: 4,
  pool: createIslandPool,
  spawn: () => new Worker(new URL('./islandWorker.ts', import.meta.url), { type: 'module' }),
});
```

### What makes any of this safe

`DisjointExecutor` snapshots the body lanes before each island and fails when two islands write one
of them. It needs no threads and no timing, so it cannot be flaky in either direction, and it is the
one test in this package that would notice the day the disjointness assumption stopped holding.
Every write inside the solve is guarded by `invMass > 0` or walks `bodyOrder`, which holds only
dynamic bodies, so a static floor under twenty towers is read by all of them and written by none.

## Determinism is a construction here, not an aspiration

Everything on the path that feeds a tick uses `+ - * /` and `Math.sqrt` and nothing else. Those are
what ECMAScript specifies as IEEE-754 operations, and IEEE-754 requires `sqrt` correctly rounded.
The functions ECMAScript declines to specify — `hypot`, `pow`, `sin`, `atan2` and the rest — are
banned, and `scripts/determinism.test.mjs` fails on any of them.

That gate exists because the claim came first and was false. `hullShape`'s header promised the same
features in the same order on every machine while ten `Math.hypot` calls sat under it, two of them
deciding whether a plane becomes a face and how many separating axes exist. Nothing in the suite
could see it.

`fingerprintColliders` hashes the geometry a recording was made against, so a consumer can refuse a
replay rather than run it against a world that has since changed.

## Documentation

This file covers the dynamics landing on top of the collision core: the solver, joints,
queries, a character controller, ragdolls, vehicles and cloth — and what each of them
refuses, with what would reverse it.
