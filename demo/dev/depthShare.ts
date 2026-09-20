/**
 * Can a forward-path mesh stand behind the second pipeline's geometry?
 *
 * **Only if the two share a depth buffer, and until `presentDepth` they did not.** The GPU-driven
 * pass rasterises into targets of its own and puts its colour on the screen with a blit; without
 * the flag that blit writes no depth, so a mesh the engine's own verbs draw has nothing to be
 * hidden by. No ordering fixes it: drawn before the blit it is painted over, drawn after it floats
 * in front of a wall. The unit tests pin the blit's pipeline *state*; this page is the driver
 * saying what that state does.
 *
 *     /depthShare.html?depth=1&order=after
 *     /depthShare.html?depth=0&order=after      the control: nothing hides anything
 *
 * The scene is a grey wall drawn by the second pipeline, a red box drawn by the first behind it
 * and a green box drawn by the first in front of it. Both boxes sit wholly inside the wall's
 * silhouette, so the wall is the only thing that can hide either. `order` is when the boxes draw:
 * `after` the blit, as a consumer would draw mobs over terrain, or `before` it.
 *
 * **And two panes over nothing**, because the blit is also where transparency meets the frame. A
 * pane the second pipeline blends has no opaque surface of its own pipeline behind it when the sky
 * is what is behind it, so the pixel its target holds is the pane alone with a coverage below one.
 * `backdrop` changes what the frame was cleared to; a pane composited *over* it has to change with
 * it and has to differ from it.
 *
 * `scripts/depth-share-check.mjs` reads `__depthShare`. Nothing here is engine API and nothing
 * under `packages/*​/src` may import it.
 */
