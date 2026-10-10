---
title: The loop
description: A fixed simulation step, rendering between steps with alpha, pausing without freezing the screen, and the tick count replays and networking key on.
packages: ['@driftengine/core']
areas: ['core']
---

# The loop

Every DriftEngine game runs on `startLoop`. It is the fixed timestep with render interpolation that
game programmers usually learn from Glenn Fiedler's "Fix Your Timestep!": the simulation advances in
steps of exactly the same length, however fast or unevenly the display refreshes, and each displayed
frame is drawn between the last two simulated states.

```ts sample=starter/main.ts#loop
/*
 * Two angles, because that is what `alpha` is for. The simulation advances in fixed steps and
 * the display does not, so a frame almost never lands on a step boundary: drawing `spin`
 * directly judders at any refresh rate that is not a multiple of the step. Interpolating
 * between the last two states is the whole reason the loop hands `alpha` over.
 */
let spin = 0;
let previousSpin = 0;
let time = 0;

startLoop({
  simulate(dt) {
    previousSpin = spin;
    time += dt;
    spin += dt * rules.spinRate(time);
  },
  render(alpha) {
    spinner.setRotationAxisAngle(0, 1, 0, previousSpin + (spin - previousSpin) * alpha);
    spinner.updateWorld();

    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, ENV);
    renderer.drawMesh(ground, stillness.worldMatrix);
    renderer.drawMesh(cube, spinner.worldMatrix);
    renderer.endFrame();
  },
});
```

## Two callbacks, two clocks

`simulate(dt, tick)` is where the game changes. `dt` is always the fixed step, a sixtieth of a second
unless you pass another `fixedDt`, so a jump reaches the same height and a ball lands in the same
place on a 60 Hz phone and a 240 Hz monitor. A slow frame runs `simulate` two or three times to catch
up; a fast one may run it not at all.

`render(alpha, frameDt, wallDt)` is where the game is drawn. It runs once per animation frame and
must not change the simulation. `alpha` is between 0 and 1: how far real time has got from the last
step toward the next.

That is why a moving thing keeps two copies of its state. Draw the current one and motion judders,
because a frame almost never lands on a step boundary. Draw between the previous and the current at
`alpha` and it's smooth at any refresh rate. The first game keeps its player's previous position for
exactly this:

```ts sample=first-game/main.ts#player
const player = new CharacterController({ maxSpeed: 7, jumpSpeed: 7, pushStrength: 2 });
const START: Vec3 = [0, 1.2, 7];

const playerMesh = renderer.createMesh(
  new MeshBuilder()
    .addCapsule([0, 0, 0], player.radius, player.halfHeight, srgbColor(0.92, 0.88, 0.82))
    .build(),
);

/** Where the player was before the last step, for the same reason the crates keep one. */
const playerBefore = { x: 0, y: 0, z: 0 };
```

and copies the current position into it at the start of each step, before moving.

## Animating what isn't simulated

`frameDt` is the time since the last drawn frame, clamped by `maxFrameTime` (a quarter of a second
by default) so that a stall, a debugger stop or a background tab doesn't come back as one enormous
jump. Use it for things that only exist on screen: a camera easing toward its target, a light
flickering, an orb bobbing. The first game's camera follows the player this way:

```ts sample=first-game/main.ts#camera
const camera = new Camera();
camera.fovYDeg = 55;
const eye = { x: START[0], y: START[1] + 6, z: START[2] + 9 };

/** Ease toward a spot behind and above the player. Presentation only, so it runs on frame time. */
function follow(x: number, y: number, z: number, frameDt: number): void {
  eye.x = damp(eye.x, x, 5, frameDt);
  eye.y = damp(eye.y, y + 6, 5, frameDt);
  eye.z = damp(eye.z, z + 9, 5, frameDt);
  camera.position[0] = eye.x;
  camera.position[1] = eye.y;
  camera.position[2] = eye.z;
  camera.lookAt(x, y + 0.6, z);
  camera.updateMatrices(renderer.cssHeight > 0 ? renderer.cssWidth / renderer.cssHeight : 1);
}
```

`damp` is an exponential approach that gives the same motion at any frame rate, which a fixed
fraction per frame does not.

`wallDt` is the same gap with no clamp. It's there for diagnostics, to tell a slow device from a
browser that paused the page. Don't animate with it.

## Pausing

`shouldSimulate` is asked once per frame. While it returns false, `simulate` isn't called and the
time that passes is discarded, but `render` still runs, so the world stays on screen behind a pause
menu instead of freezing on whatever frame was last drawn.

```ts sample=first-game/main.ts#loop
newRound();
startLoop({ simulate, render, shouldSimulate: () => !paused });
```

Because `simulate` doesn't run while paused, the key that unpauses has to be read in `render`:

```ts sample=first-game/main.ts#pause
// Read here, not in simulate: while paused, simulate is not called at all.
if (actions.consumePress('pause')) paused = !paused;
```

`shouldRender` is the matching question for drawing. Video capture uses it to draw exactly as many
frames as the clip needs; time that wasn't drawn is added to the next frame's `frameDt`.

## Ticks

`tick` counts fixed steps from `startTick`, which is 0 unless you say otherwise. It is the identity
that replays and networking address everything by: an input belongs to a tick, a snapshot is of a
tick, and two machines agree about the world when they agree about a tick. A player joining a
session in progress starts their loop at the host's tick.

## Keeping a run repeatable

A simulation that only reads its own state, the input for the step and a seeded random generator
produces the same result every time it is run from the same start. That's what makes replays,
rollback networking and the editor's backwards scrubbing possible, so it's worth keeping from the
first line.

- Use a seeded generator such as `mulberry32(seed)` inside `simulate`, never `Math.random()`.
- Never read `Date.now()` or `performance.now()` inside `simulate`. Time is the tick count.
- Read input at the boundary, once per step, and pass what you read into the step as data.

The first game lays out its rounds from a seed this way, so the same seed gives the same rounds in
the same order on every machine:

```ts sample=first-game/main.ts#rules
/** Half the arena's width, in metres. */
const ARENA = 12;
const ORB_COUNT = 8;
/** The same seed lays out the same rounds, in the same order, on every machine. */
const SEED = 2026;
```

## Stopping

`startLoop` returns a function that stops the loop. Call it when the screen that owns the loop goes
away, before you start another one.
