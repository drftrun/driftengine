/**
 * Clustered lighting under load: a million instanced boxes, up to 320 point lights crowded around
 * what the camera sees, one 4096 directional shadow map, and nothing else.
 *
 * **The workload a performance report described, made reproducible.** It asked where the GPU time
 * of a dense clustered frame goes at about eight megapixels, and a total cannot answer that. This
 * page holds the scene still and reports the froxel occupancy the binner produces for it, so the
 * per-pass timings a harness takes have the numbers beside them that explain them.
 *
 *   ?lights=320    point lights, 0 to 320
 *   ?radius=8      every light's radius, in metres
 *   ?boxes=1000000 instanced boxes
 *   ?shadow=0      no directional shadow map
 *   ?clustered=0   the fixed sixteen-light path instead
 *
 * Every other quality dial is pinned off, so a timing here is the frame described and not a
 * default somebody changed later.
 *
 * Nothing here is engine API and no engine package's source may import it.
 */
import {
  Camera,
  MeshBuilder,
  computeLightMatrix,
  createEnvironment,
  createMeshInstances,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshHandle, RendererApi, Vec3 } from '../../packages/core/src/index';
import {
  CLUSTER_COUNT,
  CLUSTER_X,
  CLUSTER_Y,
  CLUSTER_Z,
  MAX_LIGHTS_PER_CLUSTER,
  clusterViewBounds,
} from '../../packages/core/src/render/clusteredLights';
import { DEV_RENDERER } from './askedQuality';

const asked = new URLSearchParams(location.search);
const number = (key: string, fallback: number): number => {
  const value = Number(asked.get(key));
  return asked.has(key) && Number.isFinite(value) ? value : fallback;
};

const LIGHTS = Math.max(0, Math.min(320, Math.round(number('lights', 320))));
const RADIUS = number('radius', 8);
const BOXES = Math.max(1, Math.round(number('boxes', 1_000_000)));
const SHADOW = asked.get('shadow') !== '0';
const CLUSTERED = asked.get('clustered') !== '0';

const BACKGROUND: Vec3 = [0.02, 0.025, 0.035];
/** Boxes a side of the square field, and the spacing between their centres. */
const SIDE = Math.ceil(Math.sqrt(BOXES));
const SPACING = 0.6;

/** A small deterministic generator, so every load of a URL is the same scene. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const created = await createRenderer(
    canvas,
    {
      clusteredLights: CLUSTERED,
      maxDevicePixelRatio: 1,
      maxDrawingBufferPixels: 12_000_000,
      sceneSamples: 1,
      directionalShadows: SHADOW,
      directionalShadowMapSize: 4096,
      directionalShadowDepthLayers: 1,
      pointShadows: false,
      glassShadows: 'off',
      water: false,
      screenEffects: false,
      environmentReflections: false,
      planarReflections: false,
      temporalAa: false,
      ambientOcclusion: 0,
      bloom: 0,
      indirectLight: false,
      reconstruction: 0,
    },
    DEV_RENDERER,
  );
  const renderer: RendererApi = created.renderer;
  renderer.resize();

  const random = generator(7);
  const camera = new Camera();
  camera.fovYDeg = 55;
  camera.near = 0.3;
  camera.far = 400;
  const half = (SIDE * SPACING) / 2;
  camera.position[0] = 0;
  camera.position[1] = 9;
  camera.position[2] = half - 4;
  camera.lookAt(0, 0, half - 40);
  const aspect = (): number => (canvas.height > 0 ? canvas.width / canvas.height : 1);
  camera.updateMatrices(aspect());

  /* The lights crowd the ground the camera looks at, in a band from just ahead of it to sixty
     metres out, which is what makes their pools overlap in screen space. */
  const positions = new Float32Array(Math.max(1, LIGHTS) * 3);
  const colors = new Float32Array(Math.max(1, LIGHTS) * 3);
  const radii = new Float32Array(Math.max(1, LIGHTS));
  const sourceRadii = new Float32Array(Math.max(1, LIGHTS));
  const weights = new Float32Array(Math.max(1, LIGHTS));
  for (let n = 0; n < LIGHTS; n++) {
    positions[n * 3] = (random() - 0.5) * 50;
    positions[n * 3 + 1] = 0.8 + random() * 2.2;
    positions[n * 3 + 2] = half - 8 - random() * 60;
    colors[n * 3] = 0.6 + random() * 0.4;
    colors[n * 3 + 1] = 0.5 + random() * 0.4;
    colors[n * 3 + 2] = 0.4 + random() * 0.6;
    radii[n] = RADIUS;
    sourceRadii[n] = 0.1;
    weights[n] = 1;
  }
  const SUN: Vec3 = [0.35, 0.8, 0.25];
  const env = createEnvironment({
    directionalDir: SUN,
    directionalColor: [0.35, 0.33, 0.3],
    ambient: [0.05, 0.055, 0.07],
    ambientGround: [0.02, 0.02, 0.025],
    fogColor: BACKGROUND,
    fogDensity: 0,
    lightCount: LIGHTS,
    lightPositions: positions,
    lightColors: colors,
    lightRadii: radii,
    lightSourceRadii: sourceRadii,
    lightWeights: weights,
  });

  const ground: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, -0.05, 0], [half + 2, 0.05, half + 2], [0.32, 0.32, 0.34]).build(),
  );
  const box: MeshHandle = renderer.createMesh(
    new MeshBuilder().addBox([0, 0.25, 0], [0.22, 0.25, 0.22], [0.8, 0.8, 0.8]).build(),
  );
  const instances = createMeshInstances(BOXES);
  for (let i = 0; i < BOXES; i++) {
    const x = (i % SIDE) * SPACING - half;
    const z = Math.floor(i / SIDE) * SPACING - half;
    const lift = 0.6 + random() * 1.8;
    const m = instances.models;
    m.set([1, 0, 0, 0, 0, lift, 0, 0, 0, 0, 1, 0, x, 0, z, 1], i * 16);
    const shade = 0.55 + random() * 0.35;
    instances.tints.set([shade, shade, shade], i * 3);
  }
  instances.count = BOXES;
  const batch = renderer.createInstanced(box, BOXES);
  renderer.uploadInstanced(batch, instances);

  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  /* The sun's map covers the ground the camera looks at, which is where the lights are. */
  const lightMatrix = new Float32Array(16);
  env.lightViewProj = lightMatrix;
  env.shadowDepthSpan = computeLightMatrix(
    SUN,
    0,
    0,
    half - 40,
    45,
    renderer.shadowMapSize,
    lightMatrix,
  );
  const occupancy = froxelOccupancy(camera, positions, radii, LIGHTS, aspect());

  let frames = 0;
  function frame(): void {
    if (SHADOW) {
      renderer.beginShadowPass(lightMatrix, 'static');
      renderer.drawShadowCasters((sink) => {
        sink.mesh(ground, identity);
        sink.instanced?.(batch, instances);
      });
      renderer.endShadowPass();
    }
    renderer.beginFrame(BACKGROUND);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial(null);
    renderer.drawMesh(ground, identity);
    renderer.drawInstanced(batch, instances);
    renderer.endFrame();
    frames += 1;
    requestAnimationFrame(frame);
  }
  frame();

  stats.textContent =
    `${created.backend} · ${canvas.width}×${canvas.height} · ${BOXES.toLocaleString()} boxes · ` +
    `${LIGHTS} lights r=${RADIUS} · shadow ${SHADOW ? 'on' : 'off'} · clustered ${CLUSTERED ? 'on' : 'off'} · ` +
    `${occupancy.mean.toFixed(1)} lights a froxel, p95 ${occupancy.p95}, max ${occupancy.max}`;
  (globalThis as unknown as { __stress: unknown }).__stress = {
    backend: created.backend,
    width: canvas.width,
    height: canvas.height,
    lights: LIGHTS,
    radius: RADIUS,
    boxes: BOXES,
    shadow: SHADOW,
    clustered: CLUSTERED,
    occupancy,
    frames: () => frames,
  };
}

