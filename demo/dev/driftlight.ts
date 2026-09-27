/**
 * A long gallery lit by 726 candles, most of which the frame never shades one by one.
 *
 * **The page that says whether DriftLight does anything, and whether it does it without a seam.**
 * The frame shades the `?lights=` nearest candles exactly, sixteen by default, which here reach a
 * couple of metres down a forty-metre gallery. Without DriftLight everything past them is dark; with
 * it the rest are summed into the field, occluded by the gallery's own slabs, and stand in wherever
 * the exact choice does not reach.
 *
 *     /driftlight.html                   the summed candles past the sixteen nearest
 *     /driftlight.html?driftlight=0      the control: only the sixteen nearest light anything
 *     /driftlight.html?lights=4          fewer exact candles: the summed light stands in closer
 *     /driftlight.html?clustered=1&lights=256&eye=-10,1.6,-1&at=-5,1.4,-3
 *                                        the crossfade band on the wall in view, where a seam would show
 *     /driftlight.html?only=far&eye=1,1.6,-1.8&at=4,1.6,-1.8
 *                                        the partition's near face with every candle behind it: dark
 *     ...&occlude=0                      the positive control, the same with nothing occluding: lit
 *
 * **A partition with a doorway stands across the middle**, lit on both faces by the candles on its
 * own side. Light arriving on the near face from the far side's candles is light that went through
 * a wall, so a bright near face with its own candles removed is the occlusion failing.
 *
 * Held in the strict sense: it draws `FRAMES` frames with no clock and stops, then reports itself
 * the way `shots.mjs` waits for. Capture with `--urls=gallery=/driftlight.html --hold=3`.
 *
 * Nothing here is engine API and no engine package's source may import it.
 */

import {
  Camera,
  MeshBuilder,
  createEnvironment,
  createPointLightBuffer,
  createRenderer,
  selectPointLights,
} from '../../packages/core/src/index';
import type {
  FieldSource,
  GlobalFieldInstance,
  PointLightSource,
  RendererApi,
  Vec3,
} from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';
import { boxField } from './boxField';

