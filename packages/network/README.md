# @driftengine/network

A transport seam, rewind and replay, and the two networking models built on them.

**Cost: 2.4 KB gzipped standalone.** Measured by `scripts/size-gate.test.mjs`, which fails if it
drifts more than 3% — the number comes from the same floors that gate asserts, so a README quoting
a stale one is a red suite rather than a thing somebody notices.

**Standalone, and the raw figure is the claim.** 6,901 bytes raw against core's 2.79 MB: no
renderer is in this package's module graph. `boundaries.test.mjs` already makes the argument about
`@driftengine/physics` — _"a deterministic simulation with no renderer in its module graph, which is
what an authoritative host runs"_ — and this is the second package it applies to. It imports
`@driftengine/entities` at runtime and nothing else.

## What is in it

|                                     |                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `RewindLoop`                        | Rewind to a tick, replay to now. Both models sit on this one                                                      |
| `InputLog`                          | Every participant's input, over a window that is explicit rather than a modulo                                    |
| `Snapshotter`                       | The state seam. `worldSnapshotter`, `randomSnapshotter`, `combineSnapshotters`                                    |
| `Transport`                         | The seam a caller supplies. `LoopbackTransport` with an impairment model, `WebSocketTransport`, `WebRtcTransport` |
| `LockstepSession`                   | Peers exchange inputs; a wrong guess is unwound; a divergence halts and names its tick                            |
| `AuthorityHost`, `PredictingClient` | One world is the truth; a client predicts its own player and corrects                                             |
| `StateInterpolator`                 | Remote bodies drawn between two states the authority sent                                                         |
| `Fingerprint`                       | A hash of state, so a desync has a tick number                                                                    |
| `Sim`                               | Opt-in 48.16 fixed point, for a consumer who would rather not depend on an argument about IEEE 754                |

## The one idea

**Prediction and rollback are the same operation.** A lockstep peer that guessed a remote input and
then learned the real one has to unwind the ticks it computed from the guess. A predicting client
whose authority disagrees has to unwind the ticks it computed from a world that was wrong. Both are:
put the state back to tick _T_, correct what was wrong about _T_, and step forward to where we were.

So there is one `RewindLoop` and both models sit on it, rather than two implementations of one
mechanism.

```ts
const rewind = new RewindLoop({
  step: mySimulation, // (dt, tick) => void — the loop's own signature
  snapshotter: combineSnapshotters([worldSnapshotter(world), randomSnapshotter(rng)]),
  inputs: new InputLog({ participants: 2, depth: 32, inputBytes: 2 }),
  fixedDt: 1 / 60,
  depth: 8, // 133 ms of rewind at 60 Hz
});

startLoop({
  simulate: (dt, tick) => rewind.advance(dt, tick),
  render,
});

// A packet arrives, possibly for a tick that has already run.
rewind.supply(participant, tick, payload); // false when it is beyond the window
```

## What it does not know

**It does not know what an input is.** A payload is a fixed number of bytes a consumer encodes.
`AGENTS.md` states the rule — engine APIs never take another game's noun — and this is the place
most netcode gives it up. The size being fixed is what buys the allocation story: one array for the
session, so neither recording an input nor reading one back during a replay allocates anything.

**It does not know what your state is.** `Snapshotter<S>` is generic over its own slot type, so a
rewind needs no serialization at all — a snapshot never leaves the process. `worldSnapshotter` is
one implementation, over `@driftengine/entities`; a simulation whose state is four typed arrays
writes another in thirty lines.

**It does not decide fairness.** `rewindTo` is public so lag compensation is implementable, and lag
compensation is not implemented: an authority rewinding the world to a shooter's view of the past is
a policy about who wins a disputed shot, and that belongs to a game.

## Two things that are easy to get wrong, and are handled here

**A snapshot is taken before the step, not after.** `advance(dt, T)` saves and then steps, so slot
_T_ holds the world as tick _T_ began — which is what a rewind to _T_ wants, because _T_'s input is
about to be applied. Saving afterwards makes every rewind land one tick late, and the symptom is a
world that drifts slowly rather than one that breaks.

**A late input and a late state are different corrections.** A late _input_ means the ticks since
were computed from a wrong input: `supply` records it and the next `advance` replays. A late _state_
means they were computed from a wrong world: `reconcileSnapshot` overwrites that tick's state,
re-saves it, and replays the local inputs over the top — which is what makes a correction converge
instead of erasing what the player did.

## A rewind snapshot is not a save file

`serializeWorld` in `@driftengine/entities` writes a scene: schemas for migration, values keyed by
stable field id, and entities _created_ on load. Every one of those is wrong for a rewind, which
needs the handles it had — an input recorded against entity 4,194,307 must still mean that entity —
and needs to cost nothing per tick. `WorldSnapshot` is the other artefact, and `world.ts` carries
the table comparing them.

## Two things a lossy link taught the design

**An input message carries a run of consecutive ticks.** An input is only useful for the tick it
names, so asking for a lost one and waiting a round trip delivers it after that tick has gone. Every
packet carries the last four inputs, and a test at 15% loss is what turned that from a nicety into a
requirement — the control, with one input per packet, does not converge.

**A fingerprint is only comparable at a confirmed tick.** The newest tick is speculative: each peer
has predicted inputs the other already knows, so their live worlds differ constantly and correctly.
Comparing them halted a healthy session at tick 32 during development.

**And a third, which cost a consumer a session on a perfect link.** Three windows move independently
and a session lives inside all of them. `redundancy` says how far back every packet reaches;
`RewindLoop`'s `depth` says how far back a correction can reach; and the session retains inputs down
to the oldest tick that rewind window covers, forgetting everything below it every tick. So on any
session whose redundancy reaches further back than its rewind depth, the oldest word of every packet
names a tick the log has already been told to forget — which is not a fault, and must not be read as
one. A copy of a tick this world already applied cannot change it and cannot be evidence of a
divergence, whatever the log can still say about it; an input for a tick this world _never_ had and
can no longer apply is fatal, and still halts. Redundancy larger than the rewind depth is a fine
thing to ask for, and the two numbers do not have to be chosen together.

## Determinism

A rewind is only as good as the simulation's reproducibility. `scripts/determinism.mjs` is the gate:
the arithmetic a simulation may use is what IEEE 754 fixes exactly, and the twenty-two functions
ECMAScript declines to specify are refused inside the declared simulation set. `packages/network` is
in that set, and `packages/core/src/math/exact.ts` supplies the transcendentals it may still need.

**`scripts/exactness-cross.mjs` is how a cross-machine claim becomes a measurement.** It prints what
this machine computes — golden bits, a seeded stream, and both arms of the conformance fixture — in
a form another machine's output can be diffed against.
