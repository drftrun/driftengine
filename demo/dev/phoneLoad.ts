/**
 * The model loader on a device that samples ETC2 and not BC: a BC7 albedo shown decoded, then its
 * ETC2 chain swapped in behind the same handle by the loader's own worker.
 *
 *     /phoneLoad.html?show=loader     the loader's texture, once its chain has been swapped in
 *     /phoneLoad.html?show=direct     the same chain, encoded here and uploaded directly
 *     /phoneLoad.html?show=rgba       the BC7 decoded, which is what the loader showed first
 *
 * A container is written here with one card and one 256² BC7 colour texture (`bcEncode.ts`, a
 * fixture maker), and streamed into a `DrftLoader` whose renderer offers its device's formats less
 * BC — what a phone offers, on a machine where the device samples both — with `spawnBcWorker`, so
 * the decode and the encode run in the worker a consumer's page would start. **What is measured**:
 * `loader` and `direct` are the same picture, and `loader` and `rgba` are not, by the encoder's
 * error. Needs ETC2 on the device: on this desktop, Mesa's `vk_require_etc2=true` in the browser's
 * environment. `window.__drawn` turns true four frames after the swap, or after the texture for the
 * other two. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  isCompressedSource,
} from '../../packages/core/src/index';
import type { RendererApi, SurfaceTextureHandle, Vec3 } from '../../packages/core/src/index';
import { CODEC_BC, writeBcPayload, writeDrft } from '../../packages/drft/src/index';
import { DrftLoader } from '../../packages/assets/src/drftLoader';
import { spawnBcWorker } from '../../packages/assets/src/bcWorkers';
import { decodeBc } from '../../packages/assets/src/bcDecode';
import { encodeEtc2Chain } from '../../packages/assets/src/etc2Chain';
import { encodeBc7, halve } from './bcEncode';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const SIZE = 256;
const SHOW = new URLSearchParams(location.search).get('show') ?? 'loader';

/** Rings over a sweep of hue, with a fine checker in one quadrant. */
function colourImage(): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const r = Math.hypot(x - SIZE / 2, y - SIZE / 2);
      const ring = Math.sin(r * 0.3) * 0.5 + 0.5;
      const checker = x < SIZE / 2 && y < SIZE / 2 && ((x >> 3) + (y >> 3)) % 2 === 0;
      out[i] = Math.round(255 * (x / SIZE) * ring);
      out[i + 1] = Math.round(255 * (1 - y / SIZE) * (0.3 + 0.7 * ring));
      out[i + 2] = checker ? 230 : Math.round(120 * ring);
      out[i + 3] = 255;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const levels: Uint8Array[] = [];
  let level = colourImage();
  for (let side = SIZE; side >= 1; side >>= 1) {
    levels.push(encodeBc7(level, side, side));
    level = halve(level, side, side);
  }
  const bc7 = { format: 'bc7' as const, srgb: true, width: SIZE, height: SIZE, levels };
  const decoded = decodeBc('bc7', SIZE, SIZE, levels[0] as Uint8Array);

  /* A phone's formats: the device's own, less BC. */
  const phoneFormats = renderer.compressedFormats.filter((format) => !format.startsWith('bc'));
  const swaps: string[] = [];
  const phone = new Proxy(renderer, {
    get(target, key) {
      if (key === 'compressedFormats') return phoneFormats;
      if (key === 'updateSurfaceTexture') {
        return (
          handle: SurfaceTextureHandle,
          source: Parameters<RendererApi['updateSurfaceTexture']>[1],
        ) => {
          if (isCompressedSource(source)) swaps.push(`${source.format} ×${source.levels.length}`);
          target.updateSurfaceTexture(handle, source);
        };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  const card = new MeshBuilder()
    .addBox([0, 0, 0], [1.3, 1.3, 0.001], [1, 1, 1])
    .build({ planarUvs: true });
  let texture: SurfaceTextureHandle | null = null;
  let loader: DrftLoader | null = null;
  const started = performance.now();
  let swappedAt = 0;
  if (SHOW === 'loader') {
    const drft = writeDrft({
      head: { name: 'phone' },
      meshes: [card],
      materials: [
        {
          name: 'card',
          color: [1, 1, 1],
          specular: 0,
          roughness: 0.5,
          emissive: 0,
          emissiveColor: [0, 0, 0],
          opacity: 1,
          albedo: 0,
          normalMap: -1,
          ormMap: -1,
          emissiveMap: -1,
          roughnessScale: 1,
          metallicScale: 1,
          occlusionStrength: 0,
          reflectivity: 0,
          cutout: 0,
        },
      ],
      textures: [
        {
          name: 'card.dds',
          codec: CODEC_BC,
          width: SIZE,
          height: SIZE,
          bytes: writeBcPayload(bc7),
        },
      ],
    });
    loader = new DrftLoader(phone, { bcWorker: spawnBcWorker });
    void loader.consume(new Response(drft), { footprint: 1, height: 1, baseY: 0 });
  } else if (SHOW === 'direct') {
    const chain = encodeEtc2Chain('etc2-rgb8', decoded, SIZE, SIZE, true);
    texture = renderer.createSurfaceTexture(
      { format: 'etc2-rgb8', width: SIZE, height: SIZE, levels: chain },
      { colorSpace: 'srgb' },
    );
  } else {
    texture = renderer.createSurfaceTexture(
      new ImageData(Uint8ClampedArray.from(decoded), SIZE, SIZE),
      { colorSpace: 'srgb' },
    );
  }

  const mesh = renderer.createMesh(card);
  const env = createEnvironment();
  env.directionalDir = [-0.4, 0.35, 0.85];
  env.directionalColor = [1, 0.97, 0.9];
  env.ambient = [0.3, 0.31, 0.33];
  env.shadowStrength = 0;
  env.fogDensity = 0;
  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.near = 0.3;
  camera.far = 100;
  renderer.resize();
  camera.position[2] = 4.4;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  let after = -1;
  const draw = (): void => {
    if (loader !== null) {
      loader.update(1 / 60);
      texture = loader.textures?.at(0) ?? null;
      if (swaps.length > 0 && swappedAt === 0) swappedAt = performance.now() - started;
    }
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    if (texture !== null) {
      renderer.setMaterial({ albedo: texture });
      renderer.drawMesh(mesh, IDENTITY);
      renderer.setMaterial(null);
    }
    renderer.endFrame();
    const ready = SHOW === 'loader' ? swaps.length > 0 : texture !== null;
    if (ready && after < 0) after = 0;
    if (after >= 0 && ++after === 4) {
      stats.textContent =
        `${renderer.backend} · show ${SHOW} · phone offers ${phoneFormats.length} formats` +
        (SHOW === 'loader' ? ` · swapped ${swaps.join(', ')} at ${swappedAt.toFixed(0)} ms` : '');
      (window as unknown as { __drawn: boolean }).__drawn = true;
    }
    requestAnimationFrame(draw);
  };
  draw();
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) {
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
});
