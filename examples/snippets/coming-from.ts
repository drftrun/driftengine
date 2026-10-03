/**
 * The engine's side of the pages for developers coming from another engine: the first program
 * every engine's manual opens with, a model, and a falling ball.
 *
 * A snippet, typechecked with the examples and quoted by the manual's coming-from pages.
 */
import { DrftLoader } from '@driftengine/assets';
import {
  Camera,
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createRenderer,
  startLoop,
} from '@driftengine/core';
import type { RendererApi } from '@driftengine/core';
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  PhysicsWorld,
  boxShape,
  sphereShape,
} from '@driftengine/physics';

// #region program
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
// #endregion

// #region model
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
// #endregion

// #region physics
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
// #endregion
