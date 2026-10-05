/**
 * Eight skin influences against four, photographed.
 *
 *     /skinEight.html                   WebGPU
 *     /skinEight.html?backend=webgl2    the other backend
 *
 * Two bars of the same shape, bent by the same eight joints. Each vertex is weighted over all eight
 * by a broad bell around its height, so it leans on about six of them, and the joints push it
 * alternately left and right: the left bar keeps all eight influences (`joints2`), the right keeps
 * the heaviest four, renormalised, which is what an import gave before 4.8.4. **What is measured**:
 * the two bars bend differently, so the second set reached the shader; the left bar is the same on
 * both backends; and each bar's shadow on the floor bends as its bar does, so the caster read the
 * same influences the visible draw did.
 *
 * Deterministic: one frame, one fixed palette. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshData, RendererApi, ShadowCasterSink, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const JOINTS = 8;
const RINGS = 33;
const HEIGHT = 2.4;
/** How far each joint pushes what it holds, along x: alternately, so dropping four shows. */
const PUSH = [0, 0.35, -0.35, 0.35, -0.35, 0.35, -0.35, 0];

function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** A square bar of rings up y, skinned over eight joints by a broad bell; `four` keeps four. */
function bar(four: boolean): MeshData {
  const sides: readonly (readonly [number, number])[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const n = RINGS * 4;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const joints = new Float32Array(n * 4);
  const weights = new Float32Array(n * 4);
  const joints2 = new Float32Array(n * 4);
  const weights2 = new Float32Array(n * 4);
  for (let r = 0; r < RINGS; r++) {
    const y = (r / (RINGS - 1)) * HEIGHT;
    const bell: { joint: number; weight: number }[] = [];
    for (let j = 0; j < JOINTS; j++) {
      const d = (y - (j / (JOINTS - 1)) * HEIGHT) / 0.55;
      bell.push({ joint: j, weight: Math.exp(-d * d) });
    }
    bell.sort((a, b) => b.weight - a.weight);
    const kept = four ? bell.slice(0, 4) : bell;
    let sum = 0;
    for (const b of kept) sum += b.weight;
    for (let s = 0; s < 4; s++) {
      const v = r * 4 + s;
      const side = sides[s] as readonly [number, number];
      positions.set([side[0] * 0.1, y, side[1] * 0.1], v * 3);
      normals.set([side[0] * Math.SQRT1_2, 0, side[1] * Math.SQRT1_2], v * 3);
      kept.forEach((b, i) => {
        const into = i < 4 ? joints : joints2;
        const wInto = i < 4 ? weights : weights2;
        into[v * 4 + (i % 4)] = b.joint;
        wInto[v * 4 + (i % 4)] = b.weight / sum;
      });
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < RINGS - 1; r++) {
    for (let s = 0; s < 4; s++) {
      const a = r * 4 + s;
      const b = r * 4 + ((s + 1) % 4);
      indices.push(a, a + 4, b, b, a + 4, b + 4);
    }
  }
  return {
    positions,
    normals,
    colors: new Float32Array(n * 3).fill(0.8),
    emissive: new Float32Array(n),
    joints,
    weights,
    ...(four ? {} : { joints2, weights2 }),
    indices: new Uint32Array(indices),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const env = createEnvironment();
  env.directionalDir = [0.45, 0.8, 0.4];
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.35, 0.37, 0.4];
  env.shadowStrength = 0.9;
  env.fogDensity = 0;

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.3;
  camera.far = 100;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  camera.position[1] = 1.6;
  camera.position[2] = 6;
  camera.lookAt(0, 1.1, 0);
  camera.updateMatrices(aspect);

  const floor = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.05, 0], [4, 0.05, 3], [0.7, 0.7, 0.72]).build(),
  );
  const eight = renderer.createMesh(bar(false));
  const four = renderer.createMesh(bar(true));
  const palette = new Float32Array(JOINTS * 16);
  for (let j = 0; j < JOINTS; j++) {
    palette.set(IDENTITY, j * 16);
    palette[j * 16 + 12] = PUSH[j] as number;
  }

  /* The bars cast into the sun's map through their skinned casters, which is half of the test. */
  const lightMatrix = new Float32Array(16);
  env.shadowDepthSpan = computeLightMatrix(
    env.directionalDir,
    0,
    1,
    0,
    6,
    renderer.shadowMapSize,
    lightMatrix,
  );
  env.lightViewProj = lightMatrix;
  const casters = (sink: ShadowCasterSink): void => {
    sink.skinnedMesh(eight, at(-0.9, 0, 0), palette);
    sink.skinnedMesh(four, at(0.9, 0, 0), palette);
  };
  renderer.beginShadowPass(lightMatrix, 'static');
  renderer.drawShadowCasters(casters);
  renderer.endShadowPass();

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.drawMesh(floor, IDENTITY);
  renderer.setSkinPalette(palette);
  renderer.drawMesh(eight, at(-0.9, 0, 0));
  renderer.drawMesh(four, at(0.9, 0, 0));
  renderer.setSkinPalette(null);
  renderer.endFrame();

  stats.textContent = `${renderer.backend}`;
  (window as unknown as { __skinEightReady: boolean }).__skinEightReady = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
