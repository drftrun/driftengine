/**
 * A dithered cutout against a hard one, photographed.
 *
 *     /cutoutDither.html                  no temporal resolve, one sample: both hard
 *     /cutoutDither.html?taa=1            a temporal resolve: the right half is dithered and averaged
 *     /cutoutDither.html?samples=4        multisampled: the right half takes alpha-to-coverage
 *     ...&backend=webgl2
 *
 * A fringe of strands — one texture of thin vertical hairs, each solid at its core and falling to
 * nothing over a couple of texels, and fading out towards its tips — on two cards in front of a
 * bright wall. The left card is `cutoutMode: 'hard'`, the right `'dithered'`. The cards are far
 * enough away that a strand is thinner than a pixel, which is where a hard test breaks a strand into
 * dashes. **What is measured** is how much of each card's edge is a blend of strand and wall: the
 * hard card has almost none at one sample; the dithered one has a ramp under a temporal resolve or
 * multisampling, and is exactly the hard card with neither. A third card below draws the dithered
 * material translucent, which must test hard rather than show grain.
 *
 * Runs a frame loop, because a temporal resolve needs history; `window.__cutoutDitherReady` is set
 * once enough frames have been drawn for it to converge. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type {
  RendererApi,
  SurfaceMaterial,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const READY_AFTER = 90;

function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** Thin dark strands with a soft core, fading towards the bottom: a fringe of hair. */
function paintStrands(): HTMLCanvasElement {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const tip = 1 - Math.max(0, (y - size * 0.55) / (size * 0.45));
    for (let x = 0; x < size; x++) {
      /* A strand every eight texels, a texel and a half wide at its core. */
      const d = Math.abs(((x + 4) % 8) - 4);
      const core = Math.max(0, 1 - d / 1.6);
      const i = (y * size + x) * 4;
      image.data[i] = 40;
      image.data[i + 1] = 26;
      image.data[i + 2] = 18;
      image.data[i + 3] = Math.round(255 * core * tip);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
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
  env.ambient = [0.5, 0.52, 0.55];
  env.shadowStrength = 0;
  env.fogDensity = 0;

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.3;
  camera.far = 100;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  camera.position[2] = 9;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(aspect);

  const wall = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, -1.5], [8, 5, 0.1], [0.92, 0.9, 0.86]).build(),
  );
  const card = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [1.2, 1.2, 0.001], [1, 1, 1]).build({ planarUvs: true }),
  );
  const strands = renderer.createSurfaceTexture(paintStrands(), { colorSpace: 'srgb' });
  const hard: SurfaceMaterial<SurfaceTextureHandle> = {
    albedo: strands,
    cutout: 0.5,
    doubleSided: true,
  };
  const dithered: SurfaceMaterial<SurfaceTextureHandle> = {
    albedo: strands,
    cutout: 0.5,
    cutoutMode: 'dithered',
    doubleSided: true,
  };

  let frames = 0;
  const frame = (): void => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(wall, IDENTITY);
    renderer.setMaterial(hard);
    renderer.drawMesh(card, at(-1.4, 0.7, 0));
    renderer.setMaterial(dithered);
    renderer.drawMesh(card, at(1.4, 0.7, 0));
    renderer.drawTranslucentMesh(card, at(1.4, -1.8, 0), 0.9);
    renderer.setMaterial(null);
    renderer.endFrame();
    frames += 1;
    if (frames === READY_AFTER) {
      stats.textContent = `${renderer.backend}`;
      (window as unknown as { __cutoutDitherReady: boolean }).__cutoutDitherReady = true;
    }
    if (frames < READY_AFTER) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
