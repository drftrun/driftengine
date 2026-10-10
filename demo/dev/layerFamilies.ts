/**
 * What a layered material can take besides a map mask laying layers over each other, one mode each
 * with its control beside it. Three layers throughout: red, green and blue checkers.
 *
 *     /layerFamilies.html?mode=map         a wall, the mask a map: red rising left to right lays green,
 *                                          the top half's green lays blue (the control for `orm`)
 *     /layerFamilies.html?mode=orm         the same mask carried by the ORM array: the same picture
 *     /layerFamilies.html?mode=ormpage     that, under a lightmap page in the model's slot: the layers
 *                                          still there, lit by the page as well
 *     /layerFamilies.html?mode=gradient    the mask a map of two ramps, red left to right and green
 *                                          bottom to top (the control for `vertex` and `sum`)
 *     /layerFamilies.html?mode=vertex      the same ramps as the wall's vertex colours: the same picture,
 *                                          and no tint from them
 *     /layerFamilies.html?mode=sum         `gradient` summed rather than laid over: darker where the
 *                                          weights are partial, brighter where they add past one
 *     /layerFamilies.html?mode=floor       a floor, the layers placed by the world at half, two and four
 *                                          repeats a metre, laid by its vertex colour, red rising left
 *                                          to right
 *     /layerFamilies.html?mode=flooradd    that, with stripes the ORM array carries added to blue's
 *                                          weight at a quarter repeat a metre: blue in bands
 *     /layerFamilies.html?mode=sphere      a sphere, green laid by its vertex colour, which is black:
 *                                          red all over (the control for `facing`)
 *     /layerFamilies.html?mode=facing      green laid by how much the surface faces up instead: green on
 *                                          top, fading to red at the equator
 *     /layerFamilies.html?mode=lit         the sphere under a low sun, its layers' normals flat (the
 *                                          control for `meshnormal`)
 *     /layerFamilies.html?mode=meshnormal  that, with ridges read at the mesh's own coordinates under the
 *                                          layers: the sphere banded by them
 *
 * Held at frame 30. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  lightmapModel,
} from '../../packages/core/src/index';
import type { LightmapPage, MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const MODE = ASKED.get('mode') ?? 'map';
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 30;
const SIZE = 64;

type Material = NonNullable<Parameters<RendererApi['setMaterial']>[0]>;

/** A canvas of `size` painted by `colour(x, y)`, 0 to 255 a channel. */
function paint(
  colour: (x: number, y: number) => [number, number, number, number],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('layerFamilies: no 2D context');
  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) image.data.set(colour(x, y), (y * SIZE + x) * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** A layer: its colour, with every other square of a four-by-four checker a fifth darker. */
function checker(rgb: [number, number, number]): HTMLCanvasElement {
  return paint((x, y) => {
    const dark = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 1 ? 0.8 : 1;
    return [rgb[0] * dark, rgb[1] * dark, rgb[2] * dark, 255];
  });
}

/** The wall's mask: red rising left to right, green over the half the quad shows on top. */
const STEP_MASK = (x: number, y: number): [number, number, number, number] => [
  Math.round((x / (SIZE - 1)) * 255),
  y < SIZE / 2 ? 255 : 0,
  0,
  255,
];
/** Two ramps: red left to right, green bottom to top (the image's first row is the wall's foot). */
const RAMP_MASK = (x: number, y: number): [number, number, number, number] => [
  Math.round((x / (SIZE - 1)) * 255),
  Math.round((y / (SIZE - 1)) * 255),
  0,
  255,
];
/** Neutral surface numbers: no occlusion, mid roughness, no metal. */
const NEUTRAL_ORM = (): [number, number, number, number] => [255, 128, 0, 255];
/** Bands a sixteenth of the image wide, for the added mask. */
const STRIPES = (x: number): [number, number, number, number] => [
  Math.floor(x / 8) % 2 === 0 ? 255 : 0,
  0,
  0,
  255,
];
const FLAT_NORMAL = (): [number, number, number, number] => [128, 128, 255, 255];
/** Ridges across u: the normal tilted hard one way then the other, eight times across the image. */
const RIDGES = (x: number): [number, number, number, number] => {
  const tilt = Math.sin((x / SIZE) * Math.PI * 16) * 0.8;
  const z = Math.sqrt(1 - tilt * tilt);
  return [Math.round((tilt * 0.5 + 0.5) * 255), 128, Math.round((z * 0.5 + 0.5) * 255), 255];
};

/** One value arriving straight down, a quarter of a unit: what `lightmap.html` calls a flat page. */
function flatPage(): LightmapPage {
  const texels = 4 * 4;
  const irradiance = new Float32Array(texels * 3).fill(0.25);
  const direction = new Uint8Array(texels * 4);
  for (let t = 0; t < texels; t++) direction.set([128, 255, 128, 255], t * 4);
  return { width: 4, height: 4, irradiance, direction };
}

/** `data` with each vertex's colour set by `colour(p)` and its lightmap coordinates by `uv(p)`. */
function painted(
  data: MeshData,
  colour: (p: Vec3) => Vec3,
  uv: (p: Vec3) => [number, number],
): MeshData {
  const count = data.positions.length / 3;
  const colors = new Float32Array(count * 3);
  const lightmapUvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const p: Vec3 = [
      data.positions[i * 3] as number,
      data.positions[i * 3 + 1] as number,
      data.positions[i * 3 + 2] as number,
    ];
    colors.set(colour(p), i * 3);
    lightmapUvs.set(uv(p), i * 2);
  }
  return { ...data, colors, lightmapUvs };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const albedo = renderer.createSurfaceTextureArray(
    [checker([220, 40, 40]), checker([40, 200, 60]), checker([40, 70, 220])],
    { colorSpace: 'srgb' },
  );
  const ramps = MODE === 'gradient' || MODE === 'vertex' || MODE === 'sum';
  /* The three layers' neutral numbers, then the mask (or, for the floor, the stripes it adds). */
  const fourth = MODE.startsWith('floor') ? STRIPES : ramps ? RAMP_MASK : STEP_MASK;
  const orm = renderer.createSurfaceTextureArray(
    [paint(NEUTRAL_ORM), paint(NEUTRAL_ORM), paint(NEUTRAL_ORM), paint(fourth)],
    { colorSpace: 'linear', mipmap: false },
  );
  const normal = renderer.createSurfaceTextureArray(
    [paint(FLAT_NORMAL), paint(FLAT_NORMAL), paint(FLAT_NORMAL), paint(RIDGES)],
    { colorSpace: 'linear' },
  );
  const mask = renderer.createSurfaceTexture(paint(ramps ? RAMP_MASK : STEP_MASK), {
    colorSpace: 'linear',
    mipmap: false,
  });
  const page = renderer.createLightmap(flatPage());

  /*
   * The wall twice: white, so nothing tints the layers, and with the ramps as its vertex colours —
   * red with x, green with height, over -2..2 and 0..4 — for the mode that lays them by those.
   */
  const wallOf = (colour: (p: Vec3) => Vec3): MeshData =>
    painted(
      new MeshBuilder()
        .addWallQuad([-2, 0, 0], [2, 0, 0], [2, 4, 0], [-2, 4, 0], [0, 2, -1], [1, 1, 1])
        .build({ planarUvs: true }),
      colour,
      (p) => [(p[0] + 2) / 4, p[1] / 4],
    );
  const wall = renderer.createMesh(
    wallOf(MODE === 'vertex' ? (p) => [(p[0] + 2) / 4, p[1] / 4, 0] : () => [1, 1, 1]),
  );
  const floor = renderer.createMesh(
    painted(
      new MeshBuilder()
        .addGroundQuad([-4, 0, -4], [4, 0, -4], [4, 0, 4], [-4, 0, 4], [1, 1, 1])
        .build({ planarUvs: true }),
      (p) => [(p[0] + 4) / 8, 0, 0],
      (p) => [(p[0] + 4) / 8, (p[2] + 4) / 8],
    ),
  );
  const sphere = renderer.createMesh(
    new MeshBuilder().addSphere([0, 2, 0], 1.6, [0, 0, 0], 0, 48, 24).build({ planarUvs: true }),
  );
  await renderer.ready();

  const env = createEnvironment();
  const lit = MODE === 'lit' || MODE === 'meshnormal';
  env.directionalDir = lit ? [0.9, 0.25, 0.35] : [0, 1, 0];
  env.directionalColor = lit ? [1.6, 1.55, 1.5] : [0, 0, 0];
  env.ambient = lit ? [0.15, 0.15, 0.16] : [1, 1, 1];
  env.ambientGround = env.ambient;
  env.fogDensity = 0;
  env.shadowStrength = 0;
  const camera = new Camera();
  camera.fovYDeg = 45;
  if (MODE.startsWith('floor')) {
    camera.position[1] = 7;
    camera.position[2] = 6;
    camera.lookAt(0, 0, -0.5);
  } else {
    camera.position[1] = 2;
    camera.position[2] = 6;
    camera.lookAt(0, 2, 0);
  }
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /* The wall's coordinates run -2 to 2 across and 0 to 4 up, in metres: a quarter, and across moved
     by a half, lays 0 to 1 over it once each way, so a ramp does not wrap. */
  const onWall = { uScale: 0.25, vScale: 0.25, uOffset: 0.5, vOffset: 0 };
  const layered = (layers: NonNullable<Material['layers']>): Material => ({
    albedo,
    orm,
    normal,
    layers,
  });
  const material: Material =
    MODE === 'orm'
      ? { ...layered({ mask: 'orm', repeats: [1, 4, 8] }), ...onWall }
      : MODE === 'ormpage'
        ? {
            ...layered({ mask: 'orm', repeats: [1, 4, 8] }),
            ...onWall,
            model: lightmapModel({ region: [1, 1, 0, 0] }),
            modelMap: page,
          }
        : MODE === 'vertex'
          ? { ...layered({ mask: 'vertex', repeats: [1, 4, 8] }), ...onWall }
          : MODE === 'sum'
            ? { ...layered({ mask, repeats: [1, 4, 8], blend: 'sum' }), ...onWall }
            : MODE === 'floor' || MODE === 'flooradd'
              ? {
                  ...layered({
                    mask: 'vertex',
                    repeats: [0.5, 2, 4],
                    addMask:
                      MODE === 'flooradd' ? { layer: 2, repeat: 0.25, intensity: 1 } : undefined,
                  }),
                  projection: { kind: 'planar', scale: 1 },
                }
              : MODE === 'sphere' || MODE === 'facing'
                ? layered({
                    mask: 'vertex',
                    repeats: [1, 4, 8],
                    facing: MODE === 'facing' ? { layer: 1, bias: -1, sharpness: 2 } : undefined,
                  })
                : lit
                  ? /* Three layers, so the ridges are the normal array's fourth, past them. */
                    layered({
                      mask: 'vertex',
                      repeats: [1, 4, 8],
                      meshNormal: MODE === 'meshnormal',
                    })
                  : { ...layered({ mask, repeats: [1, 4, 8] }), ...onWall };
  const mesh = MODE.startsWith('floor')
    ? floor
    : MODE === 'sphere' || MODE === 'facing' || lit
      ? sphere
      : wall;

  let frame = 0;
  const draw = async (): Promise<void> => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    renderer.setMaterial(material);
    renderer.drawMesh(mesh, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    frame += 1;
    /* The first material turns lit switches on, and the frames after wait for their pipelines. */
    if (frame === 1) await renderer.ready();
    stats.textContent = `${created.backend} · ${MODE}`;
    if (frame < FRAMES) requestAnimationFrame(() => void draw());
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(() => void draw());
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
