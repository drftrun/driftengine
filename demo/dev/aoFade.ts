/**
 * Ambient occlusion that fades out with distance, photographed.
 *
 *     /aoFade.html                       the control: occlusion off
 *     /aoFade.html?ao=1                  occlusion everywhere the depth reaches
 *     /aoFade.html?ao=1&fade=30,20       whole to 30 m from the eye, gone by 50 m
 *     ...&backend=webgl2
 *
 * A ground running away from the camera with a box on either side every ten metres, out to 400 m,
 * and a stepped ridge 3 km off. Close up, each box's foot is a join the occlusion should darken;
 * far off, the depth buffer's steps are metres apart, and an estimate that reaches them shades the
 * ridge in bands that follow them rather than anything touching anything.
 *
 * **What is measured** is how much each band of the frame darkens against the control: with the
 * fade, the near boxes darken as they do without it, the boxes past 50 m and the ridge not at all.
 * **A failure** is the near boxes darkening less than without the fade, or anything past it
 * darkening at all.
 *
 * Deterministic: one fixed light, one fixed camera, one frame. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const ASKED = new URLSearchParams(location.search);

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const fade = ASKED.get('fade')?.split(',').map(Number) ?? null;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  if (fade !== null) renderer.setAmbientOcclusionFade(fade[0] ?? -1, fade[1] ?? 0);

  const env = createEnvironment();
  env.directionalDir = [0.3, 0.8, 0.52];
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.45, 0.47, 0.5];
  env.shadowStrength = 0;
  env.fogDensity = 0;

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 5000;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  camera.position[0] = 0;
  camera.position[1] = 1.6;
  camera.position[2] = 0;
  camera.lookAt(0, 1.2, -100);
  camera.updateMatrices(aspect);

  const builder = new MeshBuilder().addBox([0, -0.1, -2000], [60, 0.1, 2000], [0.7, 0.7, 0.72]);
  for (let z = -10; z >= -400; z -= 10) {
    builder.addBox([-4, 0.75, z], [0.75, 0.75, 0.75], [0.72, 0.7, 0.68]);
    builder.addBox([4, 0.75, z], [0.75, 0.75, 0.75], [0.72, 0.7, 0.68]);
  }
  /* The ridge: steps rising away, wide enough to fill the horizon. */
  for (let i = 0; i < 12; i++) {
    builder.addBox([0, 20 + i * 25, -3000 - i * 60], [3000, 20 + i * 25, 30], [0.5, 0.55, 0.5]);
  }
  const world = renderer.createMesh(builder.build());

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(world, IDENTITY);
  renderer.endFrame();

  stats.textContent =
    `${renderer.backend}` + (fade === null ? '' : ` · fade ${fade[0] ?? -1} over ${fade[1] ?? 0}`);
  (window as unknown as { __drawn: boolean }).__drawn = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
