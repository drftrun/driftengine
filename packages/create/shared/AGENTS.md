# my-game

A game built on [DriftEngine](https://driftengine.dev): TypeScript, drawn with WebGPU and with
WebGL2 where a browser has no usable WebGPU device, built and served by Vite. Game rules can live
in DriftScript (`.drs` files), which the Vite plugin compiles and hot-reloads.

For how the engine works, load the **driftengine** skill (`.agents/skills/driftengine/SKILL.md`, or
`.claude/skills/driftengine/SKILL.md`). It covers the shape of a program, the rules the compiler
cannot check, the traps that look like engine bugs, and where every API is documented.

## Commands

```sh
npm install        # once
npm run dev        # serve with hot reload; prints the address
npm run check      # typecheck, then tests, then look: run this before saying a change works
npm run typecheck  # tsc over src/
npm test           # vitest: rules and pure logic, in Node, no GPU needed
npm run look       # photograph the game on WebGPU and WebGL2 into .driftengine/look/
npm run build      # static files in dist/, servable from any host
```

## Done means looked at

A change is done when `npm run check` passes **and** you have opened `.driftengine/look/webgpu.png`
and `.driftengine/look/webgl2.png` and they show what the change should show.

- `look` fails on a console error or warning, on a canvas of one flat colour, and on a backend that
  was asked for and not used. Read `.driftengine/look/look.json` for every console line.
- If `look` exits 2 it could not look at all: no Chrome or Edge (set `CHROME_PATH` to one), or no
  hardware GPU, which it refuses rather than trusting a software rasteriser. Try
  `npm run look -- --headed`, which opens a real browser window. If it still cannot look, say so
  plainly; do not claim the picture was checked.
- `look` sees the first seconds after boot. Something reached only by playing — a later level, a
  menu behind a key press — is not in its pictures: drive the page as the skill's "Seeing past the
  first seconds" shows, or say what was and was not looked at.

## Rules for code in this project

1. **Import only from package entry points**: `@driftengine/core`, `@driftengine/script`, and the
   other `@driftengine/*` packages. Nothing under a package's `src/` or `dist/` directly.
2. **Allocate nothing per frame.** Build meshes, nodes, vectors and arrays once; rewrite them in
   place inside `simulate` and `render`. No object or array literals, closures or string building in
   the loop.
3. **Simulate in `simulate(dt)`, draw in `render(alpha)`.** The simulation steps at a fixed 1/60 s;
   `render` interpolates between the last two states with `alpha` and never changes game state.
4. **Quality options are chosen when the renderer is built** (`createRenderer(canvas, quality)`).
   Only `setBloom`, `setCameraMotionBlur` and `setOutputExposure` change per frame.
5. **Randomness and time come from the engine**: a seeded generator and the tick count, never
   `Math.random()` or `Date.now()` in game state, so a run can be replayed.
6. **Rules that are decisions go in DriftScript**, and are tested in Node with vitest: see how
   `loadModule` reads a compiled `.drs` file in the engine's first-game template, `round.test.ts`.

## Where things are

- `src/main.ts`: the program. `src/*.drs`: rules in DriftScript. `src/drs.d.ts` types `.drs` imports.
- `vite.config.ts`: the DriftScript plugin, and which engine modules a script may import
  (`manifest.provides`). A script importing a module not listed there fails to compile, naming it.
- The installed engine's API, exactly as this project has it: `node_modules/@driftengine/core/dist/index.d.ts`
  names every export and the module it comes from, whose own `.d.ts` documents it. The renderer's
  methods are in `dist/render/backend/webgl2/renderer.d.ts`, physics in `@driftengine/physics/dist/`.
- DriftScript, the language: `node_modules/driftscript/docs/LANGUAGE.md`.
- The manual: https://driftengine.dev/docs. All of it as one file: https://driftengine.dev/llms-full.txt
