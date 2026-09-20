/**
 * The program the native host's start is measured with (`../startup.mjs`): `examples/starter`'s lit
 * cube, mounted on a canvas it is given so that one source runs in both targets.
 *
 * **It reports its first frame as an error**, because an error is what a shipped desktop shell
 * forwards from its page to the process's output (`consoleForward.ts`), and the same line from both
 * targets is what lets one harness time both. `performance.now()` at three points goes with it:
 * since the process began on the native host, since the page's navigation in a browser.
 */
import {
  Camera,
  MeshBuilder,
  SceneNode,
  createEnvironment,
  createRenderer,
  startLoop,
} from '@driftengine/core';

export async function mount(canvas: HTMLCanvasElement): Promise<void> {
  const mounted = performance.now();
  const { renderer, backend } = await createRenderer(canvas, {
    maxDevicePixelRatio: 1.75,
    directionalShadows: true,
  });
  renderer.resize();
  const ready = performance.now();

  const environment = createEnvironment({
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

  let spin = 0;
  let previousSpin = 0;
  let drawn = 0;
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
      renderer.bindMeshPass(camera, environment);
      renderer.drawMesh(ground, stillness.worldMatrix);
      renderer.drawMesh(cube, spinner.worldMatrix);
      renderer.endFrame();
      drawn += 1;
      if (drawn === 1) {
        const [m, r, f] = [mounted, ready, performance.now()].map((t) => t.toFixed(0));
        console.error(
          `[startup] first frame on ${backend}: mount ${m} ms, renderer ${r} ms, frame ${f} ms`,
        );
      }
    },
  });
}
