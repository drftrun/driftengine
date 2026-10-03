---
title: Moving things
description: Read the keyboard, the mouse, a gamepad and a touch screen through one action map, and turn what you read into movement on the fixed step.
packages: ['@driftengine/core']
areas: ['input']
---

# Moving things

Input in DriftEngine comes in three layers, and a game usually uses all three.

- `InputSource` captures the devices: keys, the mouse with pointer lock, touches and gamepads.
- `ActionMap` names what the player means, such as _move_ or _jump_, and binds keys and buttons to
  those names, so the rest of the game never asks which device was used.
- `TouchControls` turns a touch screen into a thumb stick on one side and taps, holds and swipes on
  the other.

The first game uses all three, and this page follows it.

## Capturing devices

```ts sample=first-game/main.ts#input
const input = new InputSource(canvas, ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const actions = new ActionMap(input, {
  move: {
    stick: 'left',
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  jump: { keys: ['Space'], buttons: ['faceDown'] },
  restart: { keys: ['KeyR', 'Enter'], buttons: ['start'] },
  pause: { keys: ['KeyP', 'Escape'], buttons: ['select'] },
});

/** A thumb stick on the left of a touch screen, and a tap or hold on the right. */
const touch = new TouchControls(input);
const move = { x: 0, y: 0 };
```

`new InputSource(canvas, codes)` starts listening. The second argument lists keys whose browser
default should be suppressed: without it, Space and the arrows scroll the page under your game.
Keys are named by `KeyboardEvent.code`, the physical key, so `KeyW` is the same key on a QWERTY and
an AZERTY keyboard.

On its own, an `InputSource` answers questions directly:

- `isDown('KeyW')` is whether a key is held now.
- `keyPressed('Space')` is whether it went down since the last poll, and `consumeKeyPress` is the
  same question answered `true` for exactly one caller.
- `pad(0)` is the first gamepad, or `null`, with named buttons such as `faceDown` and `start` in the
  standard layout, sticks, triggers, and rumble where the browser can drive the motors.
- `consumeMouseDelta(out)` drains the mouse movement since you last asked, which is what a mouse
  look reads, and `requestPointerLock()` captures the pointer for it.

The source polls gamepads and turns key presses into edges once per animation frame on its own. If
you record replays, pass `{ autoPoll: false }` and call `poll()` yourself at the start of each step,
so the sample belongs to the step.

## Naming what the player means

An `ActionMap` takes the source and a table of actions. A **digital** action, such as `jump`, lists
keys and gamepad buttons. An **analog** action, such as `move`, names a stick and the keys for each
direction, so a keyboard player and a gamepad player steer the same way.

- `down('jump')` is whether anything bound to the action is held.
- `consumePress('restart')` is a press, claimed once. Use this for anything that should happen once
  per press: a slow frame can run `simulate` twice, and `pressed` would answer yes both times.
- `vector('move', out)` fills `out` with a direction, the larger of the stick and the keys, never
  their sum, so holding a key while pushing the stick doesn't double the speed.

Bindings can be changed at run time with `rebind`, and saved and loaded with any key/value store, so
a controls screen is a list of actions and a button that waits for the next key.

## Touch screens

`new TouchControls(input)` splits the screen in two. The left part is a stick that appears where the
thumb lands; the right part reports a tap, a hold, a downward swipe and look movement. It reports
signals, never verbs: `primaryHeld` doesn't mean jump until your game says so, which is also what
makes it simple to record.

Call `tick(performance.now())` once per frame, outside the simulation, so a hold resolves on time.

## Turning input into movement

```ts sample=first-game/main.ts#simulate
function simulate(dt: number): void {
  if (round.phase.tag !== 'Playing') {
    if (actions.consumePress('restart') || touch.consumePrimaryPress()) newRound();
    return;
  }

  // Keys and the pad follow the stick convention, where up is negative. The touch stick reports
  // up as positive, so it is flipped here, once.
  actions.vector('move', move);
  if (touch.moveX !== 0 || touch.moveY !== 0) {
    move.x = touch.moveX;
    move.y = -touch.moveY;
  }

  playerBefore.x = player.x;
  playerBefore.y = player.y;
  playerBefore.z = player.z;
  player.move(world, dt, {
    moveX: move.x * player.maxSpeed,
    moveZ: move.y * player.maxSpeed,
    jump: actions.down('jump') || touch.primaryHeld,
  });

  recordCrates(crateBefore);
  world.step(dt);
  recordCrates(crateAfter);

  for (let i = 0; i < orbs.length; i += 1) {
    const orb = orbs[i];
    if (orb.taken) continue;
    const dx = orb.x - player.x;
    const dy = orb.y - player.y;
    const dz = orb.z - player.z;
    if (rules.reaches(dx, dy, dz)) {
      orb.taken = true;
      rules.gather(round);
      chime();
    }
  }

  if (player.y < -10) player.teleport(START[0], START[1], START[2]);

  rules.tick(round, dt);
}
```

The step reads the move vector, decides what it means, and hands it to the
`CharacterController`, which slides the player's capsule along walls, steps up kerbs and handles
jumping. The direction maps straight onto the world here because the camera sits behind the player
looking toward negative Z, so stick-forward is negative Z. A camera that turns would rotate the
vector by its yaw first.

> [!NOTE]
> The keyboard, the gamepad and `ActionMap.vector` report up as **negative** Y, which is the gamepad
> specification's convention. `TouchControls` reports up as positive. The first game flips the touch
> value once, where it reads it, and every line after that agrees.

## What the frame does with it

The step moved the player and kept where it was before; the frame draws it between the two at
`alpha`. That split, input sampled at the edge, applied in a fixed step, and drawn by interpolation,
is the same for every moving thing in every example in this manual.

Next is [Your first game](first-game.md), which adds a level, physics, things to collect, sound, a
timer and a HUD.
