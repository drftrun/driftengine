---
title: Rigid bodies
description: A deterministic physics world of boxes, spheres, capsules, cylinders, hulls and meshes, with soft contacts, sleeping islands and a fingerprint.
packages: ['@driftengine/physics', '@driftengine/script']
areas: ['physics']
---

# Rigid bodies

`@driftengine/physics` is a rigid-body world stepped on the fixed clock. It imports no other engine
package, so a deterministic simulation runs with no renderer in its module graph: in Node, in a
worker, or on a server holding the authoritative copy of a game. Core re-exports every name in it,
so reaching for physics through the core barrel works as well. It costs 45.4 KB gzipped on its own.

The example is a wall of crates, a ramp with wheels, a capsule, a ball and a rock rolling down it,
and a cannon firing at the wall. The cannon is a DriftScript module. The readout's fingerprint is
the whole world as one number.

<!-- run: physics -->

## A world

```ts sample=physics/main.ts#world
/** The ground, a ramp, a wall of crates and things to roll down the ramp. */
let world = new PhysicsWorld();
let ball = 0;

function build(friction: FrictionModel, substeps: number): void {
  world = new PhysicsWorld({ frictionModel: friction, substeps });
  drawnAs.length = 0;
  world.addBody({ type: BODY_STATIC, shape: boxShape(30, 0.5, 30), y: -0.5, friction: 0.8 });
  /* A ramp turned twenty degrees about z, falling toward the wall. */
  const half = (20 * Math.PI) / 360;
  world.addBody({
    type: BODY_STATIC,
    shape: boxShape(5, 0.25, 2.5),
    x: 9,
    y: 1.6,
    qz: Math.sin(half),
    qw: Math.cos(half),
  });

  const body = (desc: Parameters<PhysicsWorld['addBody']>[0], drawn: MeshHandle): number => {
    const index = world.addBody(desc);
    drawnAs[index] = drawn;
    return index;
  };
  /* The wall: six crates along the bottom, one fewer each row up. */
  for (let row = 0; row < 6; row += 1) {
    for (let i = 0; i < 6 - row; i += 1) {
      body(
        {
          type: BODY_DYNAMIC,
          shape: boxShape(0.5, 0.5, 0.5),
          x: 0,
          y: 0.5 + row,
          z: i - (5 - row) / 2,
          friction: 0.6,
          density: 120,
        },
        CRATE,
      );
    }
  }
  /* Down the ramp: wheels standing on their rims, capsules lying across it, balls and a rock. */
  const quarter = Math.SQRT1_2;
  for (let i = 0; i < 3; i += 1) {
    body(
      {
        type: BODY_DYNAMIC,
        shape: cylinderShape(0.6, 0.2),
        x: 12,
        y: 4.2,
        z: i * 1.4 - 1.4,
        qx: quarter,
        qw: quarter,
      },
      WHEEL,
    );
  }
  body(
    {
      type: BODY_DYNAMIC,
      shape: capsuleShape(0.3, 0.4),
      x: 11,
      y: 4.2,
      z: 2,
      qx: quarter,
      qw: quarter,
    },
    PILL,
  );
  body(
    { type: BODY_DYNAMIC, shape: sphereShape(0.45), x: 13, y: 5, z: 0.6, restitution: 0.3 },
    BALL,
  );
  body({ type: BODY_DYNAMIC, shape: hullShape(ROCK_POINTS), x: 10.5, y: 4.4, z: -2 }, ROCK);
  /* The cannon's ball, parked out of the way until the script fires it. */
  ball = body(
    { type: BODY_DYNAMIC, shape: sphereShape(0.35), x: -14, y: 0.35, z: 0, density: 7800 },
    SHOT,
  );
}
```

`new PhysicsWorld(options)` takes its quality and feel dials once:

- `substeps`, integrate-and-solve passes a tick, and `iterations` a substep. Constraints are soft,
  each a stiffness in hertz with a damping ratio, so raising `substeps` buys accuracy and changes
  no behaviour: a stack rests at the same height and a ball bounces as high.
- `gravityX`, `gravityY` and `gravityZ`; `linearDamping` and `angularDamping`.
- `contactHertz` and `contactDamping`, and `jointHertz` and `jointDamping`, stiffer, since a joint is
  a structural relationship.
