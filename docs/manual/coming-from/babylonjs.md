---
title: Coming from Babylon.js
description: What a Babylon.js engine, scene, render loop, mesh builder, light, loader and Havok body become in DriftEngine, with the same program written in both.
packages: ['@driftengine/core', '@driftengine/assets', '@driftengine/physics']
areas: []
covers: []
plain: []
---

# Coming from Babylon.js

Checked against Babylon.js 9.29.0, released on 1 October 2026, and its documentation and source at
that version, on 3 October 2026.

Babylon.js and DriftEngine are both game engines for the web, with a renderer on WebGPU and WebGL2,
physics, audio, input and a debugging overlay, so most of what a Babylon.js developer knows has a
counterpart here. Three things change the most. The engine is right-handed. No scene object holds
what is drawn: a program keeps its meshes and nodes, and draws them every frame. And the game's
rules run on a fixed step, sixty times a second, separately from drawing.

## The first program

A lit box, turning, from the shape of the Babylon.js getting-started chapter:

```js
import * as BABYLON from '@babylonjs/core';

const canvas = document.querySelector('#stage');
const engine = await BABYLON.EngineFactory.CreateAsync(canvas);
addEventListener('resize', () => engine.resize());

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0.3, 0.3, 0.7, 1);

const camera = new BABYLON.FreeCamera('camera', new BABYLON.Vector3(0, 0, -3), scene);
camera.setTarget(BABYLON.Vector3.Zero());
camera.fov = Math.PI / 3;

const light = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.4, -0.8, 0.3), scene);

const box = BABYLON.MeshBuilder.CreateBox('box', { size: 1 }, scene);
const material = new BABYLON.StandardMaterial('green', scene);
material.diffuseColor = new BABYLON.Color3(0.2, 0.75, 0.35);
box.material = material;

engine.runRenderLoop(() => {
  box.rotation.y += (engine.getDeltaTime() / 1000) * 1.2;
  scene.render();
});
```

The same program here:

```ts sample=snippets/coming-from.ts#program
/** The background, picked by eye and so stated through `srgbColor`: the renderer grades a clear. */
const CLEAR = srgbColor(0.3, 0.3, 0.7);

/** A lit box on a canvas, turning. Every piece is a value the program holds. */
export async function spinningBox(canvas: HTMLCanvasElement): Promise<void> {
  /* WebGPU where the browser has it, WebGL2 where it does not; `backend` says which. */
  const { renderer, backend } = await createRenderer(canvas, {});
  console.info(`drawn by ${backend}`);
  renderer.resize();
  addEventListener('resize', () => renderer.resize());

  /* The light points toward the sun, and colours are 0 to 1. */
  const environment = createEnvironment({
    directionalDir: [0.4, 0.8, 0.3],
    directionalColor: [1, 0.97, 0.9],
    ambient: [0.2, 0.22, 0.27],
  });

  /* A box by its centre and its half extents: this one is one metre on a side. */
  const box = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.5], [0.2, 0.75, 0.35]).build(),
  );
  const node = new SceneNode();

  const camera = new Camera();
  camera.fovYDeg = 60;
  camera.position[2] = 3;
  camera.lookAt(0, 0, 0);

  /* The rules run sixty times a second, whatever the display does. Drawing happens once a
     frame, between the last two steps by `alpha`. */
  let angle = 0;
  let previous = 0;
  startLoop({
    simulate(dt) {
      previous = angle;
      angle += dt * 1.2;
    },
    render(alpha) {
      node.setRotationAxisAngle(0, 1, 0, previous + (angle - previous) * alpha);
      node.updateWorld();
      camera.updateMatrices(canvas.width / Math.max(1, canvas.height));
      renderer.beginFrame(CLEAR);
      renderer.bindMeshPass(camera, environment);
      renderer.drawMesh(box, node.worldMatrix);
      renderer.endFrame();
    },
  });
}
```

Line by line:

- **The engine.** `BABYLON.EngineFactory.CreateAsync` picks WebGPU where the browser has it and
  WebGL where it does not. `createRenderer(canvas)` does the same, and `backend` says which it got.
  One renderer object answers for both, and nothing in a game branches on the backend.
- **The scene.** There is no `BABYLON.Scene`. A `SceneNode` is the nearest thing to a
  `BABYLON.TransformNode`, a transform with a parent, and the frame draws a mesh at a node's
  `worldMatrix`. A mesh the frame stops drawing is gone, and there is nothing to dispose from a
  scene.
- **The box.** `BABYLON.MeshBuilder.CreateBox` takes a full `size`. `addBox` takes a centre and
  **half** extents, so the same box is `[0.5, 0.5, 0.5]`.
- **The material.** The colour here is vertex data, which `MeshBuilder` writes for every shape. A
  textured surface is set before a draw with `renderer.setMaterial`, closest to a
  `BABYLON.PBRMaterial`, which [Materials](../rendering/materials.md) covers.
