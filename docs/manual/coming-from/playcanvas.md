---
title: Coming from PlayCanvas
description: What a PlayCanvas application, entity, component, script, light, asset and rigid body become in DriftEngine, with the same program written in both.
packages: ['@driftengine/core', '@driftengine/assets', '@driftengine/physics', '@driftengine/entities']
areas: []
covers: []
plain: []
---

# Coming from PlayCanvas

Checked against the PlayCanvas engine 2.23.0, released on 1 October 2026, and its user manual and
source at that version, on 3 October 2026. This page is about the engine used from code; the
PlayCanvas Editor is outside its scope.

PlayCanvas and DriftEngine are both game engines for the web, with a renderer on WebGPU and WebGL2,
physics stepped at a fixed rate, audio, input and Gaussian splats, and both keep the same axes: Y up
and a forward of negative Z. Two things change the most. No scene graph of entities holds what is
drawn: a program keeps its meshes and nodes, and draws them every frame. And behaviour is written
as DriftScript systems over components, where PlayCanvas attaches script classes to entities.

## The first program

The spinning box from the PlayCanvas guide to using the engine without the Editor, with a colour
and a directional light:

```js
import * as pc from 'playcanvas';

const canvas = document.getElementById('application');
const device = await pc.createGraphicsDevice(canvas, { deviceTypes: [pc.DEVICETYPE_WEBGPU] });

const options = new pc.AppOptions();
options.graphicsDevice = device;
options.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem];
options.resourceHandlers = [pc.TextureHandler, pc.ContainerHandler];

const app = new pc.AppBase(canvas);
app.init(options);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.start();
addEventListener('resize', () => app.resizeCanvas());

const camera = new pc.Entity();
camera.addComponent('camera', { clearColor: new pc.Color(0.3, 0.3, 0.7), fov: 60 });
camera.setPosition(0, 0, 3);
app.root.addChild(camera);

const light = new pc.Entity();
light.addComponent('light', { type: 'directional' });
light.setEulerAngles(45, 45, 0);
app.root.addChild(light);

const material = new pc.StandardMaterial();
material.diffuse = new pc.Color(0.2, 0.75, 0.35);
material.update();
const box = new pc.Entity();
box.addComponent('render', { type: 'box', material });
app.root.addChild(box);

app.on('update', (dt) => box.rotate(0, 70 * dt, 0));
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

- **The device.** `pc.createGraphicsDevice` tries the device types it is given and adds WebGL2 to
  the end of the list itself. `createRenderer(canvas)` does the same with WebGPU first, and
  `backend` says which it got. Nothing has to be registered first: there are no component systems
  or resource handlers to list, because a program imports what it uses.
- **The hierarchy.** There is no `app.root`. A `SceneNode` is the nearest thing to a
  `pc.GraphNode`, a transform with a parent, and the frame draws a mesh at a node's `worldMatrix`.
  A mesh the frame stops drawing is gone, and there is nothing to remove from a hierarchy.
- **The box.** A render component's `box` is a cube with sides of length 1. `addBox` takes a centre
  and **half** extents, so the same cube is `[0.5, 0.5, 0.5]`.
- **The material.** The colour here is vertex data, which `MeshBuilder` writes for every shape. A
  textured surface is set before a draw with `renderer.setMaterial`, which
  [Materials](../rendering/materials.md) covers.
- **The light.** A PlayCanvas directional light shines along its entity's negative Y axis, and is
  aimed by rotating the entity. `directionalDir` is a direction, from the scene toward the light.
- **The camera.** Both take a vertical field of view in degrees by default. The aspect ratio is
  given to `updateMatrices` each frame, so a resize needs nothing else.
- **The loop.** The application's `update` event comes once per frame with that frame's `dt`.
  `startLoop` calls `simulate` sixty times a second with a fixed `dt`, however fast the display is,
  and `render` once per displayed frame with `alpha`, how far the display has got between the last
  two steps. It is the arrangement PlayCanvas uses for its physics, applied to every rule. Rules go
  in `simulate`, and drawing goes in `render`. [The loop](../start/the-loop.md) explains why, and
  [Hello world](../start/hello-world.md) is this program in full, with its rule in DriftScript.

## Conventions

|                     | PlayCanvas                              | DriftEngine                                                      |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Axes                | Y up, forward is negative Z             | the same                                                         |
| Units               | a metre to a unit, for physics          | metres and seconds                                               |
| A rotation          | Euler angles in degrees, or a `pc.Quat` | a quaternion, `x, y, z, w`, or `setRotationAxisAngle` in radians |
| A box               | a unit cube, scaled by its entity       | a centre and half extents                                        |
| A directional light | along its entity's negative Y axis      | `directionalDir`, toward the light                               |
| A colour            | `pc.Color`, from 0 to 1                 | `[r, g, b]` from 0 to 1                                          |
| Time                | the frame's `dt`, in seconds            | the loop's `dt`, a fixed sixtieth of a second                    |

[Coordinates and units](../concepts/coordinates.md) has the rest, including how a world larger than
single precision stays exact.

## What each thing is called

| PlayCanvas                                          | DriftEngine                                                                | Where                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pc.createGraphicsDevice`, `pc.AppBase`             | `createRenderer`, one renderer with two backends                           | [Backends](../concepts/backends.md)                  |
| `pc.GraphNode`, `app.root`                          | `SceneNode`, parented with `attachChild`                                   | [The scene graph](../concepts/scene-graph.md)        |
| an entity and its components                        | an entity in a `World`, with components declared in DriftScript            | [Entities](../simulation/entities.md)                |
| a script class with `update(dt)`                    | a DriftScript system over a query                                          | [DriftScript in a game](../scripting/driftscript.md) |
| the render component                                | `MeshBuilder` and `renderer.createMesh`, drawn with `drawMesh`             | [Meshes](../rendering/meshes.md)                     |
| `pc.StandardMaterial`                               | `renderer.setMaterial`, with colour, packed ORM, normal and emissive maps  | [Materials](../rendering/materials.md)               |
| `pc.StandardMaterial` anisotropy, `alphaToCoverage` | `anisotropicModel`, and `cutoutMode: 'dithered'`, which the frame resolves | [Materials](../rendering/materials.md)               |
| the light component                                 | the environment's sun, and point and spot lights                           | [Lights](../rendering/lights.md)                     |
| a container asset from a glTF                       | a `.drft` container baked ahead of time, or a model converted in a worker  | [Importing models](../content/importing-models.md)   |
| the anim component                                  | clips, blend trees and IK                                                  | [Animation](../simulation/animation.md)              |
| the rigidbody and collision components              | `PhysicsWorld`, the engine's own                                           | [Rigid bodies](../simulation/rigid-bodies.md)        |
| `app.systems.rigidbody` ray casts                   | rays and sweeps against the physics world                                  | [Queries](../simulation/queries.md)                  |
| the sound component                                 | a mix, placed sounds and rooms                                             | [Audio](../content/audio.md)                         |
| screen and element components                       | interface trees with layout, focus and themes                              | [Interface](../interface/interface.md)               |
| the gsplat component                                | splat captures                                                             | [Splats](../worlds/splats.md)                        |