- `speculativeMargin`, how far apart two shapes may be and still get a constraint.
- `allowSleep`, on by default.
- `frictionModel`, `'box'` by default or `'elliptical'`. Box friction clamps each tangent axis on its
  own, so a slide along the diagonal between them meets up to `√2` times the grip it meets along an
  axis: measured, 0.737 metres of travel against 1.064 from the same 4 m/s. Elliptical couples
  them, and the distance is 1.06 metres whatever the heading, which is what friction physically is.
  It is not the default because every stacking result moves under it, and a stored replay or a
  golden fingerprint is something a game keeps.
- `workers` and `pool`, for solving islands on other threads; see below.

`world.step(dt)` advances one fixed tick, always with the same `dt`. Contact events are drained
after the tick, so nothing samples a substep's state.

## Bodies

`addBody(desc)` returns the body's index. A `BodyDesc` names:

- `type`: `BODY_STATIC`, never moving; `BODY_DYNAMIC`, moved by forces and contacts;
  `BODY_KINEMATIC`, never pushed and never integrated: you move it with `setPosition` each tick, and
  `setVelocity` tells contacts how fast it is moving.
- `shape`, one convex shape, or `shapes`, up to `MAX_BODY_PARTS` (32) of them as one body.
- `density`, 1,000 kilograms a cubic metre unless stated, which is water. The example's crates are
  120 and its cannon ball 3,000.
- `x`, `y` and `z`, and a rotation as the quaternion `qx`, `qy`, `qz` and `qw`.
- `friction` and `restitution`.
- `layer` and `mask`, 32 bits each: two bodies collide only when each one's mask admits the other's
  layer (`layersInteract`). `ignorePair(a, b)` excludes one pair whatever their layers say, and
  `allowPair` undoes it.
- `sensor`, for a body that reports overlap and is never pushed out of it.

State lives in `world.bodies`, a `BodySet` of parallel arrays: `posX`, `posY`, `posZ`, the rotation
`rotX`, `rotY`, `rotZ`, `rotW`, the velocities `velX`, `velY`, `velZ` and `angX`, `angY`, `angZ`,
and `count`. Position and rotation are what a frame draws:

```ts sample=physics/main.ts#draw
/** A body's model matrix, from its position and the quaternion the world integrates. */
const model = new Float32Array(16);
function placed(body: number): Float32Array {
  const b = world.bodies;
  const x = b.rotX[body] ?? 0;
  const y = b.rotY[body] ?? 0;
  const z = b.rotZ[body] ?? 0;
  const w = b.rotW[body] ?? 1;
  model[0] = 1 - 2 * (y * y + z * z);
  model[1] = 2 * (x * y + z * w);
  model[2] = 2 * (x * z - y * w);
  model[4] = 2 * (x * y - z * w);
  model[5] = 1 - 2 * (x * x + z * z);
  model[6] = 2 * (y * z + x * w);
  model[8] = 2 * (x * z + y * w);
  model[9] = 2 * (y * z - x * w);
  model[10] = 1 - 2 * (x * x + y * y);
  model[12] = b.posX[body] ?? 0;
  model[13] = b.posY[body] ?? 0;
  model[14] = b.posZ[body] ?? 0;
  model[15] = 1;
  return model;
}
```

`applyImpulse`, `applyForce`, `setVelocity` and `setPosition` move a body from outside, waking its
island; `bodyMass` reads its mass, and `sleeping(body)` whether it has settled. `removeBody(index)`
fills the hole with the last body and returns that body's old index, or −1, so a game keeping body
indices follows the one it is told about.

## Shapes

A `ConvexShape` is a point cloud and two kinds of rounding, with its separating features listed
once when it is built:

- `boxShape(hx, hy, hz)`, by half extents: eight corners.
- `sphereShape(radius)`: one point and a radius.
- `capsuleShape(radius, halfHeight)`: two points along y and a radius.
- `cylinderShape(radius, halfHeight)`, standing along y: two points and a side radius that grows the
  shape by a disc, so the caps are flat and the rim is sharp. A wheel is a cylinder turned a
  quarter turn. A 32-sided prism wheel bobs 16 mm rolling at 6 m/s; a cylinder bobs under 2 mm.
- `hullShape(points, radius)`, the convex hull of up to 64 points, from the few points that define a
  shape, never a render mesh.

