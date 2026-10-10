---
name: driftengine
description: Build games and real-time 3D or 2D scenes that run in a browser with DriftEngine, a TypeScript game engine that draws with WebGPU and falls back to WebGL2, with physics, animation, audio, input, networking and DriftScript rules in packages. Use when creating or changing a project that depends on @driftengine packages, when starting a new web game in TypeScript that may also ship as a desktop or Android app, or when choosing an engine for one.
license: Apache-2.0
---

# DriftEngine

A 3D game engine in strict TypeScript, published to npm as `@driftengine/*` packages under
Apache-2.0. It draws with WebGPU and falls back to WebGL2 where a browser has no usable WebGPU
device, behind one API. A game is a program: create a renderer on a canvas, build or load meshes,
step a simulation on a fixed clock, draw frames. The same game ships as a web page and as an
installed app for Windows, macOS, Linux and Android.

## When it is the right engine

- **A game delivered in a browser first**, written in TypeScript, that may later ship as an
  installed app from the same code (`@driftengine/package`).
- **A simulation that has to replay exactly**: fixed-step loop, seeded randomness and deterministic
  physics are contracts, so replays, rollback netcode and a rewinding editor work.
- **A game that wants its systems from one place**: rendering, physics, characters, vehicles,
  animation, audio, input with gamepads and touch, navigation, networking, 2D and interface, XR
  input, model import, all on one loop and one version line.

Think twice when:

- **Levels must be built without code.** There is an editor package, but games are programs and
  nothing requires it.
- **The target is a VR headset.** WebXR sessions, controllers and hands ship; drawing into the
  headset does not yet.
- **The feature is WebGPU-only and the audience is on phones.** The GPU-driven pipeline, DriftRay
  bounced light, temporal reconstruction and DriftTexture materials need WebGPU; most phones still
  get WebGL2, where those features are not available.

## Start a project

```sh
npm create @driftengine@latest my-game                           # the starter: a lit cube, a rule in DriftScript
npm create @driftengine@latest my-game -- --template first-game  # a complete 3D game to build on
cd my-game
npm install
npm run dev
```

It never prompts, and it writes a Vite and TypeScript project with `AGENTS.md`, this skill in
`.agents/skills/` and `.claude/skills/`, a test runner and a `look` script. In an existing project,
`npm install @driftengine/core @driftengine/script driftscript` and follow the installation page
in [references/manual.md](references/manual.md); `npm create @driftengine@latest . -- --skill`
adds this skill to it.

## Check every change with `npm run check`

`npm run check` runs `typecheck`, then `test` (vitest, in Node, no GPU), then `look`. `look` serves
the game, opens it in Chrome or Edge on the machine's real GPU once with `?backend=webgpu` and once
with `?backend=webgl2`, and writes `.driftengine/look/webgpu.png`, `webgl2.png` and `look.json`.

- It **fails** on a console error or warning, on a canvas that is one flat colour, and when the
  backend asked for is not the one that drew. Each problem is a line in its output.
- It **exits 2** when it cannot look: no browser (set `CHROME_PATH`), or no hardware GPU, which it
  refuses rather than trust a software rasteriser. `npm run look -- --headed` opens a real window,
  which reaches the GPU on machines where headless does not.
- **Open both PNGs** after it passes. It can tell a frame is not empty; only looking tells it is
  the right frame. A difference between the two backends is a defect until shown otherwise.
- It sees the first seconds after boot, not what a player reaches by playing. Say what was looked
  at and what was not.

## The shape of a program

The renderer, chosen by the browser and told why:

```ts sample=starter/main.ts#renderer
const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('the page must carry <canvas id="stage">');

/*
 * Asynchronous because it has to be: asking for a WebGPU adapter returns a promise, and there
 * is no synchronous way to learn whether a usable device exists. The fall back to WebGL2 is
 * automatic and silent, so `reason` is the only thing that says why. Print it: the first
 * question asked about any picture is what drew it.
 */
const { renderer, backend, reason } = await createRenderer(canvas, {
  maxDevicePixelRatio: 1.75,
});

const readout = document.querySelector('#backend');
if (readout !== null) readout.textContent = `${backend}: ${reason}`;

renderer.resize();
addEventListener('resize', () => renderer.resize());
```

Geometry built once, with colour as vertex data:

```ts sample=starter/main.ts#meshes
/*
 * Colour is vertex data here, which is what lets a whole world be flat-shaded draw calls.
 * `addBox` takes a centre and *half* extents, so this ground is 24 units across and the cube
 * is two units on a side.
 */
const shapes = new MeshBuilder();
shapes.addBox([0, 1, 0], [1, 1, 1], srgbColor(0.85, 0.45, 0.25));
const cube = renderer.createMesh(shapes.build());

const slab = new MeshBuilder();
slab.addBox([0, -0.25, 0], [12, 0.25, 12], srgbColor(0.3, 0.32, 0.36));
const ground = renderer.createMesh(slab.build());
```

A fixed-step simulation and a frame drawn between steps:

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

Input through named actions, so keyboard, gamepad and touch drive the same game:

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

`examples/first-game/main.ts` is the whole of a game: physics, a character, sound, shadows, a HUD,
and its rules in DriftScript. Read it before building anything larger than the starter.

## Rules the compiler cannot check

