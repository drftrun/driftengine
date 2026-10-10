/**
 * Layers picked from shared arrays and given looks of their own, each mode beside the control it
 * must equal or visibly differ from. Albedo is uploaded linear, so a tint is exact arithmetic.
 *
 *     /layerLooks.html?mode=plain      a wall: blue, red where the mask's red rises left to right,
 *                                      green over the top half — arrays in that order, nothing picked
 *     /layerLooks.html?mode=picked     the same layers picked by index from arrays shared with other
 *                                      textures, the mask past them at `extrasAt`: the same picture
 *     /layerLooks.html?mode=tinted     three white checkers tinted blue, red and green: the same picture
 *     /layerLooks.html?mode=occluded   `plain` darkened by an occlusion read at the mesh's coordinates,
 *                                      black at the left edge rising to none at the right
 *     /layerLooks.html?mode=ambientocc `occluded`, the occlusion into the ambient light: the same picture,
 *                                      the wall having no other
 *     /layerLooks.html?mode=occludedsun `occluded` with a sun on the wall: darkened in the sun too
 *     /layerLooks.html?mode=ambientsun `ambientocc` with that sun: the sun's share left as it was, so
 *                                      lighter at the left than `occludedsun`
 *     /layerLooks.html?mode=ranged     `occluded`, its red spread over 0.5 to 1: half dark at the left
 *     /layerLooks.html?mode=stretched  `plain`, red's repeat 4 across and 1 down: its checker stretched
 *     /layerLooks.html?mode=stretchedsame  red's repeat 4 across and 4 down: the same picture as `plain`
 *     /layerLooks.html?mode=flat       a sphere under a low sun, a flat normal map (the control)
 *     /layerLooks.html?mode=ridged     its normal map ridged, at strength 1: banded
 *     /layerLooks.html?mode=ridged0    the ridges at strength 0: the same picture as `flat`
 *     /layerLooks.html?mode=ridged3    the ridges at strength 3: banded harder than `ridged`
 *     /layerLooks.html?mode=glossy     `flat`, its roughness spread over 0 to 0.1: a tight highlight
 *     /layerLooks.html?mode=matte      `flat`, its roughness spread over 0.9 to 1: a broad dull one
 *     /layerLooks.html?mode=metal      `flat`, its metalness spread over 1 to 1: dark but for what it
 *                                      reflects, a metal's colour being its reflection
 *     /layerLooks.html?mode=dull       `flat`, its layer's specular 0: no highlight
 *     /layerLooks.html?mode=samespec   `flat`, its layer's specular 1, the vertices' own: the same picture
 *
 * The sphere carries a full specular and draws with the physical highlight, so roughness has a
 * highlight to change: with neither, `glossy` and `matte` are the same picture, which is how the
 * first capture of this page came back.
 *
 * Held at frame 30. Nothing under `src/` may import this.
 */
import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createRenderer,
} from '../../packages/core/src/index';
import type { RendererApi, SurfaceLayerLook, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const MODE = ASKED.get('mode') ?? 'plain';
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 30;
const SIZE = 64;

type Material = NonNullable<Parameters<RendererApi['setMaterial']>[0]>;
type Rgba = [number, number, number, number];

function paint(colour: (x: number, y: number) => Rgba): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('layerLooks: no 2D context');
  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) image.data.set(colour(x, y), (y * SIZE + x) * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** A colour with every other square of a four-by-four checker a fifth darker. */
function checker(rgb: Vec3): HTMLCanvasElement {
  return paint((x, y) => {
    const dark = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 1 ? 0.8 : 1;
    return [Math.round(rgb[0] * dark), Math.round(rgb[1] * dark), Math.round(rgb[2] * dark), 255];
  });
}

const BLUE: Vec3 = [40, 70, 220];
const RED: Vec3 = [220, 40, 40];
const GREEN: Vec3 = [40, 200, 60];
/** A colour as the tint that turns white into it, the albedo being uploaded linear. */
const tintOf = (rgb: Vec3): Vec3 => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];