/**
 * How many lights each froxel is asked to hold, counted without the cap.
 *
 * The same box the binner tests against, `clusterViewBounds`, and the same sphere-against-box
 * test, so `held` is what the table holds and `wanted - held` is what a full froxel dropped.
 */
function froxelOccupancy(
  camera: Camera,
  positions: Float32Array,
  radii: Float32Array,
  count: number,
  aspect: number,
): {
  mean: number;
  median: number;
  p95: number;
  max: number;
  full: number;
  references: number;
  dropped: number;
  occupied: number;
} {
  const view = camera.view;
  const tanHalf = Math.tan((camera.fovYDeg * Math.PI) / 360);
  const wanted = new Uint32Array(CLUSTER_COUNT);
  const box = new Float32Array(6);
  const centres = new Float32Array(count * 3);
  for (let n = 0; n < count; n++) {
    const x = positions[n * 3] as number;
    const y = positions[n * 3 + 1] as number;
    const z = positions[n * 3 + 2] as number;
    centres[n * 3] =
      (view[0] as number) * x +
      (view[4] as number) * y +
      (view[8] as number) * z +
      (view[12] as number);
    centres[n * 3 + 1] =
      (view[1] as number) * x +
      (view[5] as number) * y +
      (view[9] as number) * z +
      (view[13] as number);
    /* Positive depth, which is what the bounds are written in. */
    centres[n * 3 + 2] = -(
      (view[2] as number) * x +
      (view[6] as number) * y +
      (view[10] as number) * z +
      (view[14] as number)
    );
  }
  for (let k = 0; k < CLUSTER_Z; k++) {
    for (let j = 0; j < CLUSTER_Y; j++) {
      for (let i = 0; i < CLUSTER_X; i++) {
        clusterViewBounds(i, j, k, camera.near, camera.far, tanHalf, aspect, box);
        let n = 0;
        for (let l = 0; l < count; l++) {
          const cx = centres[l * 3] as number;
          const cy = centres[l * 3 + 1] as number;
          const cz = centres[l * 3 + 2] as number;
          const dx = Math.max((box[0] as number) - cx, 0, cx - (box[3] as number));
          const dy = Math.max((box[1] as number) - cy, 0, cy - (box[4] as number));
          const dz = Math.max((box[2] as number) - cz, 0, cz - (box[5] as number));
          const r = radii[l] as number;
          if (dx * dx + dy * dy + dz * dz <= r * r) n++;
        }
        wanted[i + CLUSTER_X * (j + CLUSTER_Y * k)] = n;
      }
    }
  }
  const held = Array.from(wanted, (n) => Math.min(n, MAX_LIGHTS_PER_CLUSTER));
  const occupied = held.filter((n) => n > 0).sort((a, b) => a - b);
  const references = held.reduce((sum, n) => sum + n, 0);
  const asked = Array.from(wanted).reduce((sum, n) => sum + n, 0);
  const at = (q: number): number =>
    occupied[Math.min(occupied.length - 1, Math.floor(q * occupied.length))] ?? 0;
  return {
    mean: occupied.length === 0 ? 0 : references / occupied.length,
    median: at(0.5),
    p95: at(0.95),
    max: occupied.at(-1) ?? 0,
    full: held.filter((n) => n === MAX_LIGHTS_PER_CLUSTER).length,
    references,
    dropped: asked - references,
    occupied: occupied.length,
  };
}

void main();