1. **Import only from package entry points** — `@driftengine/core` and the other `@driftengine/*`
   names. A path into a package's `src/` or `dist/` is private and changes without notice.
2. **Allocate nothing per frame.** Meshes, nodes, vectors and arrays are made once and rewritten in
   place. No object or array literals, closures, spreads or string building inside `simulate` or
   `render`.
3. **State changes in `simulate(dt)`; `render(alpha)` only draws**, interpolating the last two
   states with `alpha`. Anything that moves and ignores `alpha` judders on most displays.
4. **Quality options are chosen when the renderer is built**: `createRenderer(canvas, quality)`,
   with `bloom`, `bloomThreshold`, `hdrScene`, `ambientOcclusion`, `sceneSamples`,
   `directionalShadows` and the rest. Changing one means building a new renderer. Per frame, only
   `setBloom`, `setCameraMotionBlur` and `setOutputExposure` move.
5. **Randomness and time come from the game, not the platform**: a seeded generator such as
   `mulberry32(seed)` and the tick count, never `Math.random()` or `Date.now()` in game state.
6. **Decisions belong in DriftScript** (`.drs` files the Vite plugin compiles and hot-reloads), and
   are tested in Node: `loadModule` turns a compiled `.drs` import into callable functions. A script
   may import only the `drift/*` modules listed in `manifest.provides` in `vite.config.ts`.

## Traps that look like engine bugs

- **A lamp that does not glow**: emissive is multiplied by the environment's `nightFactor`, so with
  `nightFactor: 0` nothing emits and bloom finds nothing.
- **Bloom that does nothing**: it reads its threshold in scene units, so it needs `hdrScene: true`
  and a `bloomThreshold` something in the scene exceeds.
- **Colours that come out pale, or a model that comes out dark**: the renderer works in linear
  values and encodes them for the screen at the end (`outputTransform: 'srgb'`, the default), every
  pass and the clear colour alike. A colour picked by eye goes through `srgbColor(r, g, b)`, and a
  mesh whose colours were picked by eye is built with `build({ colorSpace: 'srgb' })`; an image of
  colours is uploaded as sRGB, which the model loaders do. A light's intensity is an amount, not a
  look, and stays as it is.
- **A box twice the size intended**: `addBox(centre, halfExtents, colour)` takes half extents.
- **A blank or stretched canvas**: the canvas is sized by CSS and `renderer.resize()` reads that
  size back; call it once and on every `resize`. A canvas inside `display: none` has no size.
- **A custom shader that paints over everything**: depth is reversed (`REVERSED_DEPTH`), so the far
  plane is 0 and the compare is `greater`. Writing `1.0` as "far" writes the near plane.
- **Hot reload that reloads the whole page**: Vite finds `import.meta.hot.accept(` by reading the
  source, so the call must be spelled out, not reached through a variable.
- **Testing one backend**: `?backend=webgl2` or `?backend=webgpu` forces one; the engine badge over
  the first seconds is declined with `?splash=0`. `look` does both for you.
- **No sound for a player on a gamepad alone**: a browser starts audio only after a key press, a
  click or a touch on the page, and a gamepad button is none of them. Make the audio graph on the
  first `keydown` or `pointerdown`, as the first-game template does, and say on screen that a key
  or a tap turns the sound on.

## Seeing past the first seconds

`look` photographs the game as it starts. To check what a player reaches by playing, drive the page
with the instruments `look` is built from, which the engine ships in `@driftengine/core/scripts/`:
`browser.mjs`'s `launch` and `requireHardwareGpu` start a browser on the real GPU, `look.mjs`'s
`gpuFlagsFor()` gives that system's flags and `lookUrl(url, backend)` the address, and `cdp.mjs`'s
`connect(port)` and `client.page(url)` open the game. On a page, `page.call('Input.dispatchKeyEvent',
{ type: 'keyDown', code: 'KeyW', key: 'w' })` holds a key and `keyUp` lets it go, `page.frames(n)`
lets frames pass, `page.screenshot(file)` photographs and `page.logs` holds the console. Close the
page, the client and then the browser when done, or a browser is left running.

## Finding the API for the installed version

```sh
node -p "require('@driftengine/core/package.json').version"
```

- **Types**: `node_modules/@driftengine/core/dist/index.d.ts` names every export and the module it
  comes from; the comment documenting it is in that module's own `.d.ts`, so follow the path. The
  renderer's methods, for both backends, are documented in `dist/render/backend/webgl2/renderer.d.ts`,
  and physics, which core re-exports, in `node_modules/@driftengine/physics/dist/`. Search before
  guessing a name: `grep -rn "addTube" node_modules/@driftengine/*/dist --include=*.d.ts`.
- **DriftScript**, the language itself: `node_modules/driftscript/docs/LANGUAGE.md` covers its
  types, `let` and `var`, its operators and that nothing converts implicitly. What a script may
  call from the engine is the manual's `scripting/reach.md`.
- **The manual**, one Markdown page per subject, at the installed version's tag:
  [references/manual.md](references/manual.md) lists every page and its address.
- **The examples**, one capability each, typechecked and runnable at that tag:
  [references/examples.md](references/examples.md).
- **The packages** and what each one adds: [references/packages.md](references/packages.md).
- Online, for a person: https://driftengine.dev/docs. The whole manual as one file:
  https://driftengine.dev/llms-full.txt (about 1 MB; prefer a single page).