## Behaviour

```js
import { Script } from 'playcanvas';

export class Fall extends Script {
  static scriptName = 'fall';

  vy = 0;
  bounce = 0.75;

  update(dt) {
    const p = this.entity.getLocalPosition();
    this.vy -= 9.81 * dt;
    let y = p.y + this.vy * dt;
    if (y < 0.35) {
      y = 0.35;
      this.vy = -this.vy * this.bounce;
    }
    this.entity.setLocalPosition(p.x, y, p.z);
  }
}
```

A script class belongs to one entity and runs once a frame. A DriftScript system runs once a step
over every entity that has the components it names, and says which it reads and writes, so the
engine can order systems and check their access. The same fall, from the
[in-game tools example](../tools/in-game-tools.md), as one system over every ball:

```drs sample=tools/balls.drs#rules
let GRAVITY: f32 = 9.81
let FLOOR: f32 = 0.35
// Slower than this at the floor and a ball stops bouncing.
let REST: f32 = 0.4

system Fall {
    writes Ball

    update {
        for e in query<Ball>() {
            e.Ball.vy = e.Ball.vy - GRAVITY / 60
            e.Ball.y = e.Ball.y + e.Ball.vy / 60
            if e.Ball.y < FLOOR {
                e.Ball.y = FLOOR
                let speed = 0 - e.Ball.vy
                if speed > REST {
                    e.Ball.impact = speed
                    e.Ball.hits = e.Ball.hits + 1
                    e.Ball.vy = speed * e.Ball.bounce
                } else {
                    e.Ball.vy = 0
                }
            }
        }
    }
}
```

The components are declared in the same language, and a game adds them to entities in a `World`
from TypeScript or from another script. A `.drs` file reloads in place while the game runs, with
every entity keeping its values. [Entities](../simulation/entities.md) covers worlds, queries,
prefabs and rewinding them.

## Loading a model

```js
const asset = new pc.Asset('lantern', 'container', { url: 'models/lantern.glb' });
app.assets.add(asset);
asset.ready(() => app.root.addChild(asset.resource.instantiateRenderEntity()));
app.assets.load(asset);
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

PlayCanvas's physics is ammo.js, a WebAssembly build of Bullet, through the rigidbody and collision
components. The engine's is its own, and deterministic: two runs of the same inputs reach the same
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

A body is attached to nothing. The world belongs to the game, steps inside `simulate` on the loop's
fixed step, and the frame reads the bodies back into whatever it draws them with, here a node.

## What works differently

- **The frame is a list of calls.** `beginFrame`, `bindMeshPass` with a camera and an environment,
  any number of draws, `endFrame`. Order and visibility are the program's, which is also why
  [culling](../concepts/scene-graph.md) is something a program asks for.
- **Quality is decided when the renderer is made.** Shadows, anti-aliasing, the output transform
  and most other options size GPU memory, so changing one means making a new renderer.
  [Render quality](../concepts/quality.md) lists them.
- **Emissive light has a switch.** Nothing glows, whatever its emissive colour, until the
  environment's `nightFactor` is above zero. The name is about night scenes, not the clock.
