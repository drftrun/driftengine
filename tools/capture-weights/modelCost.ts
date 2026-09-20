/**
 * What a whole model costs on a device, measured from the file a game ships — shared by the native
 * host's measurement and the browser's, so the two run the same code on their own `GPU`.
 *
 * **The path measured is the one a game takes**: the converted `.drft`, its graph taken as the
 * runtime takes it, the model rebuilt from those weights at the size asked — 518 square, a depth
 * model's trained size, and 504 × 280, a 16:9 frame at the upstream's default — and run through
 * `createGraphRunner`. Each figure is the device's own time for one run, after as long again to warm
 * it, since a device idling between bursts clocks down (`opbudget.ts` measured one block at 5.15 ms
 * over 50 ms of work and 3.27 over 500). **A browser without `timestamp-query` is timed by the wall
 * clock**, around runs awaited one at a time, and the result says so.
 */
import {
  DEPTH_ANYTHING_2_SMALL,
  DEPTH_ANYTHING_3,
  depthAnything2,
  depthAnything3,
  MOBILE_SAM,
  mobileSamDecoder,
  mobileSamEncoder,
  OWLV2_BASE,
  owlv2Image,
  owlv2Text,
  sam21Decoder,
  sam21Encoder,
  sam21MemoryAttention,
  sam21MemoryEncoder,
  SAM_21_TINY,
  samMasksToImage,
} from '../../packages/capture/src/index.ts';
import { createGraphRunner } from '../../packages/core/src/render/inference/runner.ts';
import { readDrft } from '../../packages/drft/src/index.ts';
import {
  graphForDevice,
  graphFromStored,
  graphFromWeights,
  type Architecture,
  type GraphTensor,
} from '../../packages/texture/src/index.ts';

export interface ModelCost {
  readonly label: string;
  readonly ms: number;
  readonly clock: 'timestamps' | 'wall';
}

/* Usage flags by value: a host with no browser has no `GPUBufferUsage` global. */
const QUERY_RESOLVE = 0x0200;
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const MAP_READ = 0x0001;
const SUSTAINED_MS = 300;

/** The weights a converted file's graph holds, by name: its first, or the one of `role`. */
export function weightsOf(file: ArrayBuffer, role?: string): ReadonlyMap<string, GraphTensor> {
  const { graphs } = readDrft(file);
  const stored = role === undefined ? graphs[0] : graphs.find((graph) => graph.role === role);
  if (stored === undefined)
    throw new Error(`the file holds no graph${role === undefined ? '' : ` for ${role}`}`);
  return graphFromStored(stored).tensors;
}

