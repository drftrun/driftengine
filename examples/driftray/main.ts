/**
 * A room open on one side, where the sun lands on one wall and the rest is lit by what bounces off
 * it. Every few seconds that wall is repainted, red then blue.
 *
 * With DriftRay on, probes are traced against distance fields every frame, so the far wall
 * follows the repaint over the next few sweeps of the grid. With it off, the probes keep the bounce
 * they were baked with, the colour the room was when it loaded. DriftRay runs on WebGPU; on
 * WebGL2 this page shows the baked bounce. The switch builds a new renderer in place, and the
 * clock carries on.
 */
import { bakeObjectSdf } from '@driftengine/assets';
import { MeshBuilder, SceneNode, computeLightMatrix, createEnvironment } from '@driftengine/core';
import type { RendererApi, ShadowCasters, Vec3 } from '@driftengine/core';
import { controls, flag, openScene } from '../common/stage';
import type { SceneHooks } from '../common/stage';

const WHITE: Vec3 = [0.82, 0.82, 0.82];
const RED: Vec3 = [0.9, 0.06, 0.06];
const BLUE: Vec3 = [0.06, 0.1, 0.9];

/** The room's slabs: floor, ceiling, back wall, the sunlit wall on the left, the far wall. */
const slabs: { centre: Vec3; half: Vec3; painted?: boolean }[] = [
  { centre: [0, -1.5, 0], half: [3, 0.2, 3] },
  { centre: [0, 1.5, 0], half: [3, 0.2, 3] },
  { centre: [0, 0, -3], half: [3, 1.5, 0.2] },
  { centre: [-3, 0, 0], half: [0.2, 1.5, 3], painted: true },
  { centre: [3, 0, 0], half: [0.2, 1.5, 3] },
];

// #region fields
/** Each slab as a distance field, baked at its own origin and placed by a matrix. */
const placed = slabs.map((slab) => ({
  slab,
  field: bakeObjectSdf(new MeshBuilder().addBox([0, 0, 0], slab.half, WHITE).build(), 64),
  model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...slab.centre, 1]),
}));

/** Declared every frame: what the rays may hit, and what colour each surface is. */
function declareFields(renderer: RendererApi, paint: Vec3): void {
  for (const { slab, field, model } of placed)
    renderer.addDistanceField(field, model, slab.painted ? paint : WHITE);
}
// #endregion

/** Pointing at the sun, which reaches in through the open front, under the ceiling, onto the left. */
const env = createEnvironment({
  directionalDir: [0.45, 0.6, 0.66],
  directionalColor: [2.6, 2.5, 2.35],
  ambient: [0.01, 0.01, 0.012],
  ambientGround: [0.005, 0.005, 0.006],
});
const fixed = new SceneNode();
fixed.updateWorld();
const lightMatrix = new Float32Array(16);
env.lightViewProj = lightMatrix;
env.shadowStrength = 1;
let time = 0;

/** What one renderer draws: the room in both paints, and the probes that light it. */
function build(renderer: RendererApi): SceneHooks {
  const roomIn = (paint: Vec3) => {
    const builder = new MeshBuilder();
    for (const slab of slabs) builder.addBox(slab.centre, slab.half, slab.painted ? paint : WHITE);
    return renderer.createMesh(builder.build());
  };
  const rooms = { red: roomIn(RED), blue: roomIn(BLUE) };
  let painted = rooms.red;
  const casters: ShadowCasters = (sink) => sink.mesh(painted, fixed.worldMatrix);

  // #region probes
  /** A grid of probes through the room, rasterised once so the first frame is already lit. */
  renderer.setProbeGrid({
    origin: [-1.8, -0.6, -1.8],
    spacing: [1.2, 1.2, 1.2],
    counts: [4, 2, 4],
  });
  env.shadowDepthSpan = computeLightMatrix(
    env.directionalDir,
    0,
    0,
    0,
    6,
    renderer.shadowMapSize,
    lightMatrix,
  );
  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters(casters);
  renderer.endShadowPass();
  renderer.bakeProbeGrid([0, 0, 0], (probeCamera) => {
    renderer.bindMeshPass(probeCamera, env);
    renderer.drawMesh(rooms.red, fixed.worldMatrix);
  });
  // #endregion

  return {
    simulate(dt) {
      time += dt;
    },
    render() {
      const { camera } = scene;
      const blue = Math.floor(time / 6) % 2 === 1;
      painted = blue ? rooms.blue : rooms.red;

      camera.fovYDeg = 60;
      camera.near = 0.1;
      camera.position[0] = 0.4;
      camera.position[1] = 0;
      camera.position[2] = 2.4;
      camera.lookAt(Math.sin(time * 0.2) * 0.8, -0.1, -2);

      renderer.beginShadowPass(lightMatrix, 'static');
      renderer.drawShadowCasters(casters);
      renderer.endShadowPass();

      renderer.beginFrame([0, 0, 0]);
      renderer.bindMeshPass(camera, env);
      // #region frame
      declareFields(renderer, blue ? BLUE : RED);
      // #endregion
      renderer.drawMesh(painted, fixed.worldMatrix);
      renderer.endFrame();
    },
  };
}

// #region quality
/**
 * Indirect light only where it runs, and a probe array for it to write into. Turning it on or off
 * changes what the renderer is built with, so the switch builds a new one in place.
 */
const quality = (traced: string) => (backend: string) => ({
  indirectLight: traced === 'on' && backend === 'webgpu',
  reflectionProbeSize: 64,
  directionalShadows: true,
  directionalShadowMaxDistance: 12,
  outputTransform: 'aces' as const,
});
const scene = await openScene(quality(flag('driftray', 'on')), build);
// #endregion

controls([
  {
    key: 'driftray',
    label: 'DriftRay',
    value: flag('driftray', 'on'),
    options: [
      { text: 'on', value: 'on' },
      { text: 'off', value: 'off' },
    ],
    change: (value) => scene.rebuild(quality(value)),
  },
]);
