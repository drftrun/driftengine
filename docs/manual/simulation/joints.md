---
title: Joints
description: Seven kinds of joint between bodies, with one-sided limits, motors and a breaking load, and a six-degree-of-freedom joint described axis by axis.
packages: ['@driftengine/physics']
---

# Joints

A joint holds two bodies in a relationship: a hinge, a ball and socket, a slider, a rope. The
physics world solves joints beside its contacts, stiffer than a contact because a joint is
structural, and `jointHertz` and `jointDamping` set how stiff.

The example is a bridge of planks hinged end to end, a door on a motor, a lamp swinging on a cord,
and a chain that snaps when a ball lands in its basket. Open and shut the door, and make the chain
breakable.

<!-- run: joints -->

## Adding a joint

`addJoint(desc)` joins `bodyA` and `bodyB` and returns the joint's index. Either body may be static,
which is how something is hung from the world. The common fields:

- `anchorAX`, `anchorAY`, `anchorAZ` and `anchorBX`, `anchorBY`, `anchorBZ`: where the joint is on
  each body, in that body's own frame.
- `axisX`, `axisY`, `axisZ`: the free axis in A's frame, which a hinge turns about and a slider
  travels along.
- `lower` and `upper`: one-sided limits. A limit pushes only when the joint is past it, so a hinge
  swings freely between its stops.
- `motorSpeed` and `motorMaxForce`: a motor drives the free axis toward a speed with at most that
  force.
- `breakImpulse`: the accumulated impulse above which the joint gives way. `Infinity`, the default,
  never breaks.

A joint captures the relative pose its bodies are in when it is made, so a rig can be posed and then
jointed without anything snapping on the first tick. No angle appears in the solve: angular limits
are sines of half angles, the same unit as a quaternion's components, so a quarter turn is
`Math.sin(Math.PI / 4)`.

`world.joints` is the `JointSet`: `count`, and per joint its `type`, bodies, `motorSpeed`,
`motorMaxForce`, `broken` and the rest, which a game changes between ticks. `resetJointImpulses`
clears what the solver carried from the last tick.

## The kinds

| Type               | What it holds                                                                |
| ------------------ | ---------------------------------------------------------------------------- |
| `JOINT_DISTANCE`   | The two anchors `length` apart: a rope that does not slacken, or a strut     |
| `JOINT_SPHERICAL`  | The two anchors together, any rotation free: a ball and socket               |
| `JOINT_REVOLUTE`   | A hinge about the axis, with a limit and a motor                             |
| `JOINT_PRISMATIC`  | A slider along the axis, rotation locked, with a limit in metres and a motor |
| `JOINT_FIXED`      | Everything locked, solved as two coupled blocks                              |
| `JOINT_CONE_TWIST` | A shoulder: swing within a cone (`swingCos`), twist within `twistSin`        |
| `JOINT_SIX_DOF`    | Each of the six axes free, limited or locked, as you say                     |

### A bridge of hinges

```ts sample=joints/main.ts#bridge
/** Twelve planks between two posts, each hinged to the next about the axis across the bridge. */
function bridge(): void {
  const left = add({ type: BODY_STATIC, shape: boxShape(0.2, 1.6, 1.1), x: -5.4, y: 1.6 }, POST);
  const right = add({ type: BODY_STATIC, shape: boxShape(0.2, 1.6, 1.1), x: 5.4, y: 1.6 }, POST);
  let previous = left;
  let anchorX = 0.2;
  for (let i = 0; i < 12; i += 1) {
    const plank = add(
      {
        type: BODY_DYNAMIC,
        shape: boxShape(0.38, 0.06, 0.9),
        x: -4.8 + i * 0.84,
        y: 3,
        density: 400,
      },
      PLANK,
    );
    world.addJoint({
      type: JOINT_REVOLUTE,
      bodyA: previous,
      bodyB: plank,
      anchorAX: anchorX,
      anchorAY: previous === left ? 1.4 : 0,
      anchorBX: -0.42,
      axisZ: 1,
    });
    previous = plank;
    anchorX = 0.42;
  }
  world.addJoint({
    type: JOINT_REVOLUTE,
    bodyA: previous,
    bodyB: right,
    anchorAX: 0.42,
    anchorBX: -0.2,
    anchorBY: 1.4,
    axisZ: 1,
  });
}
```

Each plank is hinged to the next at their touching ends, about the axis across the bridge, and the
first and last to the posts. The bridge sags under its own weight and swings when a ball lands.

### A door on a motor

