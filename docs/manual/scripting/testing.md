---
title: Determinism, testing and shipping
description: What @deterministic and @pure promise and how the compiler holds a script to them, testing a script in Node, CI, and what reaches the bundle.
packages: ['@driftengine/script']
plain: ['Round', 'Vitest']
---

# Determinism, testing and shipping

A rule written in DriftScript can carry a promise about what it touches, and the compiler checks the
promise every time the file compiles. The same rules can be called from a test in Node, because a
script that holds no engine object is a set of functions over records. This page covers both, then
what a build checks and what it ships.

## Deterministic rules

```drs sample=first-game/round.drs#tick
// The clock, once a step. Every orb taken wins the round; the clock reaching zero first loses it.
// Deterministic: the same round and the same step give the same answer on every machine, so a
// recorded round replays exactly. Reading input or the wall clock here would not compile.
@deterministic
fn tick(round: mut Round, dt: f32) {
    if round.phase != "playing" {
        return
    }
    round.remaining = round.remaining - dt
    if round.gathered == round.total {
        round.phase = "won"
    } else if round.remaining <= 0 {
        round.remaining = 0
        round.phase = "lost"
    }
}
```

`@deterministic` on a function says that the same arguments give the same result on every machine,
every time. The first game's `tick` carries it: given the same round and the same step, it ends the
round the same way, so a recorded game replays exactly and two players simulating the same round
agree.

The compiler checks the promise from the calls. Every engine function is declared with its effects,
and a function's effects are the effects of everything it calls, followed through its own helpers. A
deterministic function may reach what is inside the simulation: reading the scene and physics,
reading and writing entities, chemistry and navigation, reading a behaviour's state, and reading
what the network and the save store have already delivered. It may not read input or the clock,
play a sound or an animation, write to physics or the scene directly, save, send over the network,
call a model, or reach the host. [What a script can reach](reach.md) marks every engine function
one way or the other.

Hand `tick` the page's `ActionMap` and let the clock run faster while the stick is pushed, with
`let hurry = input.axisX(actions, "move")`, and the file stops compiling, naming the call that broke
the promise:

```text
round.drs:9:1  DS0261  `tick` is annotated `@deterministic` but has `input.read`, which is outside the simulation boundary. It reaches `drift/input.axisX` (input.read).
```

When the read is inside a helper that `tick` calls, the message names the effect, and the helper is
where to look. The fix is the shape the first game already has: the page reads the controls each
step and passes the result in as a number, which the step can then be replayed with.

## Pure functions

```drs sample=first-game/round.drs#start
// A new round: a full clock, nothing gathered yet, and the number of orbs the page laid out.
fn start(round: mut Round, total: u32) {
    round.remaining = ROUND_SECONDS
    round.gathered = 0
    round.total = total
    round.phase = "playing"
}

// Whether the player, this far from an orb on each axis, is close enough to take it. Pure: it reaches
// nothing outside its arguments and the constants above, which the compiler checks.
@pure
fn reaches(dx: f32, dy: f32, dz: f32) -> bool {
    return dx * dx + dy * dy + dz * dz < REACH * REACH
}

fn gather(round: mut Round) {
    round.gathered = round.gathered + 1
}
```

`@pure` is the stricter promise: the function reaches no engine module at all, only its arguments and
the script's constants. `reaches` is pure. A pure function that gains any effect, even one a
deterministic function may have, fails with `DS0260` and the effects it gained. A pure function may
still change a `mut` record it was handed, since the caller chose to hand it over. Mark a function
pure when it answers a question from its inputs, a distance or a score or whether a move is allowed,
and it stays that way.

Neither annotation changes what the compiled code does. Both are checked and then erased, and a
function without one is not assumed to be either.

## Testing a script

```ts sample=first-game/round.test.ts#test
import { describe, expect, it } from 'vitest';
import { loadModule } from 'driftscript';
import * as roundScript from './round.drs';

interface Round {
  remaining: number;
  gathered: number;
  total: number;
  phase: string;
}
const rules = loadModule(roundScript as Record<string, unknown>).exports as unknown as {
  createRound(): Round;
  start(round: Round, total: number): void;
  reaches(dx: number, dy: number, dz: number): boolean;
  gather(round: Round): void;
  tick(round: Round, dt: number): void;
};

describe('a round', () => {
  it('is won when the last orb is gathered before the clock runs out', () => {
    const round = rules.createRound();
    rules.start(round, 2);
    rules.gather(round);
    rules.gather(round);
    rules.tick(round, 1 / 60);
    expect(round.phase).toBe('won');
  });

  it('is lost when the clock runs out first, with the clock stopped at zero', () => {
    const round = rules.createRound();
    rules.start(round, 2);
    rules.gather(round);
    for (let step = 0; step < 61 * 60; step += 1) rules.tick(round, 1 / 60);
    expect(round.phase).toBe('lost');
    expect(round.remaining).toBe(0);
  });

  it('reaches an orb within a metre and not beyond', () => {
    expect(rules.reaches(0.6, 0, 0.6)).toBe(true);
    expect(rules.reaches(0.8, 0, 0.8)).toBe(false);
  });
});
```

A test imports a `.drs` file the way the page does. Vitest reads the project's `vite.config.ts` when
it has no config of its own, so the DriftScript plugin compiles the script for the test with the
same capabilities and the same manifest, and a script that breaks a promise fails the test run as it
would fail the build.

`loadModule` is all a script needs when it imports no engine module, as the round does. One that
does is bound first, with `bindModule(module, services)` and whatever services its imports need,
built in the test. Records are plain objects: the test creates one with the script's own `create`
function, calls the rules, and reads the fields back.

The examples in this repository are tested this way, beside the code they test, by the engine's
own suite.

## Checking in CI

A build compiles every script the page imports, so `vite build` is the check: an error in any
script stops it and prints every error with its code and line. A test run checks the scripts its
tests import. There is no separate command to add. A script nothing imports is never compiled, and
it is also never shipped.

## What ships

A compiled script is a plain JavaScript module with no imports of its own: its functions, a `create`
function for each record, and a `__drift` export describing the module's records, components and
systems, for the host and for hot reload. A production build leaves out the editor's metadata,
which only the development tools use, and changes nothing about how the script behaves. The page's
`import.meta.hot` block never runs in a built bundle.

Around the scripts, the bundle carries what the page imports to run them: `loadModule` and
`patchModule` from `driftscript`, and `bindModule` with the engine's bindings from
`@driftengine/script`. Both packages are dependencies of the game, installed as
[Installation](../start/installation.md#driftscript) shows, and the compiler itself stays in the
toolchain.
