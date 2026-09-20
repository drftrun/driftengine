/**
 * A real clip through every capture stage on the native host: `npm run native:clip -- <file>`.
 *
 * **The same stages the browser runs, on Dawn and Node, with none of the engine changed.** That is
 * the claim Wave 6's Task 21 asks to be checked on real hardware in both hosts, and the only thing
 * this file supplies that `demo/dev/clip.ts` does not is a `FrameSource` over ffmpeg and a device
 * from `HostWindow` — two host concerns, which is exactly what the seams were drawn around.
 *
 * It draws nothing. What a native window does with a scene is `npm run native:scene`'s subject and
 * is already checked pixel-for-pixel against Chrome by `npm run native:gate`; what is under test
 * here is that the capture *runs* on the host, and how long each stage takes when it does.
 *
 *     npm run native:clip -- demo/dev/public/capture/clip-b-h264.mp4 --frames=6 --size=252
 *     npm run native:clip -- <file> --out=room-native.drft
 */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';

import {
  DEPTH_ANYTHING_3,
  captureFile,
  collisionMesh,
  createDepthEstimator,
  createVolume,
  decimate,
  fuseDepth,
  marchVolume,
  proposeEntities,
  segmentGeometry,
  selectFrames,
  type DepthEstimate,
  type RawFrame,
  type SurfaceView,
  type Volume,
} from '../../packages/capture/src/index.ts';
import { createGraphRunner } from '../../packages/core/src/render/inference/runner.ts';
import { readDrft } from '../../packages/drft/src/index.ts';
import { installGpu } from '../../packages/native-host/src/globals.ts';
import { HostWindow } from '../../packages/native-host/src/window.ts';
import {
  buildContours,
  buildPolyMesh,
  buildRegions,
  voxeliseWalkable,
} from '../../packages/nav/src/index.ts';
import {
  graphForDevice,
  graphFromStored,
  type GraphTensor,
  type NetworkGraph,
  type WeightSource,
} from '../../packages/texture/src/index.ts';

import { nativeClip } from './clipFrames.ts';

