/**
 * The formats a phone samples, uploaded as their blocks, against the texels those blocks decode to
 * uploaded as RGBA.
 *
 *     /phoneTextures.html                   as blocks wherever the device takes them
 *     /phoneTextures.html?decode=1          the same texels, decoded here, as RGBA
 *     /phoneTextures.html?decode=1&reference=source
 *                                           the pixels the blocks were made from instead: the
 *                                           control, which must differ by the encoder's error
 *     /phoneTextures.html?backend=webgl2    the other backend, either way
 *
 * Five cards: a colour image as ETC2 RGB8 and as ETC2 RGBA8, both sRGB with the chain
 * `encodeEtc2Chain` makes; a normal map as EAC RG11 on a grey card under a low sun; one ASTC 4x4
 * block of a single colour, written by hand in its void-extent form; and a texture made from the
 * RGBA image whose ETC2 chain replaces it through `updateSurfaceTexture` at frame three, which is
 * what the loader does on a phone. **What is measured**: the two arms of one backend agree to
 * rounding, since a device decodes ETC2, EAC and a void-extent block exactly; the swapped card
 * draws what the first card does; and the readout names which path each card took, so a run on a
 * device that offers none of these cannot pass as one that compared anything.
 *
 * This desktop samples neither ETC2 nor ASTC unless the browser is started with Mesa's
 * `vk_require_etc2=true vk_require_astc=true` in its environment. Deterministic: a fixed camera,
 * `window.__drawn` true at frame eight. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  uploadsCompressed,
} from '../../packages/core/src/index';
import type {
  CompressedTextureSource,
  RendererApi,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import { encodeEtc2Chain } from '../../packages/assets/src/etc2Chain';
import { decodeEtc2 } from '../../packages/assets/src/etc2Encode';
import type { Etc2Format } from '../../packages/assets/src/etc2Encode';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const CLEAR: Vec3 = [0.55, 0.6, 0.7];
const SIZE = 128;
/** The ASTC card's one colour, sRGB. */
const ASTC_COLOUR = [214, 120, 48, 255] as const;

function at(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(IDENTITY);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** Rings over a sweep of hue, a fine checker in one quadrant, and alpha a ramp across. */
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
      out[i + 3] = 255 - Math.round((x / SIZE) * 128);
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

/** One ASTC 4x4 block per 4x4 texels, each the void-extent block of one LDR colour. */
function astcConstant(): CompressedTextureSource {
  const block = new Uint8Array(16);
  block.set([0xfc, 0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  for (let c = 0; c < 4; c++) {
    const unorm16 = (ASTC_COLOUR[c] as number) * 257;
    block[8 + c * 2] = unorm16 & 0xff;
    block[9 + c * 2] = unorm16 >> 8;
  }
  const levels: Uint8Array[] = [];
  for (let side = SIZE; side >= 1; side >>= 1) {
    const blocks = Math.ceil(side / 4) ** 2;
    const level = new Uint8Array(blocks * 16);
    for (let b = 0; b < blocks; b++) level.set(block, b * 16);
    levels.push(level);
  }
  return { format: 'astc-4x4', width: SIZE, height: SIZE, levels };
}

function chain(format: Etc2Format, image: Uint8Array, srgb: boolean): CompressedTextureSource {
  return {
    format,
    width: SIZE,
    height: SIZE,
    levels: encodeEtc2Chain(format, image, SIZE, SIZE, srgb),
  };
}

/** What a device decodes a source's level 0 to, as RGBA: the reference arm's image. */
function decoded(source: CompressedTextureSource): ImageData {
  const level = source.levels[0] as Uint8Array;
  const rgba =
    source.format === 'astc-4x4'
      ? new Uint8Array(SIZE * SIZE * 4).map((_, i) => ASTC_COLOUR[i % 4] as number)
      : decodeEtc2(source.format as Etc2Format, level, SIZE, SIZE);
  return new ImageData(Uint8ClampedArray.from(rgba), SIZE, SIZE);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  const asked = new URLSearchParams(location.search);
  const decode = asked.get('decode') === '1';
  const fromSource = asked.get('reference') === 'source';

  const paths: string[] = [];
  /** As blocks where the device takes them and this run allows it; as the texels they decode to otherwise. */
  const upload = (
    label: string,
    source: CompressedTextureSource,
    srgb: boolean,
    pixels: Uint8Array | null,
  ) => {
    const colorSpace = srgb ? 'srgb' : 'linear';
    const { format, width, height } = source;
    if (!decode && uploadsCompressed(format, srgb, width, height, renderer.compressedFormats)) {
      paths.push(`${label} blocks`);
      return renderer.createSurfaceTexture(source, { colorSpace });
    }
    paths.push(`${label} decoded`);
    const image =
      fromSource && pixels !== null
        ? new ImageData(Uint8ClampedArray.from(pixels), SIZE, SIZE)
        : decoded(source);
    return renderer.createSurfaceTexture(image, { colorSpace });
  };

  const colour = colourImage();
  const rgb = chain('etc2-rgb8', colour, true);
  const rgba = chain('etc2-rgba8', colour, true);
  const normal = normalImage();
  const eac = chain('eac-rg11', normal, false);
  const textures: SurfaceTextureHandle[] = [
    upload('rgb8', rgb, true, colour),
    upload('rgba8', rgba, true, colour),
    upload('rg11', eac, false, normal),
    upload('astc', astcConstant(), true, null),
    /* The swap's image: the texels its blocks decode to, which it is then replaced by. */
    renderer.createSurfaceTexture(decoded(rgb), { colorSpace: 'srgb' }),
  ];
  const swapped = textures[4] as SurfaceTextureHandle;
  const swapsAsBlocks =
    !decode && uploadsCompressed('etc2-rgb8', true, SIZE, SIZE, renderer.compressedFormats);
  paths.push(`swap ${swapsAsBlocks ? 'blocks' : 'kept'}`);

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
  camera.position[2] = 5.2;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(aspect);

  const card = renderer.createMesh(
    new MeshBuilder().addBox([0, 0, 0], [0.5, 0.5, 0.001], [1, 1, 1]).build({ planarUvs: true }),
  );
  const grey = renderer.createMesh(
    new MeshBuilder()
      .addBox([0, 0, 0], [0.5, 0.5, 0.001], [0.6, 0.6, 0.6])
      .build({ planarUvs: true }),
  );

  let frame = 0;
  const draw = (): void => {
    frame += 1;
    if (frame === 3 && swapsAsBlocks) renderer.updateSurfaceTexture(swapped, rgb);
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial({ albedo: textures[0] as SurfaceTextureHandle });
    renderer.drawMesh(card, at(-2.2, 0.6, 0));
    renderer.setMaterial({ albedo: textures[1] as SurfaceTextureHandle });
    renderer.drawMesh(card, at(-1.1, 0.6, 0));
    renderer.setMaterial({ normal: textures[2] as SurfaceTextureHandle });
    renderer.drawMesh(grey, at(0, 0.6, 0));
    renderer.setMaterial({ albedo: textures[3] as SurfaceTextureHandle });
    renderer.drawMesh(card, at(1.1, 0.6, 0));
    renderer.setMaterial({ albedo: swapped });
    renderer.drawMesh(card, at(-2.2, -0.6, 0));
    renderer.setMaterial(null);
    renderer.endFrame();
    if (frame === 8) {
      stats.textContent =
        `${renderer.backend} · offers ${renderer.compressedFormats.filter((f) => !f.startsWith('bc')).join(' ') || 'no ETC2 or ASTC'} · ` +
        paths.join(' · ');
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