`shapeBounds` measures one, `shapeMassProperties` and `combineMassProperties` give mass, centre and
inertia for a density.

A concave thing that moves is several hulls. `decomposeConvex(positions, indices, options)` cuts a
mesh into `parts`, each a hull's `points`, its `volume` and how full it is, with `resolution`,
`maxHulls` and `concavity` as its dials; it runs offline. Static concave geometry is a mesh:
`meshShape(positions, indices)` on a static body, where every triangle goes through the same narrow
phase, contacts are one-sided, rays are two-sided, and interior edges are filtered so a box sliding
across two coplanar triangles does not catch on their seam. Measured, a box slid at 6 m/s across
sixteen quads keeps 80% of its speed with the filter and 1% without. A heightfield is a shape of its
own, `heightfieldShape`, covered in [Terrain](../worlds/terrain.md).

## Sleeping and islands

Bodies that touch, through contacts or joints, form an island, and only dynamic bodies join one, so
two towers on one floor are two islands. An island whose bodies have all been still for long enough
sleeps, counted in ticks, and wakes when something touches it. `islandCount` says how many there
were on the last tick.

No two islands share a body, so solving them in any order, or at once, gives the same bits. The
`Executor` seam runs them: `SerialExecutor` by default, `ShuffledExecutor` in a random order, which
the tests use to prove order does not matter, and `DisjointExecutor`. `new PhysicsWorld({ workers,
pool: createIslandPool })` solves on a pool of workers from `@driftengine/physics/src/workers.ts`,
named at the call so a game that never asks for workers bundles none. It needs a cross-origin
isolated page, since it shares memory; without one the world stays serial, correct, and says why in
`parallelism.reason`.

## Determinism

Contacts persist across ticks by feature, never by nearness within a tolerance, which is what makes
warm starting correct and independent of order. No angle appears anywhere in the solve: limits
compare cosines and quaternion components. The tick uses no `sin`, `atan` or `pow` that two engines
could round differently.

`fingerprintBodies(world.bodies)` hashes every body's state into one string, and two runs of the
same inputs reach the same one tick for tick: it is how a replay or a rollback session checks that
two machines agree. `fingerprintColliders` does the same for a `ColliderSet`.

## From DriftScript

`drift/physics` reads and moves bodies of a world a script is handed:

```drs sample=physics/cannon.drs#fire
// Called every tick with the tick's number. Answers whether it fired on this one.
fn fire(world: PhysicsWorld, ball: i32, tick: u32) -> bool {
    if tick % 150 != 30 {
        return false
    }
    let shot = tick / 150
    physics.setPosition(world, ball, -14, 1.2, random.range(shot, -1.5, 1.5))
    physics.setVelocity(world, ball, 30, random.range(shot + 1, 1, 4), random.range(shot + 2, -0.6, 0.6))
    physics.wake(world, ball)
    return true
}
```

| Capabilities                                                       | What they do                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `bodyCount`, `bodyX`, `bodyY`, `bodyZ`, `bodyVelX` to `bodyVelZ`   | Read a body's position and velocity                                     |
| `bodyMass`, `sleeping`                                             | Its mass, and whether it has settled                                    |
| `applyImpulse`, `applyForce`, `setVelocity`, `setPosition`, `wake` | Move it                                                                 |
| `setGravity`                                                       | Change the world's gravity                                              |
| `raycast`, then `hitBody`, `hitX`, `hitNormalX` and the rest       | Cast a ray and read what it hit                                         |
| `contactCount`, `contactKind`, `contactA`, `contactB`              | Read the tick's contact events                                          |
| Collider capabilities                                              | Query and edit a `ColliderSet`; see [Queries and colliders](queries.md) |

Reads are `physics.read` and are deterministic; writes are `physics.write`. The world reaches a
script as an argument, so the module needs no host service:

```ts sample=physics/main.ts#script
/** The cannon, hosted, and called once a tick with the world it fires into. */
const cannon = hostScript(cannonScript);
type Fire = (world: PhysicsWorld, ball: number, tick: number) => boolean;
if (import.meta.hot) {
  import.meta.hot.accept('./cannon.drs', (next) => {
    if (next !== undefined) patchModule(cannon, next as Record<string, unknown>, {});
  });
}
```