const STEP_MASK = (x: number, y: number): Rgba => [
  Math.round((x / (SIZE - 1)) * 255),
  y < SIZE / 2 ? 255 : 0,
  0,
  255,
];
/** Occlusion in red, black at the left rising to none at the right; mid roughness, no metal. */
const OCCLUSION_RAMP = (x: number): Rgba => [Math.round((x / (SIZE - 1)) * 255), 128, 0, 255];
const NEUTRAL_ORM = (): Rgba => [255, 128, 0, 255];
const FLAT_NORMAL = (): Rgba => [128, 128, 255, 255];
const RIDGES = (x: number): Rgba => {
  const tilt = Math.sin((x / SIZE) * Math.PI * 16) * 0.8;
  const z = Math.sqrt(1 - tilt * tilt);
  return [Math.round((tilt * 0.5 + 0.5) * 255), 128, Math.round((z * 0.5 + 0.5) * 255), 255];
};
/** Something else the shared arrays hold, which no layer here picks. */
const GREY = (): Rgba => [128, 128, 128, 255];

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  const linear = { colorSpace: 'linear' as const, mipmap: false };
  const arrays = (
    albedo: HTMLCanvasElement[],
    orm: HTMLCanvasElement[],
    normal: HTMLCanvasElement[],
  ) => ({
    albedo: renderer.createSurfaceTextureArray(albedo, linear),
    orm: renderer.createSurfaceTextureArray(orm, linear),
    normal: renderer.createSurfaceTextureArray(normal, linear),
  });

  const wallModes = [
    'plain',
    'picked',
    'tinted',
    'occluded',
    'ambientocc',
    'occludedsun',
    'ambientsun',
    'ranged',
    'stretched',
    'stretchedsame',
  ];
  const onWall = wallModes.includes(MODE);
  const flat = paint(FLAT_NORMAL);
  const neutral = paint(NEUTRAL_ORM);
  let material: Material;
  if (MODE === 'picked') {
    /* Five textures shared: grey, then blue, red and green, then the mask past them at 4. */
    material = {
      ...arrays(
        [paint(GREY), checker(BLUE), checker(RED), checker(GREEN), paint(GREY)],
        [neutral, neutral, neutral, neutral, paint(STEP_MASK)],
        [flat, flat, flat, flat, flat],
      ),
      layers: { mask: 'orm', repeats: [1, 4, 8], arrayLayers: [1, 2, 3], extrasAt: 4 },
    };
  } else if (MODE === 'tinted') {
    const white = checker([255, 255, 255]);
    const looks: SurfaceLayerLook[] = [
      { tint: tintOf(BLUE) },
      { tint: tintOf(RED) },
      { tint: tintOf(GREEN) },
    ];
    material = {
      ...arrays(
        [white, white, white],
        [neutral, neutral, neutral, paint(STEP_MASK)],
        [flat, flat, flat],
      ),
      layers: { mask: 'orm', repeats: [1, 4, 8], looks },
    };
  } else if (onWall) {
    /* `plain`, and the occlusions with the ramp in the ORM array's layer after the mask. */
    const occlusion: NonNullable<Material['layers']>['meshOcclusion'] =
      MODE === 'occluded' || MODE === 'occludedsun'
        ? 1
        : MODE === 'ambientocc' || MODE === 'ambientsun'
          ? { into: 'ambient' }
          : MODE === 'ranged'
            ? { range: [0.5, 1] }
            : undefined;
    const red: number | [number, number] =
      MODE === 'stretched' ? [4, 1] : MODE === 'stretchedsame' ? [4, 4] : 4;
    material = {
      ...arrays(
        [checker(BLUE), checker(RED), checker(GREEN)],
        [neutral, neutral, neutral, paint(STEP_MASK), paint(OCCLUSION_RAMP)],
        [flat, flat, flat],
      ),
      layers: {
        mask: 'orm',
        repeats: [1, red, 8],
        meshOcclusion: occlusion,
      },
    };
  } else {
    /* The sphere: one layer, its normal map flat or ridged, its look the mode's. */
    const ridged = MODE.startsWith('ridged');
    const strength = MODE === 'ridged0' ? 0 : MODE === 'ridged3' ? 3 : undefined;
    const look: SurfaceLayerLook | null =
      strength !== undefined
        ? { normalStrength: strength }
        : MODE === 'glossy'
          ? { roughness: [0, 0.1] }
          : MODE === 'matte'
            ? { roughness: [0.9, 1] }
            : MODE === 'metal'
              ? { metalness: [1, 1] }
              : MODE === 'dull'
                ? { specular: 0 }
                : MODE === 'samespec'
                  ? { specular: 1 }
                  : null;
    material = {
      ...arrays([checker([200, 200, 200])], [neutral], [ridged ? paint(RIDGES) : flat]),
      layers: { mask: 'vertex', repeats: [1], looks: look === null ? undefined : [look] },
      physicalSpecular: true,
    };
  }

  const wall = renderer.createMesh(
    new MeshBuilder()
      .addWallQuad([-2, 0, 0], [2, 0, 0], [2, 4, 0], [-2, 4, 0], [0, 2, -1], [1, 1, 1])
      .build({ planarUvs: true }),
  );
  const sphere = renderer.createMesh(
    new MeshBuilder().addSphere([0, 2, 0], 1.6, [1, 1, 1], 0, 48, 24, 1).build({ planarUvs: true }),
  );
  await renderer.ready();

  const env = createEnvironment();
  /* The wall is lit by its ambient alone but where a mode puts a sun on it, half and half. */
  const sunOnWall = MODE.endsWith('sun');
  env.directionalDir = onWall ? (sunOnWall ? [0.2, 0.4, 1] : [0, 1, 0]) : [0.9, 0.25, 0.35];
  env.directionalColor = onWall ? (sunOnWall ? [0.5, 0.5, 0.5] : [0, 0, 0]) : [0.55, 0.53, 0.5];
  env.ambient = onWall ? (sunOnWall ? [0.5, 0.5, 0.5] : [1, 1, 1]) : [0.15, 0.15, 0.16];
  env.ambientGround = env.ambient;
  env.fogDensity = 0;
  env.shadowStrength = 0;
  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.position[1] = 2;
  camera.position[2] = 6;
  camera.lookAt(0, 2, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  /* The wall's coordinates run -2 to 2 across and 0 to 4 up: laid 0 to 1 over it once each way. */
  if (onWall) Object.assign(material, { uScale: 0.25, vScale: 0.25, uOffset: 0.5, vOffset: 0 });
  const mesh = onWall ? wall : sphere;

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
