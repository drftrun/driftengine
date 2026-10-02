---
title: Determinism
description: How a DriftEngine simulation gives the same result every run on every browser, which replays, rollback netcode and the editor's timeline all depend on.
packages: ['@driftengine/core']
covers: ['Platform']
---

# Determinism

A deterministic simulation, started from the same state and fed the same inputs, produces the same
result to the last bit, every time and on every JavaScript engine. DriftEngine is built so that a
game can have that property without working for it, and the engine's own systems depend on it:

- a replay is a recording of inputs, played back through the same simulation;
- rollback networking re-runs the last few ticks when a late input arrives;
- the editor scrubs a running game backwards by restoring a snapshot and simulating forward again;
- a ghost, a race against your own best run, is a replay you draw beside the live one.

All of them come from four rules, and the engine keeps the first three in its own code.

## 1. A fixed step

The simulation advances only in fixed steps, a sixtieth of a second by default. A variable step
makes a jump height depend on the frame rate, and makes two runs of the same inputs diverge the
moment one machine stutters. [The loop](../start/the-loop.md) covers `startLoop`, which owns this.

## 2. Seeded randomness, which can be rewound

```ts sample=snippets/determinism.ts#seeded
/** A generator whose position is one integer, so a rollback can put it back exactly. */
const random = savableMulberry32(42);

const before = random.save();
const first = random.next();
random.restore(before);
const again = random.next(); // the same number as `first`, bit for bit
```

`mulberry32(seed)` returns a fast generator whose sequence is fixed forever: the engine treats a
change to it as breaking every replay anybody has saved, so it never changes, and a different
distribution would be a new function. `savableMulberry32` is the same sequence with its position
readable and writable as one integer, which a rollback needs: re-simulated ticks must draw the
numbers they drew the first time.

Two helpers cover the common cases without a generator at all. `hashToUnit(seed)` gives one
well-mixed value per integer, for per-particle or per-tile variation; `pickBySeed(seed, items)`
chooses from a list without consecutive seeds walking it in order.

## 3. Arithmetic that every engine agrees on

`+`, `-`, `*`, `/` and `Math.sqrt` are exactly specified by ECMAScript, and JavaScript never fuses a
multiply and an add. `Math.sin`, `Math.cos`, `Math.exp` and nineteen more are not: two browsers may
differ in the last bit, and in a simulation a last bit becomes a different world a few seconds
later. Inside the simulation, use the engine's reproducible versions:

```ts sample=snippets/determinism.ts#exact
/** A platform that sways on a fixed step. `Math.sin` may differ in its last bit between browsers. */
export function swayAt(tick: number): { x: number; z: number } {
  const t = tick / 60;
  return { x: exactSin(t * 0.7) * 2, z: exactCos(t * 0.7) * 2 };
}
```

`exactSin`, `exactCos`, `exactExp`, `exactLog` and `exactAcos` are built from the five exact
operations only, with fdlibm's coefficients, so they agree everywhere. They are no more accurate than
`Math`; they are reproducible, which is the point. Outside the simulation, in drawing and in
presentation, `Math` is fine.

The engine's own simulation code is held to this by a gate in its repository that refuses the
unspecified functions in any module the simulation reaches.

## 4. Nothing from outside

Inside `simulate`, never read the wall clock (`Date.now`, `performance.now`), never call
`Math.random`, and never read input devices directly. Time is the tick count. Input is sampled once,
at the edge of the step, and handed in as data, which is also what you record for a replay.

## Proving two runs agree

```ts sample=snippets/determinism.ts#check
/** Run the same simulation twice from the same start, and compare the bodies' bits. */
function run(ticks: number): string {
  const world = new PhysicsWorld({ substeps: 4 });
  world.addBody({ type: BODY_STATIC, shape: boxShape(10, 0.5, 10), y: -0.5 });
  for (let i = 0; i < 6; i += 1) {
    world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.5, 0.5, 0.5),
      x: i * 0.3,
      y: 1 + i * 1.1,
    });
  }
  for (let tick = 0; tick < ticks; tick += 1) world.step(1 / 60);
  return fingerprintBodies(world.bodies);
}

export const agrees = run(600) === run(600);
```

`fingerprintBodies` hashes the raw bits of every body's state, and `fingerprintColliders` the static
geometry a simulation ran against. A recording is only replayable against the world it was recorded
in, so storing the collider fingerprint beside a replay lets you refuse one recorded against a level
that has since changed, before it plays back wrongly.

The physics solver keeps its defaults stable for the same reason. Its elliptical friction model is
more physically correct and is still opt-in, because switching it on changes every result and would
invalidate fingerprints and replays that games have stored.

## Keeping what each tick produced

```ts sample=snippets/determinism.ts#trace
/** Keep what each tick produced, so a replay can seek to any tick without simulating its way there. */
export function recordHeights(ticks: number): TickTrace {
  const trace = new TickTrace(1, ticks);
  const value = new Float32Array(1);
  for (let tick = 0; tick < ticks; tick += 1) {
    value[0] = swayAt(tick).x;
    trace.push(value);
  }
  return trace;
}
```

Seeking in a replay would otherwise mean re-simulating every tick before the one you want. A
`TickTrace` records the values you choose, per tick, once, and then answers any tick at once, which
is what makes a replay scrubbable.

## Where the rest is

Snapshots and rollback are in `@driftengine/network`, and the entity model's whole-world snapshots
in `@driftengine/entities`, which [Entities](../simulation/entities.md) rewinds a pond with. A world larger than single
precision can address keeps its simulation coordinates absolute and never rebases them, because a
rebase changes floating-point results; [Coordinates](coordinates.md) explains how rendering copes.
