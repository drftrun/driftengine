/**
 * A material blended from three layers by a mask: a red base, a green layer laid by the mask's red,
 * which rises left to right, and a blue one laid by its green, set on half its rows.
 *
 *     /layers.html            the top half blue; the bottom red at the left turning green to the
 *                             right, four squares of red across, sixteen of green, thirty-two of blue
 *     /layers.html?layers=0   the control: the same arrays with no layers, the base everywhere
 *
 * Each layer is a checker of its colour, repeated 1, 4 and 8 times across the quad, so a layer read
 * at the wrong repeat shows. Held at frame 60. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 60;
const SIZE = 64;

/** A canvas of `size` painted by `colour(x, y)`, 0 to 255 a channel. */
function paint(
  colour: (x: number, y: number) => [number, number, number, number],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('layers: no 2D context');
  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) image.data.set(colour(x, y), (y * SIZE + x) * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** A layer: its colour, with every other square of a four-by-four checker a fifth darker. */
function layer(rgb: [number, number, number]): HTMLCanvasElement {
  return paint((x, y) => {
    const dark = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 1 ? 0.8 : 1;
    return [rgb[0] * dark, rgb[1] * dark, rgb[2] * dark, 255];
  });
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const on = ASKED.get('layers') !== '0';
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const albedo = renderer.createSurfaceTextureArray(
    [layer([220, 40, 40]), layer([40, 200, 60]), layer([40, 70, 220])],
    { colorSpace: 'srgb' },
  );
  /* Red rises left to right across the image; green covers the half the quad shows on top. */
  const mask = renderer.createSurfaceTexture(
    /* Opaque: a canvas keeps its colour premultiplied, so a mask painted at alpha 0 uploads black.
       Three layers read red and green; alpha would lay a fifth. */
    paint((x, y) => [Math.round((x / (SIZE - 1)) * 255), y < SIZE / 2 ? 255 : 0, 0, 255]),
    { colorSpace: 'linear', mipmap: false },
  );
  const quad = renderer.createMesh(
    new MeshBuilder()
      .addWallQuad([-2, 0, 0], [2, 0, 0], [2, 4, 0], [-2, 4, 0], [0, 2, -1], [1, 1, 1])
      .build({ planarUvs: true }),
  );
  await renderer.ready();

  const env = createEnvironment();
  env.directionalColor = [0, 0, 0];
  env.ambient = [1, 1, 1];
  env.ambientGround = [1, 1, 1];
  env.fogDensity = 0;
  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.position[1] = 2;
  camera.position[2] = 6;
  camera.lookAt(0, 2, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  let frame = 0;
  const draw = (): void => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    /* The quad's coordinates run -2 to 2 in metres; a quarter, moved by a half, lays the mask
       across it once, 0 to 1. */
    renderer.setMaterial({
      albedo,
      uScale: 0.25,
      vScale: 0.25,
      uOffset: 0.5,
      vOffset: 0.5,
      layers: on ? { mask, repeats: [1, 4, 8] } : null,
    });
    renderer.drawMesh(quad, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    frame += 1;
    stats.textContent = `${created.backend} · layers ${on ? 'on' : 'off'}`;
    if (frame < FRAMES) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