- **The light.** A `BABYLON.DirectionalLight` is given the direction its light travels.
  `directionalDir` points the other way, from the scene toward the light, and its Z has the other
  sign because of the handedness: the light above becomes `directionalDir: [0.4, 0.8, 0.3]`.
- **The camera.** Both cameras keep the vertical field of view fixed by default. Babylon.js gives
  it in radians, `fovYDeg` in degrees. The camera here sits at positive Z looking toward negative
  Z, which is the Babylon.js camera at negative Z, mirrored by the handedness.
- **The loop.** `runRenderLoop` calls back once per displayed frame, and a game scales its motion
  by `getDeltaTime()`. `startLoop` calls `simulate` sixty times a second with a fixed `dt`, however
  fast the display is, and `render` once per displayed frame with `alpha`, how far the display has
  got between the last two steps. Rules go in `simulate`, drawing in `render`.
  [The loop](../start/the-loop.md) explains why, and [Hello world](../start/hello-world.md) is this
  program in full, with its rule in DriftScript.

## Conventions

|                     | Babylon.js                                                      | DriftEngine                                                 |
| ------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Handedness          | left-handed by default; `scene.useRightHandedSystem` changes it | right-handed: X right, Y up, a camera looks down negative Z |
| Moving a scene over | negate every Z, or set `scene.useRightHandedSystem`             | nothing                                                     |
| A box               | a full `size`, or `width`, `height` and `depth`                 | a centre and half extents                                   |
| A rotation          | `rotation` in Euler radians, or `rotationQuaternion`            | a quaternion, `x, y, z, w`, or `setRotationAxisAngle`       |
| A directional light | the direction the light travels                                 | `directionalDir`, toward the light                          |
| Field of view       | `fov` in radians, vertical by default                           | `fovYDeg`, vertical, in degrees                             |
| A colour            | `BABYLON.Color3` and `BABYLON.Color4`                           | `[r, g, b]` from 0 to 1                                     |
| Time                | `engine.getDeltaTime()`, in milliseconds                        | the loop's `dt`, a fixed sixtieth of a second               |

[Coordinates and units](../concepts/coordinates.md) has the rest, including how a world larger than
single precision stays exact.

## What each thing is called

| Babylon.js                                                | DriftEngine                                                                                            | Where                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `BABYLON.Engine`, `BABYLON.WebGPUEngine`                  | `createRenderer`, one renderer with two backends                                                       | [Backends](../concepts/backends.md)                                                                |
| `BABYLON.Scene`, `BABYLON.TransformNode`                  | `SceneNode`, parented with `attachChild`                                                               | [The scene graph](../concepts/scene-graph.md)                                                      |
| `BABYLON.MeshBuilder`                                     | `MeshBuilder`, uploaded once with `renderer.createMesh`                                                | [Meshes](../rendering/meshes.md)                                                                   |
| `BABYLON.PBRMaterial`                                     | `renderer.setMaterial`, with colour, packed ORM, normal and emissive maps                              | [Materials](../rendering/materials.md)                                                             |
| `BABYLON.PBRMaterial.anisotropy`, `subSurface` scattering | `anisotropicModel`, and `skinModel` with `skinScattering: 'screen-space'`; hair and eye models besides | [Materials](../rendering/materials.md)                                                             |
| eight bone influences, `matricesIndicesExtra`             | `joints2` and `weights2` beside `joints` and `weights`                                                 | [Meshes](../rendering/meshes.md)                                                                   |
| thin instances, instanced meshes                          | instanced draws                                                                                        | [Instancing](../rendering/instancing.md)                                                           |
| `BABYLON.PointLight`, `BABYLON.SpotLight`                 | point and spot lights, chosen per frame                                                                | [Lights](../rendering/lights.md)                                                                   |
| `BABYLON.ShadowGenerator`, cascaded shadows               | the sun's shadow map, and shadows from point and spot lights                                           | [Shadows](../rendering/shadows.md)                                                                 |
| the default rendering pipeline                            | bloom, ambient occlusion and antialiasing, and passes of your own                                      | [Post-processing](../rendering/post-processing.md), [Custom passes](../rendering/custom-passes.md) |
| `BABYLON.ImportMeshAsync`, asset containers               | a `.drft` container baked ahead of time, or a model converted in a worker                              | [Importing models](../content/importing-models.md)                                                 |
| animation groups, skeletons                               | clips, blend trees and IK                                                                              | [Animation](../simulation/animation.md)                                                            |
| `scene.pick`                                              | a ray through a pixel against meshes registered for picking                                            | [Picking](../rendering/picking.md)                                                                 |
| the Havok plugin, `BABYLON.PhysicsAggregate`              | `PhysicsWorld`, the engine's own                                                                       | [Rigid bodies](../simulation/rigid-bodies.md)                                                      |
| Babylon.js GUI                                            | interface trees with layout, focus and themes                                                          | [Interface](../interface/interface.md)                                                             |
| the Inspector                                             | the in-game tools overlay                                                                              | [In-game tools](../tools/in-game-tools.md)                                                         |
| WebXR experience helpers                                  | WebXR sessions, the head, controllers and hands; drawing into a headset is not built yet               | [XR](../interface/xr.md)                                                                           |

