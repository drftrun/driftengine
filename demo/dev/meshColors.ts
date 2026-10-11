/**
 * A mesh recoloured in place: `updateMeshColors` against a mesh made again with the same colours.
 *
 *     /meshColors.html                    WebGPU, the colours rewritten every frame
 *     /meshColors.html?mode=create        the control: a static mesh made once with the last colours
 *     /meshColors.html?mode=none          the sheet's own colours, never rewritten
 *     /meshColors.html?dynamic=1          positions dynamic as well, so both kinds of buffer bind
 *     /meshColors.html?backend=webgl2     the other backend
 *
 * **What it proves.** A sheet is shaded again every frame by its distance from a point that moves,
 * the way ground is shaded with its distance from a camera, and the last frame's colours are drawn
 * held. `mode=create` draws those same colours from a mesh made with them, so the two pictures must
 * be identical to the pixel on each backend; `mode=none` must differ, which is what shows the
 * rewrite reached the screen at all. Drawn once alone and three times instanced, the widest binding
 * a draw of it makes. The first vertex's red is a little past 1 in every mode, so the control's
 * colours stay floats as the rewritten ones are and nothing is rounded to sixteen bits on one side
 * only. Deterministic: sixty frames of a fixed clock, then held. Nothing under `src/` may import this.
 */
import {
  Camera,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const SIDE = 48;
const SIZE = 1.4;
const FRAMES = 60;

/** The flat sheet, facing +z, coloured by where each vertex is. */
function sheet(): MeshData {
  const n = SIDE * SIDE;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const v = y * SIDE + x;
      const u = x / (SIDE - 1);
      const w = y / (SIDE - 1);
      positions.set([(u - 0.5) * SIZE, (w - 0.5) * SIZE, 0], v * 3);
      normals.set([0, 0, 1], v * 3);
      colors.set([0.35 + 0.6 * u, 0.3 + 0.5 * w, 0.85 - 0.5 * u], v * 3);
    }
  }
  colors[0] = 1.02;
  const indices: number[] = [];
  for (let y = 0; y < SIDE - 1; y++) {
    for (let x = 0; x < SIDE - 1; x++) {
      const a = y * SIDE + x;
      indices.push(a, a + 1, a + SIDE, a + 1, a + SIDE + 1, a + SIDE);
    }
  }
  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(n),
    indices: new Uint32Array(indices),
  };
}

/** The sheet's colours darkened with distance from a point that circles it at `time`. */
function shade(data: MeshData, time: number, out: Float32Array): void {
  const cx = Math.cos(time * 2) * 0.8;
  const cy = Math.sin(time * 2) * 0.8;
  for (let v = 0; v < out.length / 3; v++) {
    const dx = (data.positions[v * 3] as number) - cx;
    const dy = (data.positions[v * 3 + 1] as number) - cy;
    const near = Math.max(0.15, 1 - Math.sqrt(dx * dx + dy * dy) / 2);
    out[v * 3] = (data.colors[v * 3] as number) * near;
    out[v * 3 + 1] = (data.colors[v * 3 + 1] as number) * near;
    out[v * 3 + 2] = (data.colors[v * 3 + 2] as number) * near;
  }
  out[0] = 1.02;
}

function at(x: number, y: number, z: number, out: Float32Array, offset = 0): Float32Array {
  out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1], offset);
  return out;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') ?? 'update';
  const dynamic = params.get('dynamic') === '1';
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment();
  env.directionalDir = [-0.5, 0.6, 0.62];
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.3, 0.32, 0.36];
  env.shadowStrength = 0;
  env.fogDensity = 0;

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.3;
  camera.far = 100;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  camera.position[1] = 0.4;
  camera.position[2] = 7.5;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(aspect);

  const data = sheet();
  const colors = new Float32Array(data.colors.length);
  const last = (FRAMES - 1) / 60;
  if (mode === 'create') shade(data, last, colors);
  const mesh = renderer.createMesh(mode === 'create' ? { ...data, colors } : data, {
    dynamic,
    dynamicColors: mode === 'update',
  });
  const batch = renderer.createInstanced(mesh, 3);
  const instances = createMeshInstances(3);
  for (let i = 0; i < 3; i++) {
    at(1.4, 1.6 - i * 1.6, -0.5, instances.models, i * 16);
    instances.tints.set([1, 1 - i * 0.2, 1 - i * 0.3], i * 3);
  }
  instances.count = 3;
  renderer.uploadInstanced(batch, instances);
  const model = at(-1.6, 0, 0, new Float32Array(16));

  let frames = 0;
  const frame = (): void => {
    if (mode === 'update') {
      shade(data, frames / 60, colors);
      renderer.updateMeshColors(mesh, colors);
    }
    if (dynamic) renderer.updateMesh(mesh, data.positions, data.normals);
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, model);
    renderer.drawInstanced(batch, instances);
    renderer.endFrame();
    frames += 1;
    if (frames === FRAMES) {
      stats.textContent = `${renderer.backend} ${mode}${dynamic ? ' dynamic' : ''}`;
      (window as unknown as { __meshColorsReady: boolean }).__meshColorsReady = true;
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
