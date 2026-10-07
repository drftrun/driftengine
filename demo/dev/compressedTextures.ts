/**
 * BC textures uploaded as their blocks, against the same blocks decoded at load.
 *
 *     /compressedTextures.html                   WebGPU, as blocks wherever the device takes them
 *     /compressedTextures.html?decode=1          the same blocks decoded in the loader's worker, as RGBA
 *     /compressedTextures.html?backend=webgl2    the other backend, either way
 *
 * Three cards: a colour image as BC1 and as BC7, both sRGB with their whole chain, and a BC5 normal
 * map on a grey card under a low sun. **What is measured**: the two arms of one backend differ by
 * no more than the rounding a GPU's BC1 interpolants may differ from `decodeBc`'s, and BC7 and BC5
 * not at all; the normal-mapped card is lit the same both ways, because in both its blue arrives as
 * zero and the lit shader rebuilds z; and the readout names which path each card took, so a run on a
 * device that offers no BC cannot pass as a run that compared anything.
 *
 * The images are generated here and encoded by `bcEncode.ts`, a fixture maker. Deterministic: one
 * frame, a fixed camera. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  uploadsCompressed,
} from '../../packages/core/src/index';
import type {
  BlockFormat,
  CompressedTextureSource,
  RendererApi,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { createBcDecoder } from '../../packages/assets/src/bcLoad';
import { DEV_RENDERER, askedQuality } from './askedQuality';
import { encodeBc1, encodeBc5, encodeBc7, halve } from './bcEncode';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const SIZE = 128;

function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** Rings over a sweep of hue, with a fine checker in one quadrant: every kind of BC1 block. */
function colourImage(): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const r = Math.hypot(x - SIZE / 2, y - SIZE / 2);
      const ring = Math.sin(r * 0.45) * 0.5 + 0.5;
      const checker = x < SIZE / 2 && y < SIZE / 2 && ((x >> 2) + (y >> 2)) % 2 === 0;
      out[i] = Math.round(255 * (x / SIZE) * ring);
      out[i + 1] = Math.round(255 * (1 - y / SIZE) * (0.3 + 0.7 * ring));
      out[i + 2] = checker ? 230 : Math.round(120 * ring);
      out[i + 3] = 255;
    }
  }
  return out;
}

/** A grid of domes, as a normal map's x and y in red and green. */
function normalImage(): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE * 4);
  const cell = SIZE / 4;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = ((x % cell) - cell / 2) / (cell / 2);
      const dy = ((y % cell) - cell / 2) / (cell / 2);
      const inside = dx * dx + dy * dy < 0.8;
      const i = (y * SIZE + x) * 4;
      out[i] = Math.round(((inside ? dx * 0.8 : 0) * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round(((inside ? -dy * 0.8 : 0) * 0.5 + 0.5) * 255);
      out[i + 2] = 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** The whole chain of `image` in `format`, down to 1x1. */
function chain(
  format: BlockFormat,
  image: Uint8Array,
  encode: (rgba: Uint8Array, w: number, h: number) => Uint8Array,
): CompressedTextureSource {
  const levels: Uint8Array[] = [];
  let level = image;
  for (let size = SIZE; size >= 1; size >>= 1) {
    levels.push(encode(level, size, size));
    level = halve(level, size, size);
  }
  return { format, width: SIZE, height: SIZE, levels };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  const decode = new URLSearchParams(location.search).get('decode') === '1';

  const paths: string[] = [];
  /* The loader's own decoder, so the decoded arm runs the worker a consumer's page would. */
  const decoder = createBcDecoder();
  /** As blocks where the device takes them and this run allows it; decoded to RGBA otherwise. */
  const upload = async (
    label: string,
    source: CompressedTextureSource,
    srgb: boolean,
  ): Promise<SurfaceTextureHandle> => {
    const colorSpace = srgb ? 'srgb' : 'linear';
    const { format, width, height } = source;
    if (!decode && uploadsCompressed(format, srgb, width, height, renderer.compressedFormats)) {
      paths.push(`${label} blocks`);
      return renderer.createSurfaceTexture(source, { colorSpace });
    }
    paths.push(`${label} decoded`);
    /* Every source on this page is BC, which is all the decoder takes. */
    const rgba = await decoder.decode(
      { ...source, srgb } as Parameters<typeof decoder.decode>[0],
      false,
    );
    const image = new ImageData(Uint8ClampedArray.from(rgba), width, height);
    return renderer.createSurfaceTexture(image, { colorSpace });
  };

  const colour = colourImage();
  const bc1 = await upload('bc1', chain('bc1', colour, encodeBc1), true);
  const bc7 = await upload('bc7', chain('bc7', colour, encodeBc7), true);
  const bc5 = await upload('bc5', chain('bc5', normalImage(), encodeBc5), false);

  const env = createEnvironment();
  env.directionalDir = [-0.75, 0.35, 0.56];
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.25, 0.26, 0.28];
  env.shadowStrength = 0;
  env.fogDensity = 0;

  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.3;
  camera.far = 100;
  renderer.resize();
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
  camera.position[2] = 4.5;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(aspect);

  const card = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.62, 0.62, 0.001], [1, 1, 1]).build({ planarUvs: true }),
  );
  const grey = renderer.createMesh(
    new MeshBuilder()
      .addBox([0, 0, 0], [0.62, 0.62, 0.001], [0.6, 0.6, 0.6])
      .build({ planarUvs: true }),
  );

  renderer.beginFrame(CLEAR);
  renderer.bindMeshPass(camera, env);
  renderer.setMaterial({ albedo: bc1 });
  renderer.drawMesh(card, at(-1.5, 0, 0));
  renderer.setMaterial({ albedo: bc7 });
  renderer.drawMesh(card, at(0, 0, 0));
  renderer.setMaterial({ normal: bc5 });
  renderer.drawMesh(grey, at(1.5, 0, 0));
  renderer.setMaterial(null);
  renderer.endFrame();

  stats.textContent =
    `${renderer.backend} · offers ${renderer.compressedFormats.join(' ') || 'no BC'} · ` +
    paths.join(' · ') +
    (decode ? ` · ${decoder.reason === '' ? 'decoded in a worker' : decoder.reason}` : '');
  (window as unknown as { __compressedReady: boolean }).__compressedReady = true;
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
