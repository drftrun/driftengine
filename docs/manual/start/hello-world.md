---
title: Hello world
description: A complete first program. A renderer on a canvas, light, two meshes, a camera and a loop that turns a cube on a fixed clock.
packages: ['@driftengine/core']
areas: ['render', 'scene', 'geometry']
---

# Hello world

The smallest DriftEngine program that is still a game draws a lit cube on a ground plane and turns
it on a fixed clock. It's about a hundred lines, and every later page builds on the same five
pieces: a renderer, an environment, meshes, a scene, and a loop.

<!-- run: starter -->

The whole file is `examples/starter/main.ts`, and it is the one to copy when you begin a project.
This page walks through it from the top.

## The imports

Everything comes from the package's top level.

```ts sample=starter/main.ts#imports
import {
  Camera,
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createRenderer,
  startLoop,
} from '@driftengine/core';
```

## A renderer on the canvas

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

`createRenderer` is asynchronous because asking the browser for a WebGPU adapter is. It tries WebGPU
first and falls back to WebGL2 on its own, so a game never branches on the backend. What it hands
back says what happened: `renderer` is the object you draw with, `backend` is `'webgpu'` or
`'webgl2'`, and `reason` explains the choice in words.

The second argument is the render quality profile. `maxDevicePixelRatio` caps how many pixels the
drawing buffer gets per CSS pixel, which is the single biggest cost on a phone with a dense screen.
Quality options are decided when the renderer is built, because most of them size GPU memory, and
changing one means building a new renderer.

`renderer.resize()` reads the canvas's CSS size and sets the drawing buffer to match. Call it once
at the start and again whenever the window changes size.

## Light and air

```ts sample=starter/main.ts#environment
/** Light, air and ground bounce. Chosen once, because these are allocation-sized decisions. */
const ENV = createEnvironment({
  directionalDir: [0.4, 0.7, 0.35],
  directionalColor: [1, 0.96, 0.88],
  ambient: [0.2, 0.22, 0.28],
  ambientGround: [0.08, 0.08, 0.1],
  emissiveGain: 0,
  nightFactor: 0,
  fogColor: [0.16, 0.18, 0.24],
  fogDensity: 0.004,
  fogHeightFalloff: 0.03,
  fogBaseY: 0,
});
```

An `Environment` is the lighting and atmosphere for a frame: a directional light that points
**toward** the sun, an ambient fill from above and a separate one from the ground, and fog that
thickens with distance and thins with height. `createEnvironment` fills every field you leave out
with a value that means nothing special, so you only write the ones you care about.

`nightFactor` is worth knowing about early, because its name misleads. It is the switch for emissive
light: at 0 nothing in the world glows, however bright its emissive value. It has nothing to do with
the clock.

## Meshes

```ts sample=starter/main.ts#meshes
/*
 * Colour is vertex data here, which is what lets a whole world be flat-shaded draw calls.
 * `addBox` takes a centre and *half* extents, so this ground is 24 units across and the cube
 * is two units on a side.
 */
const shapes = new MeshBuilder();
shapes.addBox([0, 1, 0], [1, 1, 1], [0.85, 0.45, 0.25]);
const cube = renderer.createMesh(shapes.build());

const slab = new MeshBuilder();
slab.addBox([0, -0.25, 0], [12, 0.25, 12], [0.3, 0.32, 0.36]);
const ground = renderer.createMesh(slab.build());
```

A `MeshBuilder` collects shapes into one mesh. `addBox` takes a centre, **half** extents and a colour,
so the ground here is 24 metres across. Colour is per vertex, which is why neither mesh needs a
texture. The builder also has spheres, capsules, cylinders, tubes, quads and more, and every shape
you add to one builder becomes part of the same mesh, drawn in one call.

`renderer.createMesh` uploads the result to the GPU and returns a handle. Do this once, at load,
never in the frame.

## The scene

```ts sample=starter/main.ts#scene
const spinner = new SceneNode();
spinner.setPosition(0, 1, 0);
const stillness = new SceneNode();
stillness.updateWorld();

const camera = new Camera();
camera.position[0] = 6;
camera.position[1] = 4.5;
camera.position[2] = 8;
camera.lookAt(0, 1, 0);
```

A `SceneNode` holds a position, a rotation and a scale, and computes a `worldMatrix` from them when
you call `updateWorld()`. Nodes can be parented, and a child's world matrix includes its parent's.
The ground never moves, so its node is updated once.

The `Camera` is a perspective camera. Set its `position` and call `lookAt`, or set `yaw` and `pitch`
directly: yaw 0 looks toward negative Z, and positive yaw turns right.

## The loop

```ts sample=starter/main.ts#loop
/*
 * Two angles, because that is what `alpha` is for. The simulation advances in fixed steps and
 * the display does not, so a frame almost never lands on a step boundary: drawing `spin`
 * directly judders at any refresh rate that is not a multiple of the step. Interpolating
 * between the last two states is the whole reason the loop hands `alpha` over.
 */
let spin = 0;
let previousSpin = 0;

startLoop({
  simulate(dt) {
    previousSpin = spin;
    spin += dt * 0.8;
  },
  render(alpha) {
    spinner.setRotationAxisAngle(0, 1, 0, previousSpin + (spin - previousSpin) * alpha);
    spinner.updateWorld();

    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

    renderer.beginFrame([0.05, 0.06, 0.09]);
    renderer.bindMeshPass(camera, ENV);
    renderer.drawMesh(ground, stillness.worldMatrix);
    renderer.drawMesh(cube, spinner.worldMatrix);
    renderer.endFrame();
  },
});
```

`startLoop` calls your `simulate` at a fixed 60 steps a second, however fast the display refreshes,
and calls `render` once per displayed frame. `render` receives `alpha`, how far the display has got
between the last simulated step and the next, and the cube's angle is drawn at exactly that point
between its previous and current value. [The loop](the-loop.md) explains why this is the whole
difference between smooth motion and judder.

The simplest frame is four calls: `beginFrame` with a clear colour, `bindMeshPass` with the
camera and the environment, any number of `drawMesh` calls with a mesh and a world matrix, and
`endFrame`.

## Where to go from here

You have a renderer, light, meshes, a camera and a loop, which is everything a game is drawn with.
Next, [The loop](the-loop.md) covers simulation, pause and the step counter, and
[Moving things](moving-things.md) covers input.
