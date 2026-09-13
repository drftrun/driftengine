/**
 * Do the two light binners agree?
 *
 * **This is the page the WebGL2 answer to clustered lighting rests on.** That backend has no
 * compute, so its froxel table is filled by CPU code while WebGPU's is filled by a dispatch — two
 * implementations of one decision, which the 2026-08-17 rule says drift, and drift invisibly when
 * the constants are identical. Nothing else in the suite can catch that: both tables are plausible
 * on their own, and a scene lit from either looks like a lit scene.
 *
 *     /cluster.html    builds both tables for one camera and one light set, and compares them
 *
 * **Counts and index lists compare exactly.** Membership near a froxel boundary does not, and the
 * reason is stated rather than papered over: whether a sphere touches a box is a float comparison,
 * and JavaScript's doubles and WGSL's f32 are not obliged to answer a marginal case the same way.
 * So a disagreement is a failure *unless* that light's sphere lies within `BORDERLINE_M` of that
 * cluster's bounds, and the count of those is reported on every run so a number creeping upward is
 * visible rather than absorbed.
 *
 * **This page reaches engine internals on purpose.** `ClusterBinner` and the froxel layout are not
 * public API and should not become public API to be tested; a dev instrument is allowed to know
 * more than a consumer, exactly as `askedQuality.ts` is. Nothing under `packages/` may import this,
 * and nothing here is engine API.
 */
import { createRenderer } from '../../packages/core/src/index';
import type { RendererApi } from '../../packages/core/src/index';
import {
  CLUSTER_COUNT,
  CLUSTER_TEXELS,
  CLUSTER_X,
  CLUSTER_Y,
  LIGHT_REGION_TEXELS,
  LIGHT_TEXELS,
  MAX_LIGHTS_PER_CLUSTER,
  TABLE_HEIGHT,
  TABLE_WIDTH,
  buildLightClusters,
  clusterBase,
  clusterViewBounds,
  createClusterTable,
  type ClusterLightSet,
} from '../../packages/core/src/render/clusteredLights';
import { ClusterBinner } from '../../packages/core/src/render/backend/webgpu/clusterBinner';
import { DEV_RENDERER, askedQuality } from './askedQuality';

/** How near a froxel's face a light may sit before a disagreement about it is forgiven. */
const BORDERLINE_M = 0.01;

const NEAR = 0.5;
const FAR = 400;
const TAN_HALF_FOV = 0.5773502691896258;
const ASPECT = 16 / 9;
const LIGHT_COUNT = 96;

/** The camera at the origin looking down -z, so a world z of -12 is a view depth of 12. */
const VIEW = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * A deterministic scatter of lights.
 *
 * **No clock and no `Math.random`.** Two runs of this page must produce the same tables or the
 * comparison is measuring the scene rather than the binners, and a difference that appears once
 * in ten runs is the worst possible thing to be chasing.
 */
function lightSet(): ClusterLightSet {
  const positions = new Float32Array(LIGHT_COUNT * 3);
  const colors = new Float32Array(LIGHT_COUNT * 3);
  const radii = new Float32Array(LIGHT_COUNT);
  const sourceRadii = new Float32Array(LIGHT_COUNT);
  const weights = new Float32Array(LIGHT_COUNT);
  for (let n = 0; n < LIGHT_COUNT; n++) {
    /* A closed form rather than a generator, so the numbers are the same in every browser. */
    positions[n * 3] = Math.sin(n * 1.7) * 24;
    positions[n * 3 + 1] = Math.sin(n * 0.9) * 9;
    positions[n * 3 + 2] = -(2 + ((n * 3.7) % 90));
    colors[n * 3] = 0.5 + 0.5 * Math.sin(n);
    colors[n * 3 + 1] = 0.5;
    colors[n * 3 + 2] = 0.5 + 0.5 * Math.cos(n);
    radii[n] = 3 + (n % 7);
    sourceRadii[n] = 0.1;
    weights[n] = 1;
  }
  return { count: LIGHT_COUNT, positions, colors, radii, sourceRadii, weights };
}

interface Disagreement {
  cluster: number;
  cpu: number[];
  gpu: number[];
}

interface Result {
  backend: string;
  supported: boolean;
  error: string | null;
  clusters: number;
  /** Clusters whose count or index list differ and are not explained by a boundary. */
  real: Disagreement[];
  /** Differences where the light sits within `BORDERLINE_M` of that cluster's bounds. */
  borderline: number;
  /** Records compared, which is the light region both binners wrote. */
  recordsCompared: number;
  recordMismatches: number;
}

const bounds = new Float32Array(6);

/** The view-space centre of a light, matching what both binners compute. */
function viewOf(lights: ClusterLightSet, light: number): [number, number, number] {
  const x = lights.positions[light * 3] ?? 0;
  const y = lights.positions[light * 3 + 1] ?? 0;
  const z = lights.positions[light * 3 + 2] ?? 0;
  /* Identity view, so this is the position; kept explicit so a different view can be dropped in. */
  return [x, y, -z];
}

