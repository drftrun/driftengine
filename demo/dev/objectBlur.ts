/**
 * Motion blur by each drawn object's own motion: a box crossing a still camera's view.
 *
 *     /objectBlur.html?recon=1&blur=1              the box, a mover, smears along its path; the
 *                                                  bars behind it, still, stay sharp
 *     /objectBlur.html?recon=1&blur=1&mover=0      the same box with no mover: the camera is still,
 *                                                  so nothing smears — the camera's motion alone
 *     /objectBlur.html?recon=1&blur=1&max=0.005    the longest smear capped at half a percent
 *
 * The box moves a fixed step a frame, so however many frames a capture waits it is moving at the
 * same speed when photographed. The smear is read off a capture: how many pixels of the row through
 * the box's middle lie between the background's level and the box's white. Nothing under `src/` may
 * import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createMover,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
/** Metres a frame: fast enough that a frame's travel is many pixels across. */
const STEP = 0.08;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  const max = Number(ASKED.get('max') ?? 'NaN');
  renderer.setCameraMotionBlur(1, Number.isFinite(max) ? max : undefined);
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  const bars = new MeshBuilder();
  for (let i = 0; i < 9; i++)
    bars.addBox([-8 + i * 2, 0, -6], [0.5, 4, 0.1], [0.35, 0.35, 0.35], 1);
  const wall = renderer.createMesh(bars.build());
  const box = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.6, 0.6, 0.6], [1, 1, 1], 1).build(),
  );
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const model = new Float32Array(identity);
  const mover = ASKED.get('mover') === '0' ? null : createMover();
  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.1;
  camera.far = 50;
  camera.position[2] = 6;
  camera.updateMatrices(aspect);
  const env = createEnvironment({ fogDensity: 0, ambient: [1, 1, 1], directionalColor: [0, 0, 0] });
  let frame = 0;
  const draw = (): void => {
    frame += 1;
    model[12] = -3 + ((frame * STEP) % 6);
    renderer.beginFrame([0.05, 0.05, 0.06]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(wall, identity);
    renderer.drawMesh(box, model, 0, null, mover);
    renderer.endFrame();
    requestAnimationFrame(draw);
  };
  draw();
  stats.textContent = `${created.backend} · object blur · ${location.search}`;
}

void main();