import {
  Camera,
  GpuDrivenPass,
  MeshBuilder,
  createEnvironment,
  createRenderer,
  streamingScene,
} from '../../packages/core/src/index';
import type {
  GpuDrivenMaterial,
  GpuDrivenView,
  MeshHandle,
  RendererApi,
} from '../../packages/core/src/index';
import { clustered } from '../gpuDrivenRig';
import { askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Frames before the readback. The first has no history, so phase one draws nothing in it. */
const FRAMES = 3;

/** What the frame is cleared to, and there is no sky: a pane has only this behind it. */
const BACKDROPS: readonly (readonly [number, number, number])[] = [
  [0.05, 0.07, 0.1],
  [0.55, 0.3, 0.12],
];

/** The two panes' coverage. One below the blit's half and one above it, on purpose. */
const PANE_OPACITY = [0.45, 0.72] as const;

/** Where the panes stand, above the wall with nothing of either pipeline behind them. */
const PANE_CENTRES: readonly (readonly [number, number, number])[] = [
  [-2.5, 8, 0],
  [2.5, 8, 0],
];

/** Between the two panes, at their height: the backdrop and nothing else. */
const BACKDROP_PROBE = [0, 8, 0] as const;

type Rgb = [number, number, number];

interface Result {
  backend: string;
  depth: boolean;
  order: 'before' | 'after';
  backdrop: number;
  /** Pixels read as the red box, which stands behind the wall. */
  red: number;
  /** Pixels read as the green box, which stands in front of it. */
  green: number;
  /** Pixels read as the wall, which the two boxes' counts are only meaningful beside. */
  wall: number;
  /** The centre pixel of each pane, lightest first. */
  panes: Rgb[];
  /** The pixel between the panes, where only the backdrop is. */
  backdropPixel: Rgb;
  error: string | null;
}

function geometry(
  centre: readonly [number, number, number],
  half: readonly [number, number, number],
  colour: readonly [number, number, number],
  emissive: number,
): ReturnType<MeshBuilder['build']> {
  return new MeshBuilder()
    .addBox([...centre] as Rgb, [...half] as Rgb, [...colour] as Rgb, emissive)
    .build();
}

/**
 * One face toward the camera, and only one.
 *
 * **A box would be two panes.** The blended raster draws both sides of what it is given, so a thin
 * box at 0.72 is two layers and lets through 0.28 squared of what is behind it — eight per cent,
 * which the tone curve then rounds away. A single quad is one layer and says what one layer does.
 */
function quad(
  centre: readonly [number, number, number],
  halfWidth: number,
  halfHeight: number,
  colour: readonly [number, number, number],
): ReturnType<MeshBuilder['build']> {
  const [x, y, z] = centre;
  const positions = new Float32Array([
    x - halfWidth,
    y - halfHeight,
    z,
    x + halfWidth,
    y - halfHeight,
    z,
    x + halfWidth,
    y + halfHeight,
    z,
    x - halfWidth,
    y + halfHeight,
    z,
  ]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const colors = new Float32Array([...colour, ...colour, ...colour, ...colour]);
  return {
    positions,
    normals,
    colors,
    emissive: new Float32Array(4),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  } as ReturnType<MeshBuilder['build']>;
}

/** A point in the world to the pixel it lands on, top-left origin, as the readback indexes. */
function pixelOf(
  camera: Camera,
  point: readonly [number, number, number],
  width: number,
  height: number,
): [number, number] {
  const m = camera.viewProjection;
  const [x, y, z] = point;
  const cx = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
  const cy = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
  const cw =
    (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
  return [
    Math.floor(((cx / cw) * 0.5 + 0.5) * width),
    Math.floor((0.5 - (cy / cw) * 0.5) * height),
  ];
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const depth = asked.get('depth') === '1';
  const order = asked.get('order') === 'before' ? 'before' : 'after';
  const backdrop = asked.get('backdrop') === '1' ? 1 : 0;

  /*
   * **`pipeline: 'gpu-driven'` and the engine's own verbs in one frame**, which is the thing the
   * rigs deliberately never do and the voxel sandbox's port has to: its terrain on this pipeline
   * and its mobs on the other.
   */
  const created = await createRenderer(canvas, askedQuality(), {
    splash: false,
    pipeline: 'gpu-driven',
  });
  const renderer: RendererApi = created.renderer;
  await renderer.ready();

  const wall = geometry([0, 3, 0], [4, 3, 0.2], [0.5, 0.5, 0.52], 0);
  /* Lit rather than glowing, and in a colour no channel of which the tone curve clips: a pane at
     255 in two channels over both backdrops is a saturated pane, not an opaque one. */
  const panes = PANE_CENTRES.map((centre) => quad(centre, 1.5, 1, [0.25, 0.45, 0.7]));
  const meshes = [wall, ...panes].map((data, at) =>
    clustered({
      positions: data.positions,
      normals: data.normals,
      colours: data.colors,
      indices: data.indices,
      material: at,
    }),
  );
  const transforms = new Float32Array(meshes.length * 16);
  for (let m = 0; m < meshes.length; m += 1) transforms.set(IDENTITY, m * 16);
  const materials: GpuDrivenMaterial[] = [
    { tint: [1, 1, 1], emissive: 0 },
    ...PANE_OPACITY.map((opacity) => ({
      tint: [1, 1, 1] as const,
      emissive: 0,
      blend: true,
      opacity,
    })),
  ];
  const pass = new GpuDrivenPass(streamingScene(meshes, transforms), materials, {
    presentDepth: depth,
  });
  const handle = renderer.registerPass(pass);

  /* Emissive at one and pure, so the lighting cannot make either read as anything else. */
  const red: MeshHandle = renderer.createMesh(geometry([-1.5, 3, -3], [1, 1, 1], [1, 0, 0], 1));
  const green: MeshHandle = renderer.createMesh(geometry([1.5, 3, 3], [1, 1, 1], [0, 1, 0], 1));

  const env = createEnvironment({
    directionalDir: [0.4, 0.66, 0.35],
    directionalColor: [0.95, 0.9, 0.8],
    ambient: [0.22, 0.26, 0.34],
    ambientGround: [0.07, 0.06, 0.05],
    emissiveGain: 1,
    /* One, or the forward path scales every emission to nothing and the boxes read black. */
    nightFactor: 1,
    fogColor: [0.3, 0.36, 0.44],
    fogDensity: 0,
    fogHeightFalloff: 0.05,
    fogBaseY: 0,
  });

  renderer.resize();
  const camera = new Camera();
  camera.position[0] = 0;
  camera.position[1] = 5;
  camera.position[2] = 16;
  camera.lookAt(0, 5, 0);
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const view: GpuDrivenView = {
    viewProj: camera.viewProjection,
    eye: [0, 5, 16],
    lightDir: [0.4, 0.66, 0.35],
    lightColour: [0.95, 0.9, 0.8],
    ambient: [0.22, 0.26, 0.34],
    ambientGround: [0.07, 0.06, 0.05],
    lodThreshold: 1.5,
    fovY: (camera.fovYDeg * Math.PI) / 180,
    shadowStrength: 0,
    emissiveGain: 1,
    nightFactor: 1,
  };

  const boxes = (): void => {
    renderer.drawMesh(red, IDENTITY);
    renderer.drawMesh(green, IDENTITY);
  };

  const scratch = document.createElement('canvas');
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('no 2d context to read the frame through');

  let pixels = new Uint8ClampedArray(0);
  for (let frame = 0; frame < FRAMES; frame += 1) {
    pass.resize(renderer.sceneWidth, renderer.sceneHeight);
    pass.setView(view);
    renderer.beginFrame([...(BACKDROPS[backdrop] as Rgb)] as Rgb);
    renderer.bindMeshPass(camera, env);
    if (order === 'before') boxes();
    renderer.drawPass(handle);
    if (order === 'after') boxes();
    renderer.endFrame();
    /* Read in the same task as the frame, before the canvas is handed to the compositor. */
    context.clearRect(0, 0, scratch.width, scratch.height);
    context.drawImage(canvas, 0, 0);
    pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
  }

  const at = (point: readonly [number, number, number]): Rgb => {
    const [x, y] = pixelOf(camera, point, scratch.width, scratch.height);
    const i = (y * scratch.width + x) * 4;
    return [pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number];
  };

  let redCount = 0;
  let greenCount = 0;
  let wallCount = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] as number;
    const g = pixels[i + 1] as number;
    const b = pixels[i + 2] as number;
    if (r > 150 && g < 90 && b < 90) redCount += 1;
    else if (g > 150 && r < 90 && b < 90) greenCount += 1;
    /* Grey: the three channels within a few of each other and neither dark nor blown. */
    else if (Math.max(r, g, b) - Math.min(r, g, b) < 24 && r > 40 && r < 230) wallCount += 1;
  }

  const result: Result = {
    backend: created.backend,
    depth,
    order,
    backdrop,
    red: redCount,
    green: greenCount,
    wall: wallCount,
    panes: PANE_CENTRES.map((centre) => at(centre)),
    backdropPixel: at(BACKDROP_PROBE),
    error: null,
  };
  (globalThis as unknown as { __depthShare: Result }).__depthShare = result;
  stats.textContent =
    `${result.backend} · depth ${depth ? 'shared' : 'not shared'} · boxes ${order} the blit · ` +
    `red ${redCount} · green ${greenCount} · wall ${wallCount}`;
  (window as unknown as { __heldFrame?: number }).__heldFrame = FRAMES;
}

void main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) box.textContent = `depth share failed:\n${String(error)}`;
  (globalThis as unknown as { __depthShare: Partial<Result> }).__depthShare = {
    backend: 'none',
    error: error instanceof Error ? error.message : String(error),
  };
});
