/**
 * The height fog from a distance along the ray: `Atmosphere.fogStart`.
 *
 *     /fogStart.html?transform=srgb&hdr=1&start=10   eight white patches at 2, 5, 9, 12, 20, 35, 60
 *                                                    and 100 m under black haze of 0.08 a metre:
 *                                                    the first three read 255, and the rest read
 *                                                    sRGB(e^(-0.08 (r - 10))) with r the distance
 *                                                    along the ray to the column's centre, which
 *                                                    is off the axis: 237, 178, 97, 25, 0
 *     /fogStart.html?transform=srgb&hdr=1&start=0    the medium from the eye, as before the field:
 *                                                    234 at 2 m, 209 at 5 m
 *
 * Measured 2026-10-06 on both backends, with and without the composite, to those numbers.
 *     /fogStart.html?...&falloff=0.1&rise=0.2        the haze thinning with height, the patches
 *                                                    climbing as they recede
 *
 * Each patch is unlit, square to the camera and sized by its distance so that it fills one eighth
 * of the frame's width, so a capture reads its fog at the centre of its column. Nothing under
 * `src/` may import this.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { MeshData, RendererApi } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const FOV = 50;
const DISTANCES = [2, 5, 9, 12, 20, 35, 60, 100];
const number = (name: string, fallback: number): number => {
  const asked = Number(ASKED.get(name));
  return ASKED.has(name) && Number.isFinite(asked) ? asked : fallback;
};

/** One patch a column, each at its distance, filling an eighth of the width and the middle third. */
function patches(aspect: number, rise: number): MeshData {
  const tanY = Math.tan((FOV * Math.PI) / 360);
  const tanX = tanY * aspect;
  const positions: number[] = [];
  const indices: number[] = [];
  DISTANCES.forEach((d, column) => {
    const x0 = (-tanX + (2 * tanX * column) / 8) * d;
    const x1 = (-tanX + (2 * tanX * (column + 1)) / 8) * d;
    const y0 = (-tanY / 3) * d + rise * d;
    const y1 = (tanY / 3) * d + rise * d;
    const base = positions.length / 3;
    positions.push(x0, y0, -d, x1, y0, -d, x1, y1, -d, x0, y1, -d);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(count * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    colors: new Float32Array(count * 3).fill(1),
    emissive: new Float32Array(count),
    indices: new Uint32Array(indices),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  const rise = number('rise', 0);
  const mesh = renderer.createMesh(patches(aspect, rise));
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const camera = new Camera();
  camera.fovYDeg = FOV;
  camera.near = 0.1;
  camera.far = 200;
  camera.updateMatrices(aspect);
  const env = createEnvironment({
    fogColor: [0, 0, 0],
    fogDensity: number('density', 0.08),
    fogHeightFalloff: number('falloff', 0),
    fogBaseY: 0,
  });
  env.fogStart = number('start', 0);
  const frame = (): void => {
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawTranslucentMesh(mesh, identity, 1, { lit: false });
    renderer.endFrame();
    requestAnimationFrame(frame);
  };
  frame();
  stats.textContent = `${created.backend} · fog start · ${location.search}`;
}

void main();
