---
title: Characters
description: A kinematic character controller with coyote time and jump buffering, ground surfaces for roads and decks, water, and an escape for a trapped body.
packages: ['@driftengine/physics', '@driftengine/core', '@driftengine/script']
---

# Characters

A character that is a dynamic body falls over, cannot be steered crisply, and turns every question
about movement into a question about torque. `CharacterController` is a kinematic capsule instead,
swept through the same physics world everything else queries, so it stands on scenery and bodies
alike and pushes the dynamic ones it walks into. Its feel, acceleration, air control, jump height,
coyote time, rides on it as numbers.

The example is a valley to walk about: across a bridge or down under it, up a flight of steps, off a
slab too steep to stand on, into a pond and into crates. WASD or the arrows walk, Space jumps, and Q
and E turn the camera; until a key is pressed, the character walks a circuit of its own.

<!-- run: character -->

## The controller

```ts sample=character/main.ts#controller
/** Two feels for one character: quick to turn and short in the air, or slow to stop and floaty. */
const FEELS: Record<string, ControllerOptions> = {
  snappy: { acceleration: 60, deceleration: 50, airControl: 0.4, jumpSpeed: 7, gravity: -24 },
  floaty: { acceleration: 12, deceleration: 6, airControl: 0.8, jumpSpeed: 6, gravity: -11 },
};
let feel = flag('feel', 'snappy');
let player = new CharacterController({
  ...FEELS[feel],
  coyoteTicks: 6,
  jumpBufferTicks: 6,
  ground,
});
player.teleport(-8, 4, 4);
```

`new CharacterController(options)` takes:

- `radius` and `halfHeight`, the capsule: 0.35 and 0.6, so 1.9 metres tall.
- `stepHeight`, the highest lip walked over without a jump, 0.35.
- `slopeCos`, the cosine of the steepest walkable slope, 0.7 (about 45 degrees). Steeper ground is
  slid down, with `slideBoost` added downhill.
- `maxSpeed`, `acceleration`, `deceleration` and `airControl`, the share of control left in the air.
- `jumpSpeed`, `gravity`, and `jumpCutoff`, the fraction upward speed is cut to when jump is released
  early, which is what makes a short tap a short hop.
- `coyoteTicks`, how many ticks after leaving an edge a jump still counts, and `jumpBufferTicks`, how
  long a press made just before landing is remembered. Both are counted in ticks, never accumulated
  in seconds, so a replay matches after an hour of play.
- `pushStrength`, how hard it shoves the dynamic bodies it walks into.
- `filter`, which bodies it collides with, and `ground`, a surface to stand on beside the bodies.

`teleport(x, y, z)` places it and clears its velocity, and `move(world, dt, input)` advances it one
tick. The input is `moveX` and `moveZ`, the wanted velocity in metres a second, clamped to
`maxSpeed`, and `jump`, held: the controller does its own edge detection and buffering. Afterwards
`x`, `y`, `z`, `velX`, `velY` and `velZ` say where it is and how it moves, and `state` is `GROUNDED`,
`AIRBORNE` or `SLIDING`. `setUp` and `setGravityDirection` turn its frame, for walls and spheres,
with `moveY` and `projectMove` in the input for steering on a surface whose up is not world Y.

## The controls, in DriftScript

The example's controls are a DriftScript module reading the page's `ActionMap` through
`drift/input`:

```drs sample=character/controls.drs#steer
// The stick or the keys, turned by the camera's yaw so that up is away from the camera.
fn steer(wish: mut Wish, actions: Actions, yaw: f32, speed: f32) {
    let across = input.axisX(actions, "move")
    let along = input.axisY(actions, "move")
    wish.x = (math.cos(yaw) * across + math.sin(yaw) * along) * speed
    wish.z = (math.cos(yaw) * along - math.sin(yaw) * across) * speed
    wish.jump = input.down(actions, "jump")
}
```

`input.axisX` and `input.axisY` read a vector action as the stick convention has it, up negative,
and `input.down` and `input.pressed` read a button. The page calls `steer` once a tick and hands its
wish to the controller:

