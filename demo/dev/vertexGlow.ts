/**
 * Does a vertex's own glow reach the frame, and the same on both pipelines?
 *
 * **The voxel sandbox keeps its block light there**, because torchlight has to survive the sun
 * going down and a vertex colour is multiplied by the sun. The second pipeline's vertex had no
 * room for it until 2026-09-18, and its unit tests can say where the float is packed and that both
 * shaders read it — not what a driver makes of that.
 *
 *     /vertexGlow.html              three quads, their glow rising from left to right
 *     /vertexGlow.html?glow=0       the control: the same quads with no glow, which must be black
 *     /vertexGlow.html?map=1        every vertex glowing at one, through an emissive map that
 *                                   ramps from black to white — the second pipeline's map
 *     /vertexGlow.html?map=1&ramp=0 the same through a black map, which must glow nowhere
 *
 * Three quads side by side, identical but for who draws them: the second pipeline opaque, the
 * second pipeline blended at an opacity of one, and the forward path through `drawMesh`. **Nothing
 * else lights them** — no sun, no ambient, no sky — so the only light in the frame is the glow, and
 * the three rows have to rise together and agree.
 *
 * `scripts/vertex-glow-check.mjs` reads `__vertexGlow`. Nothing here is engine API and nothing
 * under `packages/*​/src` may import it.
 */
import { ADDRESS_MODE, DECODE_OP } from '@driftengine/texture';

import {
  Camera,
  GpuDrivenPass,
  createEnvironment,
  createRenderer,
  streamingScene,
} from '../../packages/core/src/index';
import type {
  GpuDrivenMaterial,
  GpuDrivenMesh,
  GpuDrivenProgram,
  GpuDrivenView,
  MeshData,
  MeshHandle,
  RendererApi,
} from '../../packages/core/src/index';
import { clustered } from '../gpuDrivenRig';
import { askedQuality } from './askedQuality';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Frames before the readback. The first has no history, so phase one draws nothing in it. */
const FRAMES = 3;

/** Where each quad's centre stands: opaque, blended, forward. */
const CENTRES = [-6, 0, 6] as const;

const HALF_WIDTH = 2;
const HALF_HEIGHT = 1.5;

/** Mid-grey, so a glow of one lands in the middle of the tone curve rather than at its shoulder. */
const ALBEDO = 0.5;

/** Where along each quad the row is read, as a share of its width. */
const SAMPLES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

type Rgb = [number, number, number];

interface Result {
  backend: string;
  glow: number;
  /** Per quad, the mean of the three channels at each sample, left to right. */
  rows: { opaque: number[]; blended: number[]; forward: number[] };
  error: string | null;
}

/** Texels a side of the emissive map. */
const MAP_EDGE = 64;

/**
 * The emissive map: a ramp from black at the left edge to white at the right, in linear bytes,
 * or all black. With a chain, because the device's texture array wants every level.
 */
function ramp(lit: boolean): Uint8Array[] {
  const level0 = new Uint8Array(MAP_EDGE * MAP_EDGE * 4);
  for (let y = 0; y < MAP_EDGE; y += 1) {
    for (let x = 0; x < MAP_EDGE; x += 1) {
      const value = lit ? Math.round((x / (MAP_EDGE - 1)) * 255) : 0;
      level0.set([value, value, value, 255], (y * MAP_EDGE + x) * 4);
    }
  }
  const levels = [level0];
  for (let size = MAP_EDGE >> 1; size >= 1; size >>= 1) {
    const from = levels[levels.length - 1] as Uint8Array;
    const next = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        for (let k = 0; k < 4; k += 1) {
          let sum = 0;
          for (const [dx, dy] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ] as const) {
            sum += from[((y * 2 + dy) * size * 2 + (x * 2 + dx)) * 4 + k] as number;
          }
          next[(y * size + x) * 4 + k] = Math.round(sum / 4);
        }
      }
    }
    levels.push(next);
  }
  return levels;
}

/** The map as the second pipeline reads it: one `SAMPLE_BLOCK`, clamped. */
function rampProgram(levels: Uint8Array[]): GpuDrivenProgram {
  return {
    graph: {
      nodes: Uint32Array.from([DECODE_OP.SAMPLE_BLOCK, 0, 0, 0]),
      count: 1,
      result: 0,
      addressMode: ADDRESS_MODE.CENTRE_CLAMP,
    },
    latents: [],
    blocks: [{ width: MAP_EDGE, height: MAP_EDGE, components: 4, levels }],
    networks: [],
  };
}

/**
 * A quad facing +z, its glow zero along the left edge and `glow` along the right — or, under a
 * map, `glow` everywhere and a UV from 0 at the left edge to 1 at the right, so the map does the
 * rising.
 */
