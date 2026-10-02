# @driftengine/core

The runtime of DriftEngine, a WebGPU game engine for the web and for native apps. It draws through
WebGPU where the browser has a device and through WebGL2 everywhere else, behind one API, and it
carries the loop, the renderer, cameras, input, the scene graph, geometry, text
and the whole of [`@driftengine/physics`](https://driftengine.dev/docs/simulation/rigid-bodies),
which it re-exports. The rest of the engine is separate packages you add when you need them.

**Cost: 699.0 KB gzipped, importing `createRenderer`.** Measured by `scripts/size-gate.test.mjs`,
which fails the build if the figure drifts by more than 3%.

The manual is at **[driftengine.dev/docs](https://driftengine.dev/docs)**, with an example running
beside every chapter, and the reference for every export at
[driftengine.dev/docs/api](https://driftengine.dev/docs/api).

## Install

```sh
npm install @driftengine/core
```

It needs a browser with WebGL2, which is every current one, and an ES module bundler such as Vite.
[Installation](https://driftengine.dev/docs/start/installation) covers the page, TypeScript and the
backends.

## Quickstart

A lit cube turning on a fixed step, on a page with `<canvas id="stage">`:

```ts
import {
  Camera,
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createRenderer,
  startLoop,
} from '@driftengine/core';

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

const spinner = new SceneNode();
spinner.setPosition(0, 1, 0);
const stillness = new SceneNode();
stillness.updateWorld();

const camera = new Camera();
camera.position[0] = 6;
camera.position[1] = 4.5;
camera.position[2] = 8;
camera.lookAt(0, 1, 0);

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

This is the engine's `examples/starter`, and a test keeps the two the same.
[Hello world](https://driftengine.dev/docs/start/hello-world) walks through it, and
[Your first game](https://driftengine.dev/docs/start/first-game) builds a complete one.

## What is in it

|                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The frame      | A fixed-step [loop](https://driftengine.dev/docs/start/the-loop) with interpolation, [two backends](https://driftengine.dev/docs/concepts/backends) behind one API, [quality profiles](https://driftengine.dev/docs/concepts/quality), and a [frame](https://driftengine.dev/docs/concepts/the-frame) whose order you can read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Drawing        | [Meshes](https://driftengine.dev/docs/rendering/meshes), [materials](https://driftengine.dev/docs/rendering/materials), [instancing](https://driftengine.dev/docs/rendering/instancing), [lights](https://driftengine.dev/docs/rendering/lights) and [shadows](https://driftengine.dev/docs/rendering/shadows), [the sky](https://driftengine.dev/docs/rendering/sky-and-atmosphere), [fog and weather](https://driftengine.dev/docs/rendering/fog-and-weather), [water](https://driftengine.dev/docs/rendering/water), [reflections](https://driftengine.dev/docs/rendering/reflections), [post-processing](https://driftengine.dev/docs/rendering/post-processing), [particles](https://driftengine.dev/docs/rendering/particles), [text](https://driftengine.dev/docs/rendering/text-and-overlays) and [passes of your own](https://driftengine.dev/docs/rendering/custom-passes). |
| Light at scale | [DriftLight](https://driftengine.dev/docs/rendering/driftlight) for hundreds of fixed lights, [DriftRay](https://driftengine.dev/docs/rendering/driftray) for bounced light traced every frame, [DriftTR](https://driftengine.dev/docs/rendering/drifttr) for temporal reconstruction, and the [GPU-driven pipeline](https://driftengine.dev/docs/rendering/gpu-driven).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Worlds         | [Worlds bigger than a float](https://driftengine.dev/docs/worlds/large-worlds), streamed in cells, with [hierarchical detail](https://driftengine.dev/docs/worlds/hierarchical-detail) and [worlds built from a kit](https://driftengine.dev/docs/worlds/worlds-from-a-kit).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Physics        | Deterministic [rigid bodies](https://driftengine.dev/docs/simulation/rigid-bodies), [joints](https://driftengine.dev/docs/simulation/joints), [queries](https://driftengine.dev/docs/simulation/queries), [characters](https://driftengine.dev/docs/simulation/characters), [vehicles](https://driftengine.dev/docs/simulation/vehicles), and [ragdolls and cloth](https://driftengine.dev/docs/simulation/ragdolls-and-cloth).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Play           | [Input](https://driftengine.dev/docs/interface/input) from every device through one action map, [cameras that cut](https://driftengine.dev/docs/interface/cameras), [picking](https://driftengine.dev/docs/rendering/picking) and the [scene graph](https://driftengine.dev/docs/concepts/scene-graph).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## The other packages

Each is added when a game reaches for it, and a game that never imports one carries none of it.

| Package                                               | What it adds                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@driftengine/animation`                              | Skeletons, clips, blend trees and IK. [Guide](https://driftengine.dev/docs/simulation/animation)                       |
| `@driftengine/nav`                                    | Navigation meshes and routes. [Guide](https://driftengine.dev/docs/simulation/navigation)                              |
| `@driftengine/entities`                               | An entity component system with prefabs and rewind. [Guide](https://driftengine.dev/docs/simulation/entities)          |
| `@driftengine/chemistry`                              | Heat, burning, phase changes and smoke. [Guide](https://driftengine.dev/docs/simulation/chemistry)                     |
| `@driftengine/ai`                                     | Behaviour trees and agents. [Guide](https://driftengine.dev/docs/simulation/agents)                                    |
| `@driftengine/audio`                                  | A mix of buses, placed sounds, rooms and rhythm. [Guide](https://driftengine.dev/docs/content/audio)                   |
| `@driftengine/assets` and `@driftengine/drft`         | Model importers and the streaming `.drft` container. [Guide](https://driftengine.dev/docs/content/importing-models)    |
| `@driftengine/terrain`                                | Terrain drawn as a clipmap. [Guide](https://driftengine.dev/docs/worlds/terrain)                                       |
| `@driftengine/splats`                                 | Gaussian splat captures among meshes. [Guide](https://driftengine.dev/docs/worlds/splats)                              |
| `@driftengine/texture`                                | Materials as programs decoded on the device. [Guide](https://driftengine.dev/docs/worlds/drifttexture)                 |
| `@driftengine/capture`                                | A video clip turned into a surface, a collider and entities. [Guide](https://driftengine.dev/docs/worlds/driftcapture) |
| `@driftengine/ui2d`                                   | Sprites, tilemaps and interfaces. [Guide](https://driftengine.dev/docs/interface/sprites)                              |
| `@driftengine/script`                                 | DriftScript, the engine's scripting language, with hot reload. [Reference](https://driftengine.dev/docs/api/script)    |
| `@driftengine/network`                                | Rollback netcode. [Reference](https://driftengine.dev/docs/api/network)                                                |
| `@driftengine/xr`                                     | WebXR sessions. [Reference](https://driftengine.dev/docs/api/xr)                                                       |
| `@driftengine/media`                                  | Recording and exporting clips. [Reference](https://driftengine.dev/docs/api/media)                                     |
| `@driftengine/editor` and `@driftengine/tools`        | The editor and in-game tools. [Reference](https://driftengine.dev/docs/api/editor)                                     |
| `@driftengine/package` and `@driftengine/native-host` | Installable apps built from the same game. [Reference](https://driftengine.dev/docs/api/package)                       |

## Licence

Apache-2.0. Part of [DriftEngine](https://github.com/drftrun/driftengine); see
[`docs/ARCHITECTURE.md`](https://github.com/drftrun/driftengine/blob/main/docs/ARCHITECTURE.md) for
how the packages divide.
