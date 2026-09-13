# Contributing to DriftEngine

Thanks for taking the time. This engine is small on purpose, and it stays that way
by being picky about what lands in it. This page is what you need to know before
opening an issue or a pull request; [`AGENTS.md`](AGENTS.md) is the full technical
direction and is binding for anything that touches the code.

## Getting set up

```sh
npm install
npm run typecheck   # strict TypeScript over src/
npm test            # vitest
```

Node 22.12 or newer. Every relative import here names `.ts`, so a project that
typechecks against this source needs `allowImportingTsExtensions: true`; it is
legal beside `noEmit`, and a compile that _emits_ from this source adds
`rewriteRelativeImportExtensions: true`, which is what makes the flag legal
without it. **Nothing you change needs building.** `main` and `types` point at
`src/index.ts`, so a consumer that bundles reads the source directly and `tsc -p .` runs with
`noEmit`. `npm run build` exists for one reason — Node refuses to strip types under `node_modules`,
so a script that imports these packages without a bundler needs the emitted JavaScript. It is a
release step, not part of the loop.

To work against a real application, depend on your checkout by path —
`"@driftengine/core": "file:../driftengine"` — and npm will symlink it. Name the
`drift-source` condition in that application's bundler config and your edits are live
the moment they are saved, with no build and no publish in between.

## Formatting and linting

```sh
npm run format       # Prettier, over the whole tree
npm run lint         # oxlint, then Prettier in check mode
npm run lint:fix     # both, applying what they can fix
```

**Prettier owns formatting, so do not argue with it in review.** `.prettierrc.json` holds the
settings and `.prettierignore` names what it must not touch: generated shaders, snapshots and the
capability file, each of which a gate compares byte for byte.

**oxlint rather than ESLint, and the reason is a version floor.** This repository is on TypeScript
7, and no `typescript-eslint` release supports it yet — its peer range still stops below 6.1. oxlint
parses TypeScript itself, so it has no such constraint. Its findings are warnings rather than
errors, so `npm run lint` passes; treat the list as work to do rather than noise to silence.

## The one rule everything else follows

**Game-agnostic or it does not belong here.**

Engine APIs take positions, colours, sizes and time. They never take a character,
a route, a level, or anything else that only means something inside one game. If a
module has to know what something _is_ in order to draw it, the boundary is in the
wrong place — the capability belongs here and the meaning belongs to the consumer.

The useful test for a new feature: _would a second, unrelated game want this
unchanged?_ If yes, it is an engine module with game-side configuration on top. If
no, it belongs in the consumer.

The split runs through physics too. Collision primitives are engine — an AABB
sweep and a spatial hash mean the same thing everywhere. A character controller
built on them is game: friction, coyote time and jump feel are one game's design,
not physics.

## What a good change looks like

- **One module, one responsibility**, stated in a header comment. If you cannot
  name it in a sentence, split it.
- **Named exports only.** No `default`, no barrels except the public one at
  `src/index.ts`. Anything not exported there is private.
- **Nothing allocates in a hot path.** Anything called per frame or per simulation
  tick preallocates its scratch state at module scope and mutates in place — no
  closures, no spreads, no array literals, no string building, no DOM reads or
  writes.
- **No raw WebGL outside `src/render/`.** New GPU features are expressed as engine
  API first.
- **Strict TypeScript.** No `any`, no non-null assertions; narrow explicitly, and
  use `import type` for type-only imports.
- **Fail fast at init, never in the frame loop.** Shader compile failures, a
  missing canvas or no WebGL2 should throw immediately with an actionable message.
  After boot, the loop does not throw.
- **New dependencies need a strong reason** and must be MIT-compatible. The
  current allowance is `gl-matrix` and `mp4-muxer`; the bar for a third is high.

## Determinism is a contract

Two things here are relied on by anything that records and replays a session, and
changing them silently breaks stored data:

- **The fixed-timestep loop.** Simulation advances only in fixed `1/60` steps.
  Render code interpolates and never mutates simulation state.
- **The seeded RNG sequence.** It is frozen. A different distribution is a _new
  function_, never an edit to an existing one.

Nothing under `src/` may reach for `Date.now()`, `performance.now()` or
`Math.random()` on a path a consumer might simulate. Time arrives as a tick count
from the caller. Input sampling reads the clock — that is the boundary, and intents
cross it as data.

Likewise, nothing here calls a platform API directly when a consumer might want a
different one. Persistence goes through a `KeyValueStore` the caller supplies, so a
save can live in the browser, on a server, or nowhere. Same reasoning for any
clock, network or filesystem access: take the capability as a parameter and ship a
browser implementation as the default.

## Tests: few, and each one load-bearing

Vitest, beside the module as `*.test.ts`, typechecked by the normal `tsc` pass.

A test earns its place by protecting a contract that outlives today's tuning.

**Do test** geometry and collision invariants, pure maths with a real contract
(angle wrapping, RNG sequence stability), and the loop's accumulator behaviour.

**Do not test** tuning constants — they are decisions and will change, so asserting
their values produces tests that fail on intent and pass through bugs. Rendering,
shaders, DOM and gesture timing are verified by eye, on desktop _and_ a real phone.
Constructors and getters that neither validate nor derive are not worth a test.

Bug fixes start with a failing test that reproduces the bug. If you did not watch it
fail, you do not know it tests the right thing. Expected values are hand-derived
literals — never build an expectation using the code under test.

## Writing comments and docs

The comments in this repository are unusually long, and that is deliberate: they
explain _why_ a decision was made, especially where the obvious alternative is
wrong. Please keep that up rather than trimming to summaries.

Two things they must not contain:

- **Personal names or quoted private conversations.** A bug report becomes
  "reported as…" and describes the symptom. Nobody reading this engine should have
  to meet the people who built it.
- **Proper nouns from one game's world.** Name the generic thing — a route, a
  marker, a prop, a courtyard — rather than whatever a particular game calls it.
  Both of these are asserted by `scripts/docs.test.mjs` rather than left to review,
  because both were stated here long before anything checked them and the engine
  broke each of them dozens of times in the meantime.

## Submitting

1. Open an issue first for anything that adds API surface or changes a contract. A
   bug fix or a documented performance win can go straight to a pull request.
2. Keep the change focused. Unrelated cleanups in the same diff make a change hard
   to judge and hard to revert.
3. Before you push: `npm run typecheck` clean, `npm test` clean, no console errors
   or warnings at runtime in a consuming application, and no new allocations in hot
   paths (spot-check with DevTools allocation sampling if you touched loop code).
4. Say what you measured. Performance claims need a number and the conditions it
   was taken under; "faster" on its own cannot be reviewed.
5. Describe the _why_ in the pull request body, not only the what. If a decision
   changed, update the docs in the same commit.

## Versioning

`package.json` and `CHANGELOG.json` move together — never one without the other.
Every changelog entry carries both `text` (the full prose) and `short` (one
sentence, at most 200 characters, and shorter than the `text` it summarises).

## Browser verification

Visual checks must run on the machine's real GPU. Never force SwiftShader or
another software renderer: it saturates the CPU and gives misleading performance
numbers. Confirm the browser selected a physical GPU before drawing conclusions
about rendering, and close temporary browser sessions when you are done.

## Licence

By contributing, you agree that your contributions are licensed under the Apache
Licence 2.0, the same terms that cover this repository. See [`LICENSE`](LICENSE)
and [`NOTICE`](NOTICE).
