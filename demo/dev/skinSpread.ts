/**
 * How far screen-space skin spreads a step of light, at a face's distance.
 *
 *     /skinSpread.html?skinscatter=screen     the step spread by the blur
 *     /skinSpread.html                        the step as the lit stage draws it, pre-integrated
 *     ...&radius=0.012&near=0.75              the skin's radius and how far away the plane stands
 *
 * **A step rather than a face, because a step can be worked by hand.** One plane of skin, square
 * to the eye, white, and split down the middle: the left half faces the sun and the right half is
 * edge-on to it, so the light the blur spreads is a step from one to nothing across a single column,
 * at one depth, and nothing else. On the dark side at `x` metres from the step the spread light is
 * what the kernel's taps beyond `x` on the lit side weigh, so a column's red is a number
 * `skinBlur.ts` computes, and the page is a measurement of the kernel's width in pixels against it.
 *
 * Deterministic: a fixed camera, no clock.
 */
import {
  Camera,
  createEnvironment,
  createRenderer,
  skinModel,
} from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const BACKGROUND: Vec3 = [0, 0, 0];

/** Two coplanar quads at depth `near`, the left facing the eye and the right edge-on to it. */
function steppedPlane(near: number): MeshData {
  const h = 0.5;
  const z = -near;
  /* Left: x from -h to 0, normal +z. Right: x from 0 to h, normal +x, so N·L is 0 under a sun on +z. */
  const corners = [-h, -h, 0, -h, 0, h, -h, h, 0, -h, h, -h, h, h, 0, h];
  const positions = new Float32Array(8 * 3);
  for (let v = 0; v < 8; v++)
    positions.set([corners[v * 2] ?? 0, corners[v * 2 + 1] ?? 0, z], v * 3);
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ]);
  return {
    positions,
    normals,
    colors: new Float32Array(8 * 3).fill(1),
    emissive: new Float32Array(8),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  const radius = Number(ASKED.get('radius') ?? 0.012);
  const near = Number(ASKED.get('near') ?? 0.75);
  const env = createEnvironment({
    directionalDir: [0, 0, 1],
    directionalColor: [0.6, 0.6, 0.6],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    fogDensity: 0,
  });
  const camera = new Camera();
  camera.fovYDeg = 50;
  camera.near = 0.05;
  camera.far = 20;
  camera.lookAt(0, 0, -1);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const plane = renderer.createMesh(steppedPlane(near));
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const material = {
    model: skinModel({ scatterColor: [0.707, 0.48, 0.36], radius, transmission: 0 }),
  };
  const frame = (): void => {
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial(material);
    renderer.drawMesh(plane, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · skin step · ${location.search}`;
}

void main();