## Loading a model

```js
import { registerBuiltInLoaders } from '@babylonjs/loaders/dynamic';

registerBuiltInLoaders();
const result = await BABYLON.ImportMeshAsync('models/lantern.glb', scene);
```

```ts sample=snippets/coming-from.ts#model
/**
 * A model baked to a `.drft` ahead of time, streamed in a few parts a frame. A draw function is
 * what the game calls inside its frame, once the camera and the light are bound.
 */
export function streamedModel(renderer: RendererApi, url: string) {
  const loader = new DrftLoader(renderer);
  void loader.load(url, { footprint: 1, height: 1.5 });
  const at = new SceneNode();
  at.updateWorld();
  return function draw(dt: number): void {
    loader.update(dt);
    const textures = loader.textures;
    const image = (index: number) => (index >= 0 ? (textures?.at(index) ?? null) : null);
    for (const part of loader.parts) {
      renderer.setMaterial({
        albedo: image(part.albedo),
        orm: image(part.orm),
        normal: image(part.normal),
        emissive: image(part.emissive),
      });
      renderer.drawMesh(part.mesh, at.worldMatrix);
    }
    renderer.setMaterial(null);
  };
}
```

A model is usually baked once, ahead of time, into a `.drft` container whose bytes are already
laid out the way a GPU takes them, and `DrftLoader` streams it in a few parts a frame, so it builds
up on screen instead of arriving after a wait. A game that has to open a model the player supplies
converts it in a worker, which [Importing models](../content/importing-models.md) shows with a
glTF, an OBJ and an STL. A load never throws: `progress` says what happened.

## Physics

```js
import HavokPhysics from '@babylonjs/havok';

const havok = await HavokPhysics();
scene.enablePhysics(new BABYLON.Vector3(0, -9.8, 0), new BABYLON.HavokPlugin(true, havok));

const sphere = BABYLON.MeshBuilder.CreateSphere('ball', { diameter: 2 }, scene);
sphere.position.y = 4;
new BABYLON.PhysicsAggregate(sphere, BABYLON.PhysicsShapeType.SPHERE, { mass: 1, restitution: 0.75 }, scene);
const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 10, height: 10 }, scene);
new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
```

```ts sample=snippets/coming-from.ts#physics
/**
 * A ball dropped on a floor. The world belongs to the game, steps inside `simulate`, and is read
 * back into a node to draw.
 */
export function fallingBall() {
  const world = new PhysicsWorld();
  world.addBody({ type: BODY_STATIC, shape: boxShape(5, 0.5, 5), y: -0.5 });
  const ball = world.addBody({
    type: BODY_DYNAMIC,
    shape: sphereShape(1),
    y: 4,
    restitution: 0.75,
  });
  const node = new SceneNode();
  return {
    simulate(dt: number): void {
      world.step(dt);
    },
    place(): SceneNode {
      const b = world.bodies;
      node.setPosition(b.posX[ball] ?? 0, b.posY[ball] ?? 0, b.posZ[ball] ?? 0);
      node.rotation[0] = b.rotX[ball] ?? 0;
      node.rotation[1] = b.rotY[ball] ?? 0;
      node.rotation[2] = b.rotZ[ball] ?? 0;
      node.rotation[3] = b.rotW[ball] ?? 1;
      node.markMoved();
      node.updateWorld();
      return node;
    },
  };
}
```

A physics body is attached to nothing. The world belongs to the game, steps inside `simulate` on
the loop's fixed step, and the frame reads the bodies back into whatever it draws them with, here a
node. The engine's physics is its own and deterministic: two runs of the same inputs reach the same
state tick for tick, checked by a fingerprint, which is what
[lockstep networking](../systems/networking.md) and replays rest on. Babylon.js's
`deterministicLockstep` engine option runs animations on a fixed step too; here the fixed step is
the only loop there is.

## What works differently

- **The frame is a list of calls.** `beginFrame`, `bindMeshPass` with a camera and an environment,
  any number of draws, `endFrame`. Order and visibility are the program's, which is also why
  [culling](../concepts/scene-graph.md) is something a program asks for.
- **Quality is decided when the renderer is made.** Shadows, anti-aliasing, the output transform
  and most other options size GPU memory, so changing one means making a new renderer.
  [Render quality](../concepts/quality.md) lists them.
- **Emissive light has a switch.** Nothing glows, whatever its emissive colour, until the
  environment's `nightFactor` is above zero. The name is about night scenes, not the clock.
- **Rules live in DriftScript.** A `.drs` file is imported like a module and reloads in place while
  the game runs, with nothing reset. [DriftScript in a game](../scripting/driftscript.md) covers
  what belongs in one.
