/**
 * A dynamic mesh rewritten every frame, drawn alone and instanced.
 *
 *     /dynamicMesh.html                   WebGPU
 *     /dynamicMesh.html?recon=1           with DriftTR, whose motion vectors read last frame's positions
 *     /dynamicMesh.html?backend=webgl2    the other backend
 *
 * A sheet of 48 by 48 vertices carrying coordinates, a tangent frame and a colour per vertex — so
 * the attributes that do not move outweigh the two that do — rewritten each frame as a travelling
 * wave, positions and normals, the way a cloth solver hands its result over. Drawn once as a mesh
 * and three times through an instanced batch, which is the widest binding a draw makes.
 *
 * **What is measured**: since 4.8.4 a dynamic mesh's positions and normals are buffers of their own
 * on WebGPU, so the picture must be the one the interleaved layout drew — the same build before and
 * after, held at the same frame — with no device error, and the two backends must agree. The bytes
 * an update sends are `buffers.test.ts`'s to count. Deterministic: sixty frames of a fixed clock,
 * then held. Nothing under `src/` may import this.
 */
import {
  Camera,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const SIDE = 48;
const SIZE = 2.4;
const FRAMES = 60;

/** The flat sheet: positions in x and y, facing +z, with every attribute a garment carries. */
function sheet(): MeshData {
  const n = SIDE * SIDE;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const tangents = new Float32Array(n * 4);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const v = y * SIDE + x;
      const u = x / (SIDE - 1);
      const w = y / (SIDE - 1);
      positions.set([(u - 0.5) * SIZE, (w - 0.5) * SIZE, 0], v * 3);
      normals.set([0, 0, 1], v * 3);
      colors.set([0.35 + 0.6 * u, 0.3 + 0.5 * w, 0.85 - 0.5 * u], v * 3);
      uvs.set([u, w], v * 2);
      tangents.set([1, 0, 0, 1], v * 4);
    }
  }
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
    uvs,
    tangents,
    indices: new Uint32Array(indices),
  };
}

/** The wave at time `t`, written into `positions` and `normals`: what a solver would hand over. */
function wave(t: number, positions: Float32Array, normals: Float32Array): void {
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const v = y * SIDE + x;
      const px = (x / (SIDE - 1) - 0.5) * SIZE;
      const py = (y / (SIDE - 1) - 0.5) * SIZE;
      const z = 0.18 * Math.sin(px * 3 + t * 2.4) * Math.cos(py * 2 - t * 1.3);
      const dzdx = 0.18 * 3 * Math.cos(px * 3 + t * 2.4) * Math.cos(py * 2 - t * 1.3);
      const dzdy = -0.18 * 2 * Math.sin(px * 3 + t * 2.4) * Math.sin(py * 2 - t * 1.3);
      const length = Math.hypot(dzdx, dzdy, 1);
      positions.set([px, py, z], v * 3);
      normals.set([-dzdx / length, -dzdy / length, 1 / length], v * 3);
    }
  }
}

function at(x: number, y: number, z: number, into: Float32Array, offset = 0): Float32Array {
  into.set(IDENTITY, offset);
  into[offset + 12] = x;
  into[offset + 13] = y;
  into[offset + 14] = z;
  return into;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
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
  const mesh = renderer.createMesh(data, { dynamic: true });
  const batch = renderer.createInstanced(mesh, 3);
  const instances = createMeshInstances(3);
  for (let i = 0; i < 3; i++) {
    at(1.4, 1.6 - i * 1.6, -0.5, instances.models, i * 16);
    instances.tints.set([1, 1 - i * 0.2, 1 - i * 0.3], i * 3);
  }
  instances.count = 3;
  renderer.uploadInstanced(batch, instances);
  const positions = new Float32Array(data.positions.length);
  const normals = new Float32Array(data.normals.length);
  const model = at(-1.6, 0, 0, new Float32Array(16));

  let frames = 0;
  const frame = (): void => {
    wave(frames / 60, positions, normals);
    renderer.updateMesh(mesh, positions, normals);
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(mesh, model);
    renderer.drawInstanced(batch, instances);
    renderer.endFrame();
    frames += 1;
    if (frames === FRAMES) {
      stats.textContent = `${renderer.backend}`;
      (window as unknown as { __dynamicMeshReady: boolean }).__dynamicMeshReady = true;
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