/** Whether a light sits close enough to a cluster's face that either answer is defensible. */
function borderline(lights: ClusterLightSet, cluster: number, light: number): boolean {
  const k = Math.floor(cluster / (CLUSTER_X * CLUSTER_Y));
  const j = Math.floor((cluster - k * CLUSTER_X * CLUSTER_Y) / CLUSTER_X);
  const i = cluster - k * CLUSTER_X * CLUSTER_Y - j * CLUSTER_X;
  clusterViewBounds(i, j, k, NEAR, FAR, TAN_HALF_FOV, ASPECT, bounds);
  const [vx, vy, vz] = viewOf(lights, light);
  const dx =
    vx < (bounds[0] ?? 0)
      ? (bounds[0] ?? 0) - vx
      : vx > (bounds[3] ?? 0)
        ? vx - (bounds[3] ?? 0)
        : 0;
  const dy =
    vy < (bounds[1] ?? 0)
      ? (bounds[1] ?? 0) - vy
      : vy > (bounds[4] ?? 0)
        ? vy - (bounds[4] ?? 0)
        : 0;
  const dz =
    vz < (bounds[2] ?? 0)
      ? (bounds[2] ?? 0) - vz
      : vz > (bounds[5] ?? 0)
        ? vz - (bounds[5] ?? 0)
        : 0;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Math.abs(distance - (lights.radii[light] ?? 0)) < BORDERLINE_M;
}

function listOf(table: Uint32Array, cluster: number): number[] {
  const base = clusterBase(cluster);
  const count = Math.min(table[base] ?? 0, MAX_LIGHTS_PER_CLUSTER);
  return Array.from({ length: count }, (_, n) => table[base + 4 + n] ?? 0);
}

const MAP_MODE_READ = 0x0001;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const out = document.getElementById('out') as HTMLElement;
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  const renderer: RendererApi = created.renderer;

  const result: Result = {
    backend: created.backend,
    supported: renderer.computeSupported,
    error: null,
    clusters: CLUSTER_COUNT,
    real: [],
    borderline: 0,
    recordsCompared: 0,
    recordMismatches: 0,
  };

  try {
    if (renderer.computeSupported) {
      const lights = lightSet();
      const binner = new ClusterBinner();
      const handle = renderer.registerCompute(binner.definition());
      binner.setFrame({
        lights,
        view: VIEW,
        near: NEAR,
        far: FAR,
        tanHalfFovY: TAN_HALF_FOV,
        aspect: ASPECT,
        /* Every light gets a slot here, so the record's slot field is exercised across the set. */
        shadowSlots: LIGHT_COUNT,
      });
      renderer.dispatchCompute(handle);

      const texture = binner.tableTexture;
      const gpuDevice = binner.gpuDevice;
      if (texture === null || gpuDevice === null) throw new Error('the binner built no table');

      const bytesPerRow = TABLE_WIDTH * 16;
      const staging = gpuDevice.createBuffer({
        label: 'cluster.readback',
        size: bytesPerRow * TABLE_HEIGHT,
        usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
      });
      const encoder = gpuDevice.createCommandEncoder({ label: 'cluster.readback' });
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: staging, bytesPerRow, rowsPerImage: TABLE_HEIGHT },
        { width: TABLE_WIDTH, height: TABLE_HEIGHT },
      );
      gpuDevice.queue.submit([encoder.finish()]);
      await staging.mapAsync(MAP_MODE_READ);
      const gpuTable = new Uint32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy();
      renderer.unregisterCompute(handle);

      const cpuTable = createClusterTable();
      buildLightClusters(lights, VIEW, NEAR, FAR, TAN_HALF_FOV, ASPECT, cpuTable, LIGHT_COUNT);

      /* The records, which the dispatch copies verbatim and the CPU writes directly. */
      result.recordsCompared = LIGHT_COUNT * LIGHT_TEXELS * 4;
      for (let n = 0; n < result.recordsCompared; n++) {
        if (cpuTable[n] !== gpuTable[n]) result.recordMismatches++;
      }

      for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
        const cpu = listOf(cpuTable, cluster);
        const gpu = listOf(gpuTable, cluster);
        if (cpu.length === gpu.length && cpu.every((v, n) => v === gpu[n])) continue;

        /* Every light one side holds and the other does not. */
        const only = [
          ...cpu.filter((v) => !gpu.includes(v)),
          ...gpu.filter((v) => !cpu.includes(v)),
        ];
        if (only.length > 0 && only.every((light) => borderline(lights, cluster, light))) {
          result.borderline += only.length;
          continue;
        }
        if (result.real.length < 8) result.real.push({ cluster, cpu, gpu });
        else result.real.push({ cluster: -1, cpu: [], gpu: [] });
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  (globalThis as unknown as { __clusterCheck: Result }).__clusterCheck = result;
  out.textContent =
    `backend ${result.backend}\ncomputeSupported ${result.supported}\n` +
    (result.error !== null ? `error ${result.error}\n` : '') +
    `clusters ${result.clusters}\nreal disagreements ${result.real.length}\n` +
    `borderline ${result.borderline}\nrecord mismatches ${result.recordMismatches}`;
}

void main();
