/**
 * Local exposure, both forms, on a frame of two brightnesses.
 *
 *     /localExposure.html?hdr=1                      a wall in the sun, its left half pale and its
 *                                                    right half dark, striped ±30% in each
 *     /localExposure.html?hdr=1&local=0.5            the one number: each half moved half way to
 *                                                    the frame's held brightness
 *     /localExposure.html?hdr=1&hi=0.5&lo=0.5        the shape: each half keeps half its stops
 *                                                    from middle grey at the frame's exposure
 *     ...&detail=1.5                                 and the stripes keep half again of theirs
 *     ...&blend=0.6&bias=0.5                         the region's lean toward the blurred level,
 *                                                    and stops added to middle grey
 *
 * Deterministic: a fixed camera and sun, held at the twelfth frame so the eye's held brightness has
 * settled. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { LocalExposureOptions, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const number = (name: string, fallback: number): number => {
  const asked = Number(ASKED.get(name));
  return ASKED.has(name) && Number.isFinite(asked) ? asked : fallback;
};
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The setting the query asks for: the shape where any of its fields is named, else the number. */
function setting(): number | LocalExposureOptions {
  if (!['hi', 'lo', 'detail', 'blend', 'bias'].some((key) => ASKED.has(key))) {
    return number('local', 0);
  }
  return {
    highlightContrast: number('hi', 1),
    shadowContrast: number('lo', 1),
    detail: number('detail', 1),
    blurredBlend: number('blend', 0.4),
    middleGreyBias: number('bias', 0),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;

  /* The wall: twenty stripes a half, a quarter of a metre each, pale left and dark right. */
  const builder = new MeshBuilder();
  for (let i = 0; i < 40; i++) {
    const x = -5 + i * 0.25 + 0.125;
    const base = i < 20 ? 0.8 : 0.025;
    const shade = base * (i % 2 === 0 ? 1.3 : 0.7);
    const colour: Vec3 = [shade, shade, shade];
    builder.addBox([x, 0, -6], [0.125, 3, 0.05], colour);
  }
  const wall = renderer.createMesh(builder.build());

  const camera = new Camera();
  camera.fovYDeg = 60;
  camera.near = 0.1;
  camera.far = 50;
  camera.updateMatrices(aspect);
  const env = createEnvironment({
    directionalDir: [0, 0.2, 1],
    directionalColor: [2.5, 2.4, 2.2],
    ambient: [0.05, 0.05, 0.06],
    ambientGround: [0.05, 0.05, 0.06],
    fogDensity: 0,
  });
  renderer.setLocalExposure(setting());

  let frame = 0;
  const draw = (): void => {
    renderer.beginFrame([0.02, 0.02, 0.03]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(wall, IDENTITY);
    renderer.endFrame();
    frame++;
    if (frame === 12) (window as unknown as { __localReady: boolean }).__localReady = true;
    if (frame < 12) requestAnimationFrame(draw);
  };
  draw();
  stats.textContent = `${created.backend} · local exposure · ${location.search}`;
}

void main();