/** Frames drawn before the page holds: enough for the radius to settle from its first choice. */
const FRAMES = 3;
/** Half the gallery's length, half its width, and its height. */
const LENGTH = 20;
const WIDTH = 3;
const HEIGHT = 4;
/** A slab's half thickness. */
const SLAB = 0.1;
/** Where the partition stands, and half its doorway's width and its height. */
const PARTITION_X = 4;
const DOOR = 0.6;
const DOOR_TOP = 2.5;
/** A candle, about 1,850 K, reaching a metre and a fifth, as the courtyard's do. */
const CANDLE: Vec3 = [0.5, 0.27, 0.08];
const CANDLE_RADIUS_M = 1.2;
const WAX: Vec3 = [0.93, 0.86, 0.72];
const STONE: Vec3 = [0.62, 0.58, 0.52];

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A placement with no rotation, column-major. */
function at(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

/** One slab of the gallery: where it stands and how far it reaches on each axis. */
interface Slab {
  readonly centre: Vec3;
  readonly half: Vec3;
}

const SLABS: readonly Slab[] = [
  { centre: [0, -SLAB, 0], half: [LENGTH, SLAB, WIDTH] },
  { centre: [0, HEIGHT + SLAB, 0], half: [LENGTH, SLAB, WIDTH] },
  { centre: [0, HEIGHT / 2, -WIDTH - SLAB], half: [LENGTH, HEIGHT / 2, SLAB] },
  { centre: [0, HEIGHT / 2, WIDTH + SLAB], half: [LENGTH, HEIGHT / 2, SLAB] },
  /* The partition: two leaves either side of the doorway, and the lintel over it. */
  {
    centre: [PARTITION_X, HEIGHT / 2, -(WIDTH + DOOR) / 2],
    half: [SLAB, HEIGHT / 2, (WIDTH - DOOR) / 2],
  },
  {
    centre: [PARTITION_X, HEIGHT / 2, (WIDTH + DOOR) / 2],
    half: [SLAB, HEIGHT / 2, (WIDTH - DOOR) / 2],
  },
  {
    centre: [PARTITION_X, (HEIGHT + DOOR_TOP) / 2, 0],
    half: [SLAB, (HEIGHT - DOOR_TOP) / 2, DOOR],
  },
];

/**
 * Three rows of candles along each wall, 30 cm apart, as a votive stand would hold them; only those
 * past the partition where `farOnly`.
 */
function candles(farOnly: boolean): PointLightSource[] {
  const lights: PointLightSource[] = [];
  for (const side of [-1, 1]) {
    for (const y of [1.0, 1.6, 2.2]) {
      for (let x = -LENGTH + 2; x <= LENGTH - 2 + 1e-6; x += 0.3) {
        if (farOnly && x < PARTITION_X) continue;
        lights.push({
          x,
          y,
          z: side * (WIDTH - 0.4),
          r: CANDLE[0],
          g: CANDLE[1],
          b: CANDLE[2],
          radius: CANDLE_RADIUS_M,
          flicker: 0,
          shadowNear: 0.05,
          sourceRadius: 0.005,
          castsShadow: false,
        });
      }
    }
  }
  return lights;
}

/** Three numbers from the address bar, `x,y,z`, or nothing where they are not three numbers. */
function triple(text: string | null): Vec3 | null {
  const parts = (text ?? '').split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? (parts as unknown as Vec3) : null;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const asked = new URLSearchParams(location.search);
  const summed = asked.get('driftlight') !== '0';
  const exact = Math.max(1, Number(asked.get('lights') ?? 16));

  const created = await createRenderer(
    canvas,
    { ...askedQuality() },
    { ...DEV_RENDERER, preferWebGpu: true },
  );
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const walls = new MeshBuilder();
  for (const slab of SLABS) walls.addBox(slab.centre, slab.half, STONE);
  const gallery = renderer.createMesh(walls.build());
  const lights = candles(asked.get('only') === 'far');
  const wax = new MeshBuilder();
  for (const light of lights) {
    wax.addBox([light.x, light.y - 0.08, light.z], [0.012, 0.07, 0.012], WAX, 0.6);
  }
  const stands = renderer.createMesh(wax.build());

  /* The same slabs as distance fields, which is what occludes the summed light. */
  const occluders: GlobalFieldInstance[] = SLABS.map((slab) => {
    const source: FieldSource = boxField([...slab.half], 0.4, 0.1);
    return { source, transform: at(slab.centre[0], slab.centre[1], slab.centre[2]) };
  });
  const field = summed
    ? renderer.createLightField(lights, {
        fields: asked.get('occlude') === '0' ? [] : occluders,
        fadeSec: 0,
      })
    : null;
  field?.bake(field.layout.count);

  const env = createEnvironment();
  env.directionalColor = [0, 0, 0];
  env.ambient = [0.004, 0.004, 0.005];
  env.ambientGround = [0.002, 0.002, 0.002];
  env.fogDensity = 0;
  /* Emissive is gated on the night, so the wax glows only with this at one. */
  env.nightFactor = 1;
  const buffer = createPointLightBuffer(exact);

  const camera = new Camera();
  camera.fovYDeg = 62;
  camera.near = 0.1;
  camera.far = 80;
  const eye = triple(asked.get('eye')) ?? [-LENGTH + 1.5, 1.6, 0.4];
  const target = triple(asked.get('at')) ?? [LENGTH, 1.8, -0.2];
  camera.position[0] = eye[0];
  camera.position[1] = eye[1];
  camera.position[2] = eye[2];
  camera.lookAt(target[0], target[1], target[2]);

  for (let frame = 0; frame < FRAMES; frame++) {
    const [x, y, z] = [camera.position[0] ?? 0, camera.position[1] ?? 0, camera.position[2] ?? 0];
    selectPointLights(lights, x, y, z, buffer, 0, 60);
    env.lightCount = buffer.count;
    env.lightPositions = buffer.positions;
    env.lightColors = buffer.colors;
    env.lightRadii = buffer.radii;
    env.lightSourceRadii = buffer.sourceRadii;
    env.lightWeights = buffer.weights;
    env.lightDirections = buffer.directions;
    env.lightConeCos = buffer.coneCos;
    env.lightIesProfiles = buffer.iesProfiles;
    field?.follow(buffer.complete, x, y, z, 1 / 60);
    renderer.resize();
    camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
    renderer.beginFrame([0, 0, 0]);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(gallery, IDENTITY);
    renderer.drawMesh(stands, IDENTITY);
    renderer.endFrame();
  }

  stats.textContent =
    `${renderer.backend} · driftlight · 2 draws · ${lights.length} candles · ` +
    `${buffer.count} exact to ${buffer.complete.toFixed(2)} m · ` +
    (field === null
      ? 'no field'
      : `${field.layout.count} bricks, radius ${field.radius.toFixed(2)} m`);
  (window as unknown as { __heldFrame?: number }).__heldFrame = FRAMES;
}

void main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null) box.textContent = `driftlight failed:\n${String(error)}`;
});