const args = process.argv.slice(2);
const file = args.find((one) => !one.startsWith('--'));
if (file === undefined) {
  console.error(
    'usage: npm run native:clip -- <clip.mp4> [--frames=6] [--size=252] [--out=x.drft]',
  );
  process.exit(1);
}
const flag = (name: string, fallback: string): string =>
  args.find((one) => one.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const frameBudget = Number(flag('frames', '6'));
const modelSize = Number(flag('size', '252'));
const outFile = flag('out', '');
const modelFile = flag('model', 'models/capture/depth-anything-3-small.drft');

const timings: { stage: string; ms: number; note: string }[] = [];
async function timed<T>(stage: string, run: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  const value = await run();
  timings.push({ stage, ms: performance.now() - started, note: '' });
  return value;
}
function note(text: string): void {
  const last = timings.at(-1);
  if (last !== undefined) timings[timings.length - 1] = { ...last, note: text };
}

/** One runner per graph, kept: building one compiles every kernel it needs. */
function deviceRun(device: GPUDevice, half: boolean) {
  const runners = new Map<NetworkGraph, Awaited<ReturnType<typeof createGraphRunner>>>();
  return async (
    graph: NetworkGraph,
    inputs: ReadonlyMap<string, Float32Array>,
  ): Promise<ReadonlyMap<string, Float32Array>> => {
    let runner = runners.get(graph);
    if (runner === undefined) {
      runner = await createGraphRunner({ device, half }, graphForDevice(graph));
      runners.set(graph, runner);
    }
    return runner.run(inputs);
  };
}

function weightsOf(bytes: ArrayBuffer): WeightSource {
  const { graphs } = readDrft(bytes);
  const stored = graphs[0];
  if (stored === undefined) throw new Error('the model file holds no graph');
  const tensors: ReadonlyMap<string, GraphTensor> = graphFromStored(stored).tensors;
  return { get: (name) => tensors.get(name), names: () => tensors.keys() };
}

/** A depth estimate as the fusion stage's views. The same conversion the browser harness makes. */
function surfaceViews(estimate: DepthEstimate): SurfaceView[] {
  return estimate.views.map((view) => ({
    depth: view.depth,
    coverage: view.confidence,
    camera: {
      width: estimate.width,
      height: estimate.height,
      intrinsics: [
        view.intrinsics[0] as number,
        view.intrinsics[4] as number,
        view.intrinsics[2] as number,
        view.intrinsics[5] as number,
      ] as const,
      worldToCamera: Float64Array.from(view.worldToCamera),
    },
  }));
}

/** A volume covering what the views saw, sized from the reconstruction rather than chosen. */
function volumeFor(views: readonly SurfaceView[], resolution: number): Volume {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  let seen = 0;
  for (const view of views) {
    const { width, height, intrinsics, worldToCamera } = view.camera;
    const [fx, fy, cx, cy] = intrinsics;
    for (let pixel = 0; pixel < view.depth.length; pixel += 1) {
      const z = view.depth[pixel] as number;
      if (!(z > 0) || (view.coverage[pixel] as number) < 0.5) continue;
      const px = pixel % width;
      const py = Math.floor(pixel / width);
      if (py >= height) break;
      const cxz = ((px + 0.5 - cx) / fx) * z;
      const cyz = ((py + 0.5 - cy) / fy) * z;
      for (let axis = 0; axis < 3; axis += 1) {
        const value =
          (worldToCamera[axis] as number) * (cxz - (worldToCamera[3] as number)) +
          (worldToCamera[4 + axis] as number) * (cyz - (worldToCamera[7] as number)) +
          (worldToCamera[8 + axis] as number) * (z - (worldToCamera[11] as number));
        if (!Number.isFinite(value)) continue;
        low[axis] = Math.min(low[axis] as number, value);
        high[axis] = Math.max(high[axis] as number, value);
      }
      seen += 1;
    }
  }
  if (seen === 0) throw new Error('no view produced a pixel the fusion would believe');
  const span = [0, 1, 2].map((axis) => (high[axis] as number) - (low[axis] as number));
  const pad = Math.max(...span) * 0.1;
  const spacing = (Math.max(...span) + pad * 2) / resolution;
  note(
    `${seen.toLocaleString()} points, ${span.map((one) => one.toFixed(2)).join('×')} m ` +
      `at ${spacing.toFixed(3)} m`,
  );
  return createVolume(
    [
      Math.max(2, Math.ceil(((span[0] as number) + pad * 2) / spacing) + 1),
      Math.max(2, Math.ceil(((span[1] as number) + pad * 2) / spacing) + 1),
      Math.max(2, Math.ceil(((span[2] as number) + pad * 2) / spacing) + 1),
    ],
    [(low[0] as number) - pad, (low[1] as number) - pad, (low[2] as number) - pad],
    spacing,
  );
}

const host = new HostWindow({
  title: 'driftengine capture',
  width: 320,
  height: 180,
  hidden: true,
});
installGpu(host.gpu);

const source = await timed('open', () => nativeClip(file));
note(`${source.width}×${source.height} at ${source.frameRate.toFixed(2)} fps`);

const every = Math.max(1, Math.floor(source.frameCount() / frameBudget));
const kept = await timed('choose', () => selectFrames(source, { budget: frameBudget, every }));
note(`${kept.length} of ${source.frameCount()} frames, every ${every}`);

const frames = await timed('decode', () => {
  const out: RawFrame[] = [];
  for (const index of kept) {
    const pixels = new Uint8Array(source.width * source.height * 4);
    /* This source answers synchronously — ffmpeg has already run — but the seam allows a promise. */
    const size = source.frameAt(index, pixels) as { width: number; height: number };
    out.push({ pixels, width: size.width, height: size.height });
  }
  return out;
});

const { device, half } = await timed('device', async () => {
  const adapter = await host.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) throw new Error('this host has no adapter');
  const supportsHalf = adapter.features.has('shader-f16');
  const got = await adapter.requestDevice({
    requiredFeatures: supportsHalf ? (['shader-f16'] as const) : [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  return { device: got, half: supportsHalf };
});
note(half ? 'half precision available' : 'single precision only');

const weights = await timed('weights', () => {
  const read = readFileSync(modelFile);
  return weightsOf(read.buffer.slice(read.byteOffset, read.byteOffset + read.byteLength));
});

const estimate = await timed('depth + poses', () =>
  createDepthEstimator(DEPTH_ANYTHING_3.small, weights, deviceRun(device, half), {
    size: modelSize,
  }).estimate(frames),
);
note(`${estimate.views.length} views at ${estimate.width}×${estimate.height}`);

const views = surfaceViews(estimate);
const volume = await timed('volume', () => volumeFor(views, 96));
await timed('fuse', () => {
  fuseDepth(views, volume);
});
const mesh = await timed('march', () => marchVolume(volume));
note(`${mesh.indices.length / 3} triangles`);
const cleaned = await timed('decimate', () =>
  decimate(mesh, Math.max(512, Math.floor(mesh.indices.length / 6))),
);
note(`${cleaned.indices.length / 3} triangles`);

await timed('colliders', () => collisionMesh(cleaned));
const navigation = await timed('navmesh', () => {
  const cell = Math.max(0.05, volume.spacing);
  const field = voxeliseWalkable(
    { positions: cleaned.positions, indices: cleaned.indices },
    { cellSize: cell, cellHeight: cell * 0.7, maxSlope: 45, agentHeight: 1.2, agentRadius: 0.2 },
  );
  const regions = buildRegions(field, { minRegionSpans: 4, maxStep: 1 });
  return buildPolyMesh(buildContours(field, regions, 0.5), 6, field);
});
note(`${navigation.polyCount} polygons`);

const proposals = await timed('segment', () => proposeEntities(segmentGeometry(cleaned)));
note(`${proposals.length} entities proposed`);

const bytes = new Uint8Array(
  await timed('write', () => captureFile({ mesh: cleaned, navigation, proposals })),
);
note(`${(bytes.byteLength / 1e6).toFixed(2)} MB`);
if (outFile !== '') writeFileSync(outFile, bytes);

const total = timings.reduce((sum, one) => sum + one.ms, 0);
for (const { stage, ms, note: said } of timings) {
  console.log(`${stage.padEnd(14)} ${(ms / 1000).toFixed(2).padStart(7)} s   ${said}`);
}
console.log(`${'total'.padEnd(14)} ${(total / 1000).toFixed(2).padStart(7)} s`);
host.close();