```ts sample=joints/main.ts#door
/** A door on a hinge with a motor, limited to swing from shut to a little past a right angle. */
function hingedDoor(): void {
  const frame = add(
    { type: BODY_STATIC, shape: boxShape(0.1, 1.2, 0.1), x: -2, y: 1.2, z: -4 },
    null,
  );
  door = add(
    { type: BODY_DYNAMIC, shape: boxShape(0.9, 1.1, 0.06), x: -1.05, y: 1.2, z: -4, density: 300 },
    DOOR,
  );
  doorHinge = world.addJoint({
    type: JOINT_REVOLUTE,
    bodyA: frame,
    bodyB: door,
    anchorBX: -0.95,
    axisY: 1,
    /* Angular limits are sines of half angles: shut, and open to 110 degrees. */
    lower: 0,
    upper: Math.sin((110 * Math.PI) / 360),
    motorSpeed: 0,
    motorMaxForce: 400,
  });
}
```

The hinge turns about y. Its limits are shut and 110 degrees open, as sines of half angles, and the
motor drives toward one or the other at a speed the page sets each tick from the switch; the limit
stops it at either end. A motor has a maximum force, so a door pushed hard enough gives.

### A lamp on a cord

```ts sample=joints/main.ts#lamp
/** A lamp on a cord: a distance joint holds it two metres from its hook, and it swings. */
function lamp(): void {
  const hook = add({ type: BODY_STATIC, shape: sphereShape(0.05), x: 3, y: 5.5, z: -4 }, null);
  const shade = add({ type: BODY_DYNAMIC, shape: sphereShape(0.3), x: 4.2, y: 4, z: -4 }, LAMP);
  world.addJoint({ type: JOINT_DISTANCE, bodyA: hook, bodyB: shade, length: 2 });
}
```

A distance joint holds the lamp two metres from a static hook and leaves it free to swing.

### A chain that breaks

```ts sample=joints/main.ts#chain
/** Links joined at their ends, and a basket at the bottom. Breakable, each joint gives way above a load. */
function chain(breakable: boolean): void {
  const ceiling = add(
    { type: BODY_STATIC, shape: boxShape(0.3, 0.05, 0.3), x: 7.5, y: 5.6, z: 2 },
    null,
  );
  chainJoints = [];
  let previous = ceiling;
  let anchorY = -0.05;
  for (let i = 0; i < 8; i += 1) {
    const link = add(
      {
        type: BODY_DYNAMIC,
        shape: boxShape(0.08, 0.2, 0.08),
        x: 7.5,
        y: 5.35 - i * 0.42,
        z: 2,
        density: 800,
      },
      LINK,
    );
    chainJoints.push(
      world.addJoint({
        type: JOINT_SPHERICAL,
        bodyA: previous,
        bodyB: link,
        anchorAY: anchorY,
        anchorBY: 0.21,
        breakImpulse: breakable ? 60 : Infinity,
      }),
    );
    previous = link;
    anchorY = -0.21;
  }
  const basket = add(
    { type: BODY_DYNAMIC, shape: boxShape(0.5, 0.08, 0.5), x: 7.5, y: 1.85, z: 2, density: 300 },
    BASKET,
  );
  world.addJoint({
    type: JOINT_SPHERICAL,
    bodyA: previous,
    bodyB: basket,
    anchorAY: -0.21,
    anchorBY: 0.1,
  });
}
```

Each link hangs from the last by a spherical joint. Made breakable, each joint gives way above a
load: the chain carries itself and its basket, and a ball landing in the basket is more than the top
joint can take. A joint that has given way has its `broken` flag set, and the solver skips it from
then on.

## Six degrees of freedom

```ts sample=snippets/joints.ts#six
/** Linear x, y, z then angular x, y, z, in the hips' own frame. Bounds are sines of half angles. */
export const hip = world.addJoint({
  type: JOINT_SIX_DOF,
  bodyA: hips,
  bodyB: thigh,
  anchorAY: -0.1,
  anchorBY: 0.22,
  dof: [DOF_LOCKED, DOF_LOCKED, DOF_LOCKED, DOF_LIMITED, DOF_FREE, DOF_LOCKED],
  dofLower: [0, 0, 0, -Math.sin(Math.PI / 8), 0, 0],
  dofUpper: [0, 0, 0, Math.sin(Math.PI / 8), 0, 0],
});
```

`JOINT_SIX_DOF` describes each axis in A's frame, linear x, y and z then angular x, y and z, as
`DOF_FREE`, `DOF_LIMITED` or `DOF_LOCKED` in `dof`, with `dofLower` and `dofUpper` for the limited
ones (`DOF_COUNT` is six). An axis not described is locked, so a forgotten axis is rigid and never a
pair of bodies flying apart. Angular bounds are sines of half angles. An all-locked six-DOF joint is
softer than `JOINT_FIXED`, since it solves six independent rows where the fixed joint solves two
coupled blocks; use the fixed one when everything should hold. It has no motor, and says so on the
console when given one.