```ts sample=character/main.ts#script
/** The controls, hosted, and the wish they fill each tick. */
const controlsModule = hostScript(controlsScript);
interface Wish {
  x: number;
  z: number;
  jump: boolean;
}
const wish = exported<() => Wish>(controlsModule, 'createWish')();
type Steer = (wish: Wish, actions: ActionMap, yaw: number, speed: number) => void;
type Seek = (
  wish: Wish,
  fx: number,
  fz: number,
  tx: number,
  tz: number,
  speed: number,
  jump: boolean,
) => void;
if (import.meta.hot) {
  import.meta.hot.accept('./controls.drs', (next) => {
    if (next !== undefined)
      patchModule(controlsModule, next as Record<string, unknown>, { Wish: [wish] });
  });
}
```

## Ground surfaces

```ts sample=character/main.ts#ground
/** A valley along z, a pond dug into its west bank, and a bridge deck across it at z = 0. */
const smooth = (t: number): number => t * t * (3 - 2 * t);
function valley(x: number, z: number): number {
  const bank = 2.6 * smooth(Math.min(1, Math.max(0, (Math.abs(x) - 1.5) / 4.5)));
  const pond = 1.6 * Math.max(0, 1 - Math.hypot(x + 12, z - 9) / 4);
  return bank - pond;
}
const SIDE = 81;
const terrain = new Terrain({
  width: SIDE,
  depth: SIDE,
  spacingM: 0.5,
  heights: Float32Array.from({ length: SIDE * SIDE }, (_, i) =>
    valley((i % SIDE) * 0.5 - 20, Math.floor(i / SIDE) * 0.5 - 20),
  ),
  origin: [-20, 0, -20],
});
/* Level with the banks where it meets them: a body walks from one field onto the other only where
   the two are at one height. */
const DECK_Y = 2.6;
const deck = (x: number, z: number): number =>
  Math.abs(x) < 6.5 && Math.abs(z) < 1.5 ? DECK_Y : Number.NaN;

/** Two fields: whichever is nearer the height a body is at is the floor it stands on. */
const ground = heightSurface([(x, z) => terrain.heightAt(x, z), deck]);
```

A world whose floor is analytic, a road along a route, a heightfield, a deck, has one floor and not
one per thing standing on it. Anything that answers "how high is the ground at this column, and
which way does it face" is a `GroundSurface`, and the controller, the vehicle, the third-person
camera and the rain all take one. The controller consults it only where the bodies found nothing
walkable: a body is a thing that is there, and a surface is a description of where the ground is.

- `heightSurface(field, options)` wraps a function of `(x, z)`, or a **list** of them. A layer
  answers `NaN` where it is not there, so a bridge deck is a floor over its span and nothing beside
  it, and a road passes under a road. Which layer a body gets is the one nearest the height it asks
  from, and a tie goes to the one below. `bounds` limits a field, and `normalAt` supplies exact
  normals in place of the central difference.
- `RibbonSurface` is a road along a route, with its banking and width; `BoxSurface` is a set of
  pads; `CompositeSurface` answers several surfaces as one, as `heightSurface` does for a list.
- `colliderSurface(set, { minY, maxY })` lets the slabs of a `ColliderSet` be ground, solved against
  their own faces so a ramp holds a body along its slope. `minY` and `maxY` are required: they bound
  the column the spatial hash walks.

**Where two layers meet, they have to meet at one height.** A body walks from one layer onto
another where both answer the same height; a kerb between two layers is not stepped up, and the
example's deck is level with the banks for that reason.

`coveredAbove` asks whether anything overhangs a point, which is how rain stops under a roof.

## Bodies, steps and slopes

