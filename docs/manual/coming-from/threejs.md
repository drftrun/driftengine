---
title: Coming from Three.js
description: What a Three.js scene, renderer, animation loop, geometry, light and loader become in DriftEngine, with the same program written in both.
packages: ['@driftengine/core', '@driftengine/assets', '@driftengine/physics']
areas: []
covers: []
plain: ['GLTFLoader']
---

# Coming from Three.js

Checked against Three.js r186, released on 24 September 2026, and its manual and source at that
tag, on 3 October 2026.

Three.js is a library for drawing 3D on the web, and a game built on it chooses its own loop,
physics, input and audio. DriftEngine is a game engine: the renderer comes with a fixed-step loop,
its own physics, entities, input, audio, networking and a scripting language for the rules. Most of
what a Three.js developer knows carries over directly. The largest difference is that no scene
object holds what is drawn: a program keeps its meshes and nodes, and draws them every frame.

## The first program

The cube from the Three.js manual's first chapter, on its WebGPU renderer, lit and turning:

```js
import * as THREE from 'three/webgpu';

const renderer = new THREE.WebGPURenderer();
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.z = 3;

const light = new THREE.DirectionalLight(0xffffff, 3);
light.position.set(0.4, 0.8, 0.3);
scene.add(light);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x33bf59 }),
);
scene.add(cube);

renderer.setAnimationLoop((time) => {
  cube.rotation.y = (time / 1000) * 1.2;
  renderer.render(scene, camera);
});
```

The same program here:

```ts sample=snippets/coming-from.ts#program
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
      renderer.beginFrame([0.3, 0.3, 0.7]);
      renderer.bindMeshPass(camera, environment);
      renderer.drawMesh(box, node.worldMatrix);
      renderer.endFrame();
    },
  });
}
```

Line by line:

- **The renderer.** `createRenderer(canvas)` takes the canvas the page already has and is awaited,
  because asking for a WebGPU device is asynchronous. Like `THREE.WebGPURenderer`, it uses WebGPU
  where the browser has it and WebGL2 where it does not; `backend` says which it got.
- **The scene.** There is no `THREE.Scene` to add things to. A `SceneNode` is the nearest thing to
  a `THREE.Object3D`, a transform with a parent, and the frame draws a mesh at a node's
  `worldMatrix`. A mesh the frame stops drawing is gone, and there is nothing to remove.
- **The box.** `THREE.BoxGeometry(1, 1, 1)` takes the full width, height and depth. `addBox` takes
  a centre and **half** extents, so the same cube is `[0.5, 0.5, 0.5]`.
- **The material.** The colour here is vertex data, which `MeshBuilder` writes for every shape. A
  textured surface is set before a draw with `renderer.setMaterial`, which
  [Materials](../rendering/materials.md) covers.
- **The light.** A `THREE.DirectionalLight` shines from its `position` toward its `target`.
  `directionalDir` points the other way, from the scene toward the light, so a light placed at
  `(0.4, 0.8, 0.3)` aimed at the origin is `directionalDir: [0.4, 0.8, 0.3]`.
- **The camera.** Both cameras take a vertical field of view in degrees. The aspect ratio is given
  to `updateMatrices` each frame, so a resize needs nothing else.
- **The loop.** `setAnimationLoop` calls back once per display refresh with the time.
  `startLoop` calls `simulate` sixty times a second, however fast the display is, and `render` once
  per displayed frame with `alpha`, how far the display has got between the last two steps.
  Rules go in `simulate`, and drawing goes in `render`. [The loop](../start/the-loop.md) explains
  why, and [Hello world](../start/hello-world.md) is this program in full, with its rule in
  DriftScript.

## Conventions

|                     | Three.js                                                   | DriftEngine                                           |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| Axes                | Y up, a camera looks down its negative Z                   | the same, in metres and seconds                       |
| A box               | full width, height and depth                               | a centre and half extents                             |
| A rotation          | `rotation` in Euler radians, or `quaternion`               | a quaternion, `x, y, z, w`, or `setRotationAxisAngle` |
| A directional light | from `position` toward `target`                            | `directionalDir`, toward the light                    |
| A matrix            | `elements` column-major; `set()` takes rows                | a column-major `Float32Array` of sixteen              |
| A colour            | a hex number or a `THREE.Color`                            | `[r, g, b]` from 0 to 1                               |
| Time                | `THREE.Timer`, since `THREE.Clock` is deprecated from r183 | the loop's `dt`, a fixed sixtieth of a second         |