function quad(cx: number, glow: number, mapped = false): MeshData {
  const positions = new Float32Array([
    cx - HALF_WIDTH,
    -HALF_HEIGHT,
    0,
    cx + HALF_WIDTH,
    -HALF_HEIGHT,
    0,
    cx + HALF_WIDTH,
    HALF_HEIGHT,
    0,
    cx - HALF_WIDTH,
    HALF_HEIGHT,
    0,
  ]);
  return {
    positions,
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(12).fill(ALBEDO),
    emissive: mapped ? new Float32Array(4).fill(glow) : new Float32Array([0, glow, glow, 0]),
    ...(mapped ? { uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) } : {}),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function gpuDriven(data: MeshData, material: number): GpuDrivenMesh {
  return {
    ...clustered({
      positions: data.positions,
      normals: data.normals,
      colours: data.colors,
      indices: data.indices,
      material,
      ...(data.uvs === undefined ? {} : { uvs: data.uvs }),
    }),
    emissive: data.emissive,
  };
}

/** A point in the world to the pixel it lands on, top-left origin, as the readback indexes. */
function pixelOf(
  camera: Camera,
  x: number,
  y: number,
  width: number,
  height: number,
): [number, number] {
  const m = camera.viewProjection;
  const cx = (m[0] as number) * x + (m[4] as number) * y + (m[12] as number);
  const cy = (m[1] as number) * x + (m[5] as number) * y + (m[13] as number);
  const cw = (m[3] as number) * x + (m[7] as number) * y + (m[15] as number);
  return [
    Math.floor(((cx / cw) * 0.5 + 0.5) * width),
    Math.floor((0.5 - (cy / cw) * 0.5) * height),
  ];
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const glow = Number(asked.get('glow') ?? '1');
  const mapped = asked.get('map') === '1';
  const levels = ramp(asked.get('ramp') !== '0');

  const created = await createRenderer(canvas, askedQuality(), {
    splash: false,
    pipeline: 'gpu-driven',
  });
  const renderer: RendererApi = created.renderer;
  await renderer.ready();

  const meshes = [
    gpuDriven(quad(CENTRES[0], glow, mapped), 0),
    gpuDriven(quad(CENTRES[1], glow, mapped), 1),
  ];
  const transforms = new Float32Array(meshes.length * 16);
  for (let m = 0; m < meshes.length; m += 1) transforms.set(IDENTITY, m * 16);
  /* No glow of their own: whatever lights these is the vertex's. */
  const textures = mapped ? { textures: { emissive: rampProgram(levels) } } : {};
  const materials: GpuDrivenMaterial[] = [
    { tint: [1, 1, 1], emissive: 0, ...textures },
    { tint: [1, 1, 1], emissive: 0, blend: true, opacity: 1, ...textures },
  ];
  const pass = new GpuDrivenPass(streamingScene(meshes, transforms), materials);
  const handle = renderer.registerPass(pass);
  const forward: MeshHandle = renderer.createMesh(quad(CENTRES[2], glow, mapped));
  /* The same ramp as the forward path's own emissive map: linear, clamped, one sample. */
  const forwardMap = mapped
    ? renderer.createSurfaceTexture(
        new ImageData(new Uint8ClampedArray(levels[0] as Uint8Array), MAP_EDGE, MAP_EDGE),
        { colorSpace: 'linear', wrap: 'clamp', anisotropy: 1 },
      )
    : null;

  /* Nothing lights the frame but the glow: no sun, no ambient, no fog. */
  const env = createEnvironment({
    directionalDir: [0.4, 0.66, 0.35],
    directionalColor: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    emissiveGain: 1,
    nightFactor: 1,
    fogColor: [0, 0, 0],
    fogDensity: 0,
    fogHeightFalloff: 0,
    fogBaseY: 0,
  });

  renderer.resize();
  const camera = new Camera();
  camera.position[0] = 0;
  camera.position[1] = 0;
  camera.position[2] = 14;
  camera.lookAt(0, 0, 0);
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const view: GpuDrivenView = {
    viewProj: camera.viewProjection,
    eye: [0, 0, 14],
    lightDir: [0.4, 0.66, 0.35],
    lightColour: [0, 0, 0],
    ambient: [0, 0, 0],
    ambientGround: [0, 0, 0],
    lodThreshold: 1.5,
    fovY: (camera.fovYDeg * Math.PI) / 180,
    shadowStrength: 0,
    emissiveGain: 1,
    nightFactor: 1,
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
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawPass(handle);
    renderer.setMaterial(forwardMap === null ? null : { emissive: forwardMap });
    renderer.drawMesh(forward, IDENTITY);
    renderer.setMaterial(null);
    renderer.endFrame();
    context.clearRect(0, 0, scratch.width, scratch.height);
    context.drawImage(canvas, 0, 0);
    pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
  }

  const row = (centre: number): number[] =>
    SAMPLES.map((share) => {
      const [x, y] = pixelOf(
        camera,
        centre - HALF_WIDTH + share * HALF_WIDTH * 2,
        0,
        scratch.width,
        scratch.height,
      );
      const i = (y * scratch.width + x) * 4;
      const rgb: Rgb = [pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number];
      return (rgb[0] + rgb[1] + rgb[2]) / 3;
    });

  const result: Result = {
    backend: created.backend,
    glow,
    rows: { opaque: row(CENTRES[0]), blended: row(CENTRES[1]), forward: row(CENTRES[2]) },
    error: null,
  };
  (globalThis as unknown as { __vertexGlow: Result }).__vertexGlow = result;
  stats.textContent = `${result.backend} · glow ${glow}${mapped ? ' · emissive map' : ''}`;
  (window as unknown as { __heldFrame?: number }).__heldFrame = FRAMES;
}

void main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) box.textContent = `vertex glow failed:\n${String(error)}`;
  (globalThis as unknown as { __vertexGlow: Partial<Result> }).__vertexGlow = {
    backend: 'none',
    error: error instanceof Error ? error.message : String(error),
  };
});