```ts sample=character/main.ts#bodies
/** What the character collides with as bodies: the piers, a flight of steps, a slab and crates. */
const world = new PhysicsWorld();
const solid: {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  qz?: number;
}[] = [
  { x: -2, y: 1.2, z: 0, hx: 0.4, hy: 1.2, hz: 1.2 },
  { x: 2, y: 1.2, z: 0, hx: 0.4, hy: 1.2, hz: 1.2 },
];
for (let step = 0; step < 8; step += 1) {
  solid.push({
    x: 10 + step * 0.6,
    y: 2.6 + (step + 1) * 0.125,
    z: -8,
    hx: 0.3,
    hy: (step + 1) * 0.125,
    hz: 1.2,
  });
}
solid.push({ x: 16, y: 3.6, z: -8, hx: 1.5, hy: 1, hz: 2 });
for (const box of solid) {
  world.addBody({
    type: BODY_STATIC,
    shape: boxShape(box.hx, box.hy, box.hz),
    x: box.x,
    y: box.y,
    z: box.z,
  });
}
/* A slab falling fifty degrees from the platform's edge toward +z: too steep to stand on, so a
   character who walks off the platform onto it slides down to the bank. */
const tilt = (50 * Math.PI) / 360;
world.addBody({
  type: BODY_STATIC,
  shape: boxShape(1.4, 0.15, 1.3),
  x: 16,
  y: 3.6,
  z: -5.15,
  qx: Math.sin(tilt),
  qw: Math.cos(tilt),
});
const crates: number[] = [];
for (let i = 0; i < 4; i += 1) {
  crates.push(
    world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.4, 0.4, 0.4),
      x: -9 + i * 1.1,
      y: 3.1,
      z: -6,
      density: 150,
    }),
  );
}
```

Against bodies the controller steps up any lip within `stepHeight` and slides down any face steeper
than `slopeCos`. A dynamic body it walks into is pushed, by `pushStrength`. The example's circuit
climbs the steps and walks off the platform onto the slab, where it slides to the bank.

## Water

```ts sample=character/main.ts#water
/** The pond: falling in costs speed on every axis, and a drop settles instead of sinking fast. */
const POND = { x: -12, z: 9, half: 3.4, level: 1.8 };
const sea = createBuoyancy({ level: POND.level, drag: 3, sinkSpeed: -1.2 });
```

`createBuoyancy({ level, drag, sinkSpeed })` describes a body of water, and `applyBuoyancy(water, y,
state, dt)` acts on anything with `velX`, `velY` and `velZ`, a controller included, and answers
whether it is submerged. A kinematic body displaces nothing, so this is not a buoyant force: it is
drag on every axis, so falling in costs speed and is a setback and never a shortcut, and a sinking
speed the fall settles to.

## When the geometry traps a body

A controller resolves a move against geometry and has no opinion about a body that has been asking
to move for half a second and going nowhere. `StallEscape` does:

```ts sample=snippets/characters.ts#escape
/** Thirty ticks of going nowhere arms it, and it may push four metres before calling it sealed. */
const escape = new StallEscape({ stalledTicks: 30, budgetM: 4 });

/** Last in the tick, after the move has resolved: it reads where the body ended up. */
export function unstick(
  body: Body,
  colliders: ColliderSet,
  input: StallInput,
  respawn: () => void,
): void {
  if (escape.step(body, colliders, input) === ESCAPE_SEALED) respawn();
}
```

It judges progress as net travel over a window, never one tick's movement, since a body jammed under
a low ceiling jitters while staying put. Grounded, supported and headroom are three separate facts:
a body with all three can jump out and is not stuck however blocked it is, because being blocked is
what a wall is for. An `EscapeVeto` refuses directions the world would not allow, such as off a deck
edge that has no collider. The answer is `ESCAPE_IDLE`, `ESCAPE_EASED`, `ESCAPE_PUSHED` or
`ESCAPE_SEALED`, and sealed is reported, never acted on: what being trapped costs a player is the
game's decision.

## Movement of your own

`SweptStep` moves a kinematic body horizontally through a `ColliderSet` one axis at a time, with the
rules a sweep alone does not hold: a kerb to step over, a face the world calls solid with no
collider, a corner where both axes refuse at once. A `WorldOpinion` supplies what the colliders do not
know. `accelerateAlong(state, wishX, wishZ, wishSpeed, accel, dt)` is the accelerate a first-person
game uses, clamped against the shortfall along the wish direction, which is also what makes
air-strafing work, and it returns how much speed it added.

```ts sample=snippets/characters.ts#accelerate
/** Toward the wish, clamped against the shortfall along it: what makes air-strafing work. */
export function accelerate(
  velocity: { velX: number; velZ: number },
  wishX: number,
  wishZ: number,
  dt: number,
): number {
  return accelerateAlong(velocity, wishX, wishZ, 7, 50, dt);
}
```