export async function openDevice(
  gpu: GPU,
): Promise<{ device: GPUDevice; stamped: boolean; half: boolean }> {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) throw new Error('no adapter');
  const stamped = adapter.features.has('timestamp-query');
  const half = adapter.features.has('shader-f16');
  const device = await adapter.requestDevice({
    requiredFeatures: [
      ...(stamped ? (['timestamp-query'] as const) : []),
      ...(half ? (['shader-f16'] as const) : []),
    ],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  return { device, stamped, half };
}

/** Milliseconds a run of `encode`, after `SUSTAINED_MS` of the same work, one run a submission. */
export async function sustained(
  device: GPUDevice,
  stamped: boolean,
  encode: (encoder: GPUCommandEncoder, writes?: GPUComputePassTimestampWrites) => void,
): Promise<number> {
  const once = async (): Promise<number> => {
    const started = performance.now();
    const encoder = device.createCommandEncoder();
    encode(encoder);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  };
  const estimate = await once();
  const count = Math.max(5, Math.ceil(SUSTAINED_MS / Math.max(estimate, 0.1)));
  for (let i = 0; i < count; i += 1) {
    const encoder = device.createCommandEncoder();
    encode(encoder);
    device.queue.submit([encoder.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  if (!stamped) {
    const started = performance.now();
    for (let i = 0; i < count; i += 1) {
      const encoder = device.createCommandEncoder();
      encode(encoder);
      device.queue.submit([encoder.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    return (performance.now() - started) / count;
  }
  const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
  const resolved = device.createBuffer({ size: 16, usage: QUERY_RESOLVE | COPY_SRC });
  const readback = device.createBuffer({ size: 16, usage: MAP_READ | COPY_DST });
  for (let i = 0; i < count; i += 1) {
    const encoder = device.createCommandEncoder();
    const first = i === 0;
    const last = i === count - 1;
    encode(
      encoder,
      first || last
        ? {
            querySet,
            ...(first ? { beginningOfPassWriteIndex: 0 } : {}),
            ...(last ? { endOfPassWriteIndex: 1 } : {}),
          }
        : undefined,
    );
    if (last) {
      encoder.resolveQuerySet(querySet, 0, 2, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, readback, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
  }
  await readback.mapAsync(MAP_READ);
  const stamps = new BigUint64Array(readback.getMappedRange().slice(0));
  readback.unmap();
  querySet.destroy();
  resolved.destroy();
  readback.destroy();
  return Number((stamps[1] ?? 0n) - (stamps[0] ?? 0n)) / 1e6 / count;
}

/**
 * Each accepted model whose file is given, at its sizes, in both precisions where the device has
 * half. `files` maps a manifest name to that model's converted `.drft`.
 */
export async function measureModels(
  gpu: GPU,
  files: ReadonlyMap<string, ArrayBuffer>,
): Promise<ModelCost[]> {
  const { device, stamped, half } = await openDevice(gpu);
  /* `role` names the file's graph whose weights a case reads; null, a graph that reads none. */
  const cases: {
    label: string;
    name: string;
    role?: string | null;
    build: () => Architecture;
  }[] = [
    {
      label: 'Depth Anything 3 Small, 1 view, 518²',
      name: 'depth-anything-3-small',
      build: () => depthAnything3(DEPTH_ANYTHING_3.small, 1, 518, 518),
    },
    {
      label: 'Depth Anything 3 Small, 1 view, 504 × 280',
      name: 'depth-anything-3-small',
      build: () => depthAnything3(DEPTH_ANYTHING_3.small, 1, 280, 504),
    },
    {
      label: 'Depth Anything 3 Small, 2 views, 518²',
      name: 'depth-anything-3-small',
      build: () => depthAnything3(DEPTH_ANYTHING_3.small, 2, 518, 518),
    },
    {
      label: 'Depth Anything V2 Small, 518²',
      name: 'depth-anything-2-small',
      build: () => depthAnything2(DEPTH_ANYTHING_2_SMALL, 518, 518),
    },
    {
      label: 'MobileSAM encoder, 1024²',
      name: 'mobilesam',
      role: 'EMBD',
      build: () => mobileSamEncoder(MOBILE_SAM),
    },
    {
      label: 'MobileSAM decoder, a point',
      name: 'mobilesam',
      role: 'MASK',
      build: () => mobileSamDecoder(MOBILE_SAM, 2),
    },
    {
      label: 'MobileSAM decoder, a point refining a mask',
      name: 'mobilesam',
      role: 'MASK',
      build: () => mobileSamDecoder(MOBILE_SAM, 2, true),
    },
    {
      label: 'SAM 2.1 tiny encoder, 1024²',
      name: 'sam-2.1-tiny',
      role: 'EMBD',
      build: () => sam21Encoder(SAM_21_TINY),
    },
    {
      label: 'SAM 2.1 tiny decoder, a tracked frame',
      name: 'sam-2.1-tiny',
      role: 'MASK',
      build: () => sam21Decoder(SAM_21_TINY, 2),
    },
    {
      label: 'SAM 2.1 tiny memory encoder',
      name: 'sam-2.1-tiny',
      role: 'MEME',
      build: () => sam21MemoryEncoder(SAM_21_TINY, false),
    },
    {
      label: 'SAM 2.1 tiny memory attention, 1 frame',
      name: 'sam-2.1-tiny',
      role: 'MEMA',
      build: () => sam21MemoryAttention(SAM_21_TINY, 1, 4),
    },
    {
      label: 'SAM 2.1 tiny memory attention, 7 frames, 16 pointers',
      name: 'sam-2.1-tiny',
      role: 'MEMA',
      build: () => sam21MemoryAttention(SAM_21_TINY, 7, 64),
    },
    {
      label: 'OWLv2 image, 960²',
      name: 'owlv2-base-patch16',
      role: 'IMAG',
      build: () => owlv2Image(OWLV2_BASE),
    },
    {
      label: 'OWLv2 text, 4 queries',
      name: 'owlv2-base-patch16',
      role: 'TEXT',
      build: () => owlv2Text(OWLV2_BASE, 4),
    },
    {
      label: 'MobileSAM, four masks to a 1920 × 1080 frame',
      name: 'mobilesam',
      role: null,
      build: () => samMasksToImage(MOBILE_SAM, MOBILE_SAM.decoder.masks, 1080, 1920),
    },
  ];
  const results: ModelCost[] = [];
  for (const { label, name, role, build } of cases) {
    const file = files.get(name);
    if (file === undefined) continue;
    const weights = role === null ? new Map<string, GraphTensor>() : weightsOf(file, role);
    const graph = graphFromWeights(
      { get: (key) => weights.get(key), names: () => weights.keys() },
      build(),
    );
    const onDevice = graphForDevice(graph);
    for (const precision of half ? [false, true] : [false]) {
      const runner = await createGraphRunner({ device, half: precision }, onDevice);
      const ms = await sustained(device, stamped, (encoder, writes) =>
        runner.encode(encoder, writes),
      );
      runner.dispose();
      results.push({
        label: `${label}, ${precision ? 'half' : 'single'}`,
        ms,
        clock: stamped ? 'timestamps' : 'wall',
      });
    }
  }
  device.destroy();
  return results;
}
