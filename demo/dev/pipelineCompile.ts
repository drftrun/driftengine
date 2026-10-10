/**
 * What a frame does when its draws first need pipelines it has not compiled: a grid of boxes drawn
 * plain, then from frame 40 each column under a material of its own — two-sided, and shading by a
 * surface model — every one a lit variant no mesh's creation warmed.
 *
 *     /pipelineCompile.html?compile=wait   the default: built where asked, the frame held for it
 *     /pipelineCompile.html?compile=skip   started off the thread, each column left out until its
 *                                          compile lands
 *     /pipelineCompile.html?backend=webgl2 the other backend, whose surface models compile at a draw
 *
 * **What is measured**: the longest interval between two frames from frame 30 on, and how many
 * frames passed before `ready()`, asked at the switch, said every compile had landed — the frames a
 * skipping column was left out. A frame held for a compile shows in the first; a column left out in
 * the second. `window.__drawn` turns true at frame 160, with the readout written.
 * Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  anisotropicModel,
  createEnvironment,
  createRenderer,
  eyeModel,
  hairModel,
  skinModel,
} from '../../packages/core/src/index';
import type { RendererApi, SurfaceMaterial, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const SWITCH = 40;
const FRAMES = 160;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const compile = ASKED.get('compile') === 'skip' ? 'skip' : 'wait';
  const created = await createRenderer(
    canvas,
    { ...askedQuality(), pipelineCompile: compile },
    DEV_RENDERER,
  );
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  const box = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.4, 0.4, 0.4], [0.7, 0.6, 0.5]).build(),
  );
  await renderer.ready();

  /* Eight columns, each a variant of its own: four models, each one-sided and two-sided. */
  const models = [skinModel(), eyeModel(), hairModel(), anisotropicModel()];
  const materials: SurfaceMaterial[] = [];
  for (const model of models) {
    for (const doubleSided of [false, true]) materials.push({ model, doubleSided });
  }
  const env = createEnvironment();
  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.position[2] = 9;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const model = new Float32Array(16);

  let frame = 0;
  let last = 0;
  let longest = 0;
  let landed = -1;
  /* Each frame's interval from frame 30 on, to name the long ones. */
  const intervals = new Float32Array(FRAMES);
  const draw = (now: number): void => {
    if (frame >= 30 && last > 0) {
      longest = Math.max(longest, now - last);
      intervals[frame] = now - last;
    }
    last = now;
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    for (let c = 0; c < materials.length; c++) {
      renderer.setMaterial(frame >= SWITCH ? (materials[c] as SurfaceMaterial) : null);
      for (let r = 0; r < 4; r++) {
        model.fill(0);
        model[0] = model[5] = model[10] = model[15] = 1;
        model[12] = (c - 3.5) * 0.9;
        model[13] = (r - 1.5) * 0.9;
        renderer.drawMesh(box, model);
      }
    }
    renderer.setMaterial(null);
    renderer.endFrame();
    if (frame === SWITCH) {
      void renderer.ready().then(() => {
        landed = frame - SWITCH;
      });
    }
    frame += 1;
    stats.textContent =
      `${created.backend} · ${compile} · longest frame from 30 on ${longest.toFixed(1)} ms · ` +
      `compiles landed ${landed < 0 ? 'not yet' : `${landed} frames after the switch`}` +
      ` · frames over 50 ms: ${longFrames(intervals)}`;
    if (frame < FRAMES) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

/** Each frame over 50 ms, as `frame:ms`, relative to the switch. */
function longFrames(intervals: Float32Array): string {
  const out: string[] = [];
  intervals.forEach((ms, frame) => {
    if (ms > 50) out.push(`${frame - SWITCH}:${ms.toFixed(0)}`);
  });
  return out.join(' ') || 'none';
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
