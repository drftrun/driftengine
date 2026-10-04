/**
 * Ambient occlusion and what stands in front of it, photographed.
 *
 *     /aoCoverage.html?ao=1                  occlusion on
 *     /aoCoverage.html                       the control: occlusion off
 *     ...&backend=webgl2, ...&taa=1, ...&recon=1.5
 *
 * A floor meeting a wall, which the occlusion darkens along the join, and three stretches of that
 * join: on the left a pane drawn at 0.85 opacity in front of it, in the middle nothing, and on the
 * right a dense cluster of smoke. The occlusion is measured from the depth the opaque world left,
 * and neither the pane nor the smoke writes any, so until 4.8.3 the composite darkened them by the
 * join behind them as though they were not there.
 *
 * **What is measured** is how much each stretch darkens between the two captures. The middle is
 * the control and darkens fully. The pane must darken by about 0.15 of that, which is what it lets
 * through, and the smoke by what its puffs let through. **A failure** is the pane or the smoke
 * darkening as much as the middle, or the middle darkening less than it did.
 *
 * Deterministic: one fixed light, one fixed camera, a clock that is not read, a fixed plan of
 * puffs. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { ParticleInstances, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const PUFFS = 48;

function at(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[0] = sx;
  m[5] = sy;
  m[10] = sz;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** A dense cluster of puffs about a point on the join, placed by a fixed plan. */
function puffs(): ParticleInstances {
  const data: ParticleInstances = {
    positions: new Float32Array(PUFFS * 3),
    sizes: new Float32Array(PUFFS),
    spins: new Float32Array(PUFFS),
    colors: new Float32Array(PUFFS * 3),
    alphas: new Float32Array(PUFFS),
    ages: new Float32Array(PUFFS),
    seeds: new Float32Array(PUFFS),
    velocities: new Float32Array(PUFFS * 3),
    count: PUFFS,
    capacity: PUFFS,
  };
  for (let i = 0; i < PUFFS; i++) {
    const a = i * 2.399963;
    const r = 0.5 * Math.sqrt((i + 0.5) / PUFFS);
    data.positions.set([2.4 + Math.cos(a) * r, 0.35 + Math.sin(a) * r * 0.8, -2.6], i * 3);
    data.sizes[i] = 0.45;
    data.spins[i] = a;
    data.colors.set([0.82, 0.82, 0.84], i * 3);
    data.alphas[i] = 0.9;
    data.ages[i] = 0.3;
    data.seeds[i] = (i * 0.618034) % 1;
  }
  return data;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;

  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment();
  env.directionalDir = [0.3, 0.8, 0.52];
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.45, 0.47, 0.5];
  env.shadowStrength = 0;
  env.fogDensity = 0;

  const camera = new Camera();
  camera.fovYDeg = 46;
  camera.near = 0.3;
  camera.far = 100;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  camera.position[0] = 0;
  camera.position[1] = 1.4;
  camera.position[2] = 3.5;
  camera.lookAt(0, 0.6, -3);
  camera.updateMatrices(aspect);

  const room = renderer.createMesh(
    new MeshBuilder()
      .addBox([0, -0.1, -1], [8, 0.1, 6], [0.7, 0.7, 0.72])
      .addBox([0, 2, -3.1], [8, 2, 0.1], [0.7, 0.7, 0.72])
      .build(),
  );
  const pane = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.8, 0.6, 0.01], [0.9, 0.9, 0.9]).build(),
  );
  const smoke = renderer.createParticles(PUFFS, { material: 'smoke', blend: 'alpha', erosion: 0 });
  const data = puffs();

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(room, IDENTITY);
  renderer.drawTranslucentMesh(pane, at(-2.4, 0.6, -2.6), 0.85, { lit: false });
  renderer.drawParticles(smoke, data, camera, env, 0);
  renderer.endFrame();

  stats.textContent = `${renderer.backend}`;
  (window as unknown as { __aoCoverageReady: boolean }).__aoCoverageReady = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