[Coordinates and units](../concepts/coordinates.md) has the rest, including how a world larger than
single precision stays exact.

## What each thing is called

| Three.js                                             | DriftEngine                                                                                                     | Where                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `THREE.WebGPURenderer`, `THREE.WebGLRenderer`        | `createRenderer`, one renderer with two backends                                                                | [Backends](../concepts/backends.md)                                                                |
| `THREE.Scene`, `THREE.Object3D`, `THREE.Group`       | `SceneNode`, parented with `attachChild`                                                                        | [The scene graph](../concepts/scene-graph.md)                                                      |
| `THREE.BufferGeometry`, the geometry classes         | `MeshBuilder`, uploaded once with `renderer.createMesh`                                                         | [Meshes](../rendering/meshes.md)                                                                   |
| `THREE.MeshStandardMaterial`                         | `renderer.setMaterial`, with colour, packed ORM, normal and emissive maps                                       | [Materials](../rendering/materials.md)                                                             |
| `THREE.MeshPhysicalMaterial.anisotropy`, `alphaHash` | a material's `model` — `anisotropicModel`, and hair, skin and eye models besides — and `cutoutMode: 'dithered'` | [Materials](../rendering/materials.md)                                                             |
| `THREE.CompressedTexture`                            | a `CompressedTextureSource` of BC blocks, where `renderer.compressedFormats` has the format                     | [Materials](../rendering/materials.md)                                                             |
| `THREE.InstancedMesh`                                | instanced draws                                                                                                 | [Instancing](../rendering/instancing.md)                                                           |
| `THREE.PointLight`, `THREE.SpotLight`                | point and spot lights, chosen per frame                                                                         | [Lights](../rendering/lights.md)                                                                   |
| shadow maps on a light                               | the sun's shadow map, and shadows from point and spot lights                                                    | [Shadows](../rendering/shadows.md)                                                                 |
| post-processing passes                               | bloom, ambient occlusion and antialiasing, and passes of your own                                               | [Post-processing](../rendering/post-processing.md), [Custom passes](../rendering/custom-passes.md) |
| `GLTFLoader`                                         | a `.drft` container baked ahead of time, or a model converted in a worker                                       | [Importing models](../content/importing-models.md)                                                 |
| `THREE.AnimationMixer`                               | clips, blend trees and IK                                                                                       | [Animation](../simulation/animation.md)                                                            |
| `THREE.Raycaster`                                    | a ray through a pixel against meshes registered for picking, and rays against the physics world                 | [Picking](../rendering/picking.md), [Queries](../simulation/queries.md)                            |
| a physics library beside it                          | `PhysicsWorld`, the engine's own                                                                                | [Rigid bodies](../simulation/rigid-bodies.md)                                                      |
| `THREE.Audio`, `THREE.PositionalAudio`               | a mix, placed sounds and rooms                                                                                  | [Audio](../content/audio.md)                                                                       |
| `renderer.xr`                                        | WebXR sessions, the head, controllers and hands; drawing into a headset is not built yet                        | [XR](../interface/xr.md)                                                                           |

## Loading a model

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const gltf = await new GLTFLoader().loadAsync('models/lantern.glb');
scene.add(gltf.scene);
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

`GLTFLoader` reads a glTF file when the page loads it. Here a model is usually baked once, ahead of
time, into a `.drft` container whose bytes are already laid out the way a GPU takes them, and
`DrftLoader` streams it in a few parts a frame, so it builds up on screen instead of arriving after
a wait. A game that has to open a model the player supplies converts it in a worker, which
[Importing models](../content/importing-models.md) shows with a glTF, an OBJ and an STL. A load
never throws: `progress` says what happened.

## Physics

Three.js has no physics of its own; its examples bring Ammo, Jolt or Rapier in through addons.
The engine has one, written for it, and deterministic: two runs of the same inputs reach the same
state tick for tick, checked by a fingerprint, which is what
[lockstep networking](../systems/networking.md) and replays rest on.

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

The world steps inside `simulate`, on the loop's fixed step, and the frame reads the bodies back. A
body is an index into flat arrays of positions and rotations, so reading every body costs no
allocation.

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
