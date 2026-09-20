/**
 * Whether a chain of network operators agrees with the reference on a device, and what each costs.
 *
 * **The chain, through the real runner.** A small vision transformer and a small convolution
 * decoder (`graphs.ts`) run through `createGraphRunner` twice. The first run asks for every value
 * the graph computes, so each dispatch can be held to its reference *on the inputs the device gave
 * it*, with the bound `scripts/inferenceBounds.mjs` derives — which is what makes a bound usable on
 * a chain, where error compounds layer by layer. The second run asks for the graph's own outputs
 * only, so the planner reuses buffers, and must answer bit for bit as the first did: the same
 * kernels on the same values, differing only in where they live. Both precisions.
 *
 * **The cost, at Depth Anything 3 Small's shapes on a 518×518 image**: 1,369 patches of 14 and a
 * class token, 384 channels, 6 heads, a feed-forward of 1,536, 12 blocks, and a DPT head's
 * convolutions up to the full image. Each operator is timed alone; the multiply at both tile edges;
 * GELU fused into its multiply and not; and the whole encoder through the runner. **The time is the
 * device's own**, from timestamps around many dispatches after a warm-up — not the wall clock, which
 * this binding reports in steps of its event poll (`tools/recon-train/budget.ts`).
 *
 * **It measures this machine, and says which one.**
 *
 *     npx tsx --conditions=drift-source tools/capture-weights/opbudget.ts
 *       [--only=chain|operators|encoder] [--blocks=12]
 *
 * Runs in Node on Dawn through `@kmamal/gpu`, the native host's binding, so it needs no browser.
 */
import gpu from '@kmamal/gpu';

import { toHalfFloats } from '../../packages/core/src/render/halfFloat.ts';
import { tiledAttention } from '../../packages/core/src/render/inference/attentionTiled.ts';
import {
  ATTENTION_SPLIT_KEYS,
  attentionKernel,
  linearKernel,
} from '../../packages/core/src/render/inference/denseKernels.ts';
import type { DeviceGraph } from '../../packages/core/src/render/inference/deviceGraph.ts';
import { fuseActivations } from '../../packages/core/src/render/inference/fuse.ts';
import {
  DEVICE_KERNELS,
  type ElementType,
  type KernelGenerator,
} from '../../packages/core/src/render/inference/kernels.ts';
import { planBuffers } from '../../packages/core/src/render/inference/plan.ts';
import { createGraphRunner } from '../../packages/core/src/render/inference/runner.ts';
import { mulberry32 } from '../../packages/core/src/core/rng.ts';
import {
  createGraphEvaluator,
  graphForDevice,
  roundHalf,
  type Attributes,
  type NetworkGraph,
} from '../../packages/texture/src/index.ts';
import {
  boundsFor,
  compareOutputs,
  describeOutcome,
  evaluateNode,
} from '../../scripts/inferenceCheck.mjs';
import { convDecoder, vitEncoder } from './graphs.ts';

function argOf(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const only = argOf('only', 'all');
const blocks = Number(argOf('blocks', '12'));
const size = (shape: readonly number[]): number => shape.reduce((total, d) => total * d, 1);
const seeded = (seed: number, count: number, spread: number): Float32Array => {
  const next = mulberry32(seed);
  return Float32Array.from({ length: count }, () => (next() * 2 - 1) * spread);
};

/* ------------------------------------------------------------------------------------------------
 * The device
 * --------------------------------------------------------------------------------------------- */

const instance = gpu.create([]);
const adapter = await instance.requestAdapter({ powerPreference: 'high-performance' });
if (adapter === null) throw new Error('no adapter');
for (const feature of ['timestamp-query', 'shader-f16'] as const) {
  if (!adapter.features.has(feature)) throw new Error(`this adapter has no ${feature}`);
}
const dawn = await adapter.requestDevice({
  requiredFeatures: ['timestamp-query', 'shader-f16'],
  requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
  },
});
/* The binding's WebGPU types are its own copy of the standard's; the engine's are the DOM's. */
const device = dawn as unknown as GPUDevice;
const info = (
  adapter as unknown as {
    info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  }
).info;
console.log(
  `adapter: ${[info?.vendor, info?.architecture, info?.device].filter(Boolean).join(' ')}` +
    ` — ${info?.description ?? 'no description'}`,
);
device.pushErrorScope('validation');

/** A texture graph as the device takes it, with `outputs` in place of its own. */
function deviceGraph(graph: NetworkGraph, outputs = graph.outputs): DeviceGraph {
  return { ...graphForDevice(graph), outputs };
}

/* ------------------------------------------------------------------------------------------------
 * The chain
 * --------------------------------------------------------------------------------------------- */

async function chain(
  label: string,
  graph: NetworkGraph,
  inputs: ReadonlyMap<string, Float32Array>,
  half: boolean,
): Promise<boolean> {
  const whole = deviceGraph(graph);
  const fused = fuseActivations(whole);
  const stepwise = await createGraphRunner(
    { device, half },
    { ...whole, outputs: fused.nodes.map((node) => node.output) },
  );
  const values = await stepwise.run(inputs);
  stepwise.dispose();

  /* At half, the reference reads each weight as the device stores it: rounded to the nearest half. */
  const weights = new Map(
    whole.tensors.map((tensor) => [tensor.name, half ? tensor.data.map(roundHalf) : tensor.data]),
  );
  const valueOf = (name: string): Float32Array =>
    inputs.get(name) ?? weights.get(name) ?? (values.get(name) as Float32Array);
  let agreed = true;
  let share = 0;
  let exact = 0;
  for (const node of fused.nodes) {
    const nodeInputs = node.inputs.map((name) => ({
      shape: whole.shapes.get(name) ?? [],
      values: valueOf(name),
    }));
    const reference = evaluateNode(node.op, node.attributes, nodeInputs).y;
    const bounds = boundsFor(node.op, node.attributes, nodeInputs, reference);
    const outcome = compareOutputs(values.get(node.output) ?? [], reference, bounds);
    if (outcome.outside.length > 0) {
      agreed = false;
      for (const line of describeOutcome(`${label}: ${node.op} ${node.output}`, outcome)) {
        console.log(line);
      }
    }
    if (outcome.worst === 0) exact += 1;
    share = Math.max(share, outcome.share);
  }

  const planned = await createGraphRunner({ device, half }, whole);
  const answers = await planned.run(inputs);
  planned.dispose();
  const moved = whole.outputs.filter((name) => {
    const a = answers.get(name);
    const b = values.get(name);
    return a === undefined || b === undefined || a.some((value, i) => !Object.is(value, b[i]));
  });
  const plan = planBuffers(fused);
  const count = whole.inputs.length + whole.tensors.length + fused.nodes.length;
  console.log(
    `${moved.length === 0 && agreed ? 'ok  ' : 'FAIL'} ${label}: ${fused.nodes.length} dispatches, ` +
      `each within its bound (${exact} bit for bit, the rest at most ${(share * 100).toFixed(1)}%); ` +
      `${count} values in ${plan.sizes.length} buffers answer ` +
      (moved.length === 0
        ? 'bit for bit as a buffer a value does'
        : `otherwise than a buffer a value: ${moved.join(', ')}`),
  );
  return agreed && moved.length === 0;
}

async function chains(): Promise<boolean> {
  const encoder = vitEncoder(
    { image: 28, patch: 7, dim: 32, heads: 4, hidden: 64, blocks: 2, positionGrid: 5, classes: 5 },
    31,
  );
  const decoder = convDecoder(4, 32, 16, 37);
  const image = new Map([['image', seeded(41, 3 * 28 * 28, 1)]]);
  const tokens = new Map([['tokens', seeded(43, 16 * 32, 1)]]);
  let agreed = true;
  for (const half of [false, true]) {
    const precision = half ? 'half' : 'single';
    agreed = (await chain(`encoder [${precision}]`, encoder, image, half)) && agreed;
    agreed = (await chain(`decoder [${precision}]`, decoder, tokens, half)) && agreed;
  }
  return agreed;
}

/* ------------------------------------------------------------------------------------------------
 * The cost
 * --------------------------------------------------------------------------------------------- */

const STORAGE = 0x0080;
const COPY_DST = 0x0008;
const COPY_SRC = 0x0004;
const QUERY_RESOLVE = 0x0200;
const MAP_READ = 0x0001;
const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
const resolved = device.createBuffer({ size: 16, usage: QUERY_RESOLVE | COPY_SRC });
const readback = device.createBuffer({ size: 16, usage: MAP_READ | COPY_DST });

/**
 * Milliseconds a run, from the first pass's start to the last one's end over `count` of them, after
 * as many again to warm the device — a device idling between short bursts clocks down, and a
 * measurement taken cold says more about its power state than about the kernel. `perSubmit` runs
 * go in each command buffer: one for a whole network, whose runs together would outlast the
 * driver's patience with a single submission and lose the device.
 */
async function timed(
  record: (encoder: GPUCommandEncoder, writes?: GPUComputePassTimestampWrites) => void,
  count: number,
  perSubmit: number,
): Promise<number> {
  const submit = (from: number, stamped: boolean): void => {
    const encoder = device.createCommandEncoder();
    for (let i = from; i < Math.min(from + perSubmit, count); i += 1) {
      const first = stamped && i === 0;
      const last = stamped && i === count - 1;
      record(
        encoder,
        first || last
          ? {
              querySet,
              ...(first ? { beginningOfPassWriteIndex: 0 } : {}),
              ...(last ? { endOfPassWriteIndex: 1 } : {}),
            }
          : undefined,
      );
    }
    if (stamped && from + perSubmit >= count) {
      encoder.resolveQuerySet(querySet, 0, 2, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, readback, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
  };
  for (let from = 0; from < count; from += perSubmit) submit(from, false);
  for (let from = 0; from < count; from += perSubmit) submit(from, true);
  await readback.mapAsync(1);
  const stamps = new BigUint64Array(readback.getMappedRange().slice(0));
  readback.unmap();
  return Number((stamps[1] ?? 0n) - (stamps[0] ?? 0n)) / 1e6 / count;
}

/** The GPU time a measurement keeps the device busy for, warming and then timing: long enough
 * that its clock has risen to what a sustained load gets. One block of the encoder measured over a
 * 50 ms burst took 5.15 ms a run, and over 500 ms, 3.27 — the same work, at two clocks. */
const SUSTAINED_MS = 300;

/** `timed`, with as many runs as keep the device busy for `SUSTAINED_MS` each way. */
async function sustained(
  record: (encoder: GPUCommandEncoder, writes?: GPUComputePassTimestampWrites) => void,
  perSubmit: number,
): Promise<number> {
  const estimate = await timed(record, 5, perSubmit);
  const count = Math.min(20000, Math.max(20, Math.ceil(SUSTAINED_MS / Math.max(estimate, 1e-3))));
  return timed(record, count, perSubmit);
}

interface Operation {
  readonly label: string;
  readonly op: string;
  readonly attributes?: Attributes;
  readonly inputs: readonly (readonly number[])[];
  /** Which inputs a network holds as weights, and stores at half precision when asked. */
  readonly weights?: readonly number[];
  readonly generate?: KernelGenerator;
}

/** One operator's kernel, dispatched alone at its shapes, in milliseconds a dispatch. */
async function timeOperation(operation: Operation, half: boolean): Promise<number> {
  const attributes = operation.attributes ?? {};
  const names = operation.inputs.map((_, i) => `in${i}`);
  const outputShape = createGraphEvaluator({
    inputs: operation.inputs.map((shape, i) => ({ name: names[i] as string, shape })),
    outputs: ['y'],
    nodes: [{ op: operation.op, inputs: names, output: 'y', attributes }],
    tensors: new Map(),
  }).shapes.get('y') as readonly number[];
  const inputTypes: ElementType[] = operation.inputs.map((_, i) =>
    half && (operation.weights ?? []).includes(i) ? 'f16' : 'f32',
  );
  const generate = operation.generate ?? (DEVICE_KERNELS.get(operation.op) as KernelGenerator);
  const kernel = generate({ inputShapes: operation.inputs, outputShape, attributes, inputTypes });
  const buffers = operation.inputs.map((shape, i) => {
    const values = seeded(100 + i, size(shape), (operation.weights ?? []).includes(i) ? 0.05 : 1);
    const data = inputTypes[i] === 'f16' ? toHalfFloats(values) : values;
    const buffer = device.createBuffer({
      size: Math.max(4, Math.ceil(data.byteLength / 4) * 4),
      usage: STORAGE | COPY_DST,
    });
    device.queue.writeBuffer(
      buffer,
      0,
      data.byteLength % 4 === 0 ? data : Uint16Array.from([...data, 0]),
    );
    return buffer;
  });
  buffers.push(device.createBuffer({ size: size(outputShape) * 4, usage: STORAGE }));
  const layout = device.createBindGroupLayout({
    entries: buffers.map((_, binding) => ({
      binding,
      visibility: 0x4,
      buffer: { type: binding < operation.inputs.length ? 'read-only-storage' : 'storage' },
    })),
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code: kernel.code }), entryPoint: 'main' },
  });
  const group = device.createBindGroup({
    layout,
    entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const record = (
    encoder: GPUCommandEncoder,
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void => {
    const pass = encoder.beginComputePass(timestampWrites === undefined ? {} : { timestampWrites });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(...kernel.workgroups);
    pass.end();
  };
  /*
   * As many runs a submission as fill about 50 ms, and never fewer than one: an attention over
   * 28,736 keys ran 400 ms a dispatch unsplit, and five of them in one command buffer outlasted the
   * driver and lost the device.
   */
  const once = await timed(record, 1, 1);
  const ms = await sustained(record, Math.max(1, Math.floor(50 / Math.max(once, 1e-3))));
  for (const buffer of buffers) buffer.destroy();
  return ms;
}

const T = 1370;
const D = 384;
const F = 1536;
const OPERATIONS: readonly Operation[] = [
  {
    label: 'patches, 3×518² → 1,369×384',
    op: 'patchEmbed',
    attributes: { patch: 14 },
    inputs: [[3, 518, 518], [D, 3, 14, 14], [D]],
    weights: [1, 2],
  },
  {
    label: 'layer norm, 1,370×384',
    op: 'layerNorm',
    attributes: { epsilon: 1e-6 },
    inputs: [[T, D], [D], [D]],
    weights: [1, 2],
  },
  {
    label: 'multiply 384 → 384 (q, k, v, out)',
    op: 'linear',
    inputs: [[T, D], [D, D], [D]],
    weights: [1, 2],
  },
  {
    label: '… at tile 8',
    op: 'linear',
    inputs: [[T, D], [D, D], [D]],
    weights: [1, 2],
    generate: linearKernel(8),
  },
  {
    label: 'attention, 6 heads of 64',
    op: 'attention',
    attributes: { heads: 6 },
    inputs: [
      [T, D],
      [T, D],
      [T, D],
    ],
    generate: attentionKernel(Number.POSITIVE_INFINITY),
  },
  {
    label: '… keys split',
    op: 'attention',
    attributes: { heads: 6 },
    inputs: [
      [T, D],
      [T, D],
      [T, D],
    ],
    generate: attentionKernel(1),
  },
  /* A prompt's seven tokens against a 64² image, as SAM's decoder attends: 8 heads of 16. */
  {
    label: 'attention, 7 tokens over 4,096',
    op: 'attention',
    attributes: { heads: 8 },
    inputs: [
      [7, 128],
      [4096, 128],
      [4096, 128],
    ],
    generate: attentionKernel(Number.POSITIVE_INFINITY),
  },
  {
    label: '… keys split',
    op: 'attention',
    attributes: { heads: 8 },
    inputs: [
      [7, 128],
      [4096, 128],
      [4096, 128],
    ],
    generate: attentionKernel(1),
  },
  /* A hierarchical encoder's global stage: 32² tokens, 8 heads of 48. */
  {
    label: 'attention, 1,024 tokens, 8 of 48',
    op: 'attention',
    attributes: { heads: 8 },
    inputs: [
      [1024, 384],
      [1024, 384],
      [1024, 384],
    ],
    generate: attentionKernel(Number.POSITIVE_INFINITY),
  },
  {
    label: '… keys split',
    op: 'attention',
    attributes: { heads: 8 },
    inputs: [
      [1024, 384],
      [1024, 384],
      [1024, 384],
    ],
    generate: attentionKernel(1),
  },
  /* Where the two forms meet: 256 tokens, 8 heads of 32. */
  {
    label: 'attention, 256 tokens, 8 of 32',
    op: 'attention',
    attributes: { heads: 8 },
    inputs: [
      [256, 256],
      [256, 256],
      [256, 256],
    ],
    generate: attentionKernel(Number.POSITIVE_INFINITY),
  },
  {
    label: '… keys split',
    op: 'attention',
    attributes: { heads: 8 },
    inputs: [
      [256, 256],
      [256, 256],
      [256, 256],
    ],
    generate: attentionKernel(1),
  },
  /* And 512. */
  {
    label: 'attention, 512 tokens, 8 of 32',
    op: 'attention',
    attributes: { heads: 8 },
    inputs: [
      [512, 256],
      [512, 256],
      [512, 256],
    ],
    generate: attentionKernel(Number.POSITIVE_INFINITY),
  },
  {
    label: '… keys split',
    op: 'attention',
    attributes: { heads: 8 },
    inputs: [
      [512, 256],
      [512, 256],
      [512, 256],
    ],
    generate: attentionKernel(1),
  },
  /* The tiled form against the other two, at the shapes that ask for it. */
  ...(
    [
      ['a memory attention, 4,096 over 4,096, 1 head of 256', 4096, 4096, 256, 1],
      ['a memory attention, 4,096 over 28,736, 1 head of 256', 4096, 28736, 256, 1],
      ['Depth Anything 3, 1,370 tokens, 6 heads of 64', 1370, 1370, 384, 6],
      ['OWLv2 at 960², 3,601 tokens, 12 heads of 64', 3601, 3601, 768, 12],
      ['Hiera’s global stage, 4,096 tokens, 4 heads of 96', 4096, 4096, 384, 4],
      ['Depth Anything 3 at 504 × 280, 721 tokens, 6 heads of 64', 721, 721, 384, 6],
      ['512 tokens, 8 heads of 32', 512, 512, 256, 8],
      ['256 tokens, 8 heads of 32', 256, 256, 256, 8],
      ['128 tokens, 4 heads of 64', 128, 128, 256, 4],
      ['a prompt’s 7 tokens over 4,096, 8 heads of 16', 7, 4096, 128, 8],
      ['4,096 image tokens over 7, 8 heads of 16', 4096, 7, 128, 8],
    ] as const
  ).flatMap(([label, queries, keys, channels, heads]) => [
    {
      label,
      op: 'attention',
      attributes: { heads },
      inputs: [
        [queries, channels],
        [keys, channels],
        [keys, channels],
      ],
      generate: attentionKernel(ATTENTION_SPLIT_KEYS),
    },
    {
      label: '… tiled',
      op: 'attention',
      attributes: { heads },
      inputs: [
        [queries, channels],
        [keys, channels],
        [keys, channels],
      ] as const,
      generate: (request: Parameters<typeof tiledAttention>[0]) => tiledAttention(request),
    },
  ]),
  {
    label: 'windows: 361 of 49, 4 heads of 32',
    op: 'attention',
    attributes: { heads: 4 },
    inputs: [
      [361, 49, 128],
      [361, 49, 128],
      [361, 49, 128],
    ],
    generate: attentionKernel(ATTENTION_SPLIT_KEYS),
  },
  {
    label: '… tiled',
    op: 'attention',
    attributes: { heads: 4 },
    inputs: [
      [361, 49, 128],
      [361, 49, 128],
      [361, 49, 128],
    ],
    generate: (request: Parameters<typeof tiledAttention>[0]) => tiledAttention(request),
  },
  {
    label: 'windows: 25 of 196, 5 heads of 32',
    op: 'attention',
    attributes: { heads: 5 },
    inputs: [
      [25, 196, 160],
      [25, 196, 160],
      [25, 196, 160],
    ],
    generate: attentionKernel(ATTENTION_SPLIT_KEYS),
  },
  {
    label: '… tiled',
    op: 'attention',
    attributes: { heads: 5 },
    inputs: [
      [25, 196, 160],
      [25, 196, 160],
      [25, 196, 160],
    ],
    generate: (request: Parameters<typeof tiledAttention>[0]) => tiledAttention(request),
  },
  /* A window of 49, as TinyViT attends: 361 windows, 4 heads of 32. */
  {
    label: 'attention, 361 windows of 49',
    op: 'attention',
    attributes: { heads: 4 },
    inputs: [
      [361, 49, 128],
      [361, 49, 128],
      [361, 49, 128],
    ],
    generate: attentionKernel(Number.POSITIVE_INFINITY),
  },
  {
    label: '… keys split',
    op: 'attention',
    attributes: { heads: 4 },
    inputs: [
      [361, 49, 128],
      [361, 49, 128],
      [361, 49, 128],
    ],
    generate: attentionKernel(1),
  },
  { label: 'layer scale, 1,370×384', op: 'mul', inputs: [[T, D], [D]], weights: [1] },
  {
    label: 'residual, 1,370×384',
    op: 'add',
    inputs: [
      [T, D],
      [T, D],
    ],
  },
  { label: 'multiply 384 → 1,536', op: 'linear', inputs: [[T, D], [F, D], [F]], weights: [1, 2] },
  {
    label: '… at tile 8',
    op: 'linear',
    inputs: [[T, D], [F, D], [F]],
    weights: [1, 2],
    generate: linearKernel(8),
  },
  {
    label: '… with GELU fused',
    op: 'linear',
    attributes: { activation: 'gelu' },
    inputs: [[T, D], [F, D], [F]],
    weights: [1, 2],
  },
  { label: 'GELU alone, 1,370×1,536', op: 'gelu', inputs: [[T, F]] },
  { label: 'multiply 1,536 → 384', op: 'linear', inputs: [[T, F], [D, F], [D]], weights: [1, 2] },
  {
    label: '… at tile 8',
    op: 'linear',
    inputs: [[T, F], [D, F], [D]],
    weights: [1, 2],
    generate: linearKernel(8),
  },
  {
    label: 'head: drop the class token',
    op: 'slice',
    attributes: { axis: 0, start: 1, end: T },
    inputs: [[T, D]],
  },
  {
    label: 'head: tokens to channels',
    op: 'permute',
    attributes: { order: [1, 0] },
    inputs: [[T - 1, D]],
  },
  {
    label: 'head: 1×1, 384 → 48 at 37²',
    op: 'conv2d',
    inputs: [[D, 37, 37], [48, D, 1, 1], [48]],
    weights: [1, 2],
  },
  {
    label: 'head: ×4 transposed, 48 at 148²',
    op: 'convTranspose2d',
    attributes: { stride: 4 },
    inputs: [[48, 37, 37], [48, 48, 4, 4], [48]],
    weights: [1, 2],
  },
  {
    label: 'head: 3×3, 48 → 64 at 148²',
    op: 'conv2d',
    attributes: { padding: 1 },
    inputs: [
      [48, 148, 148],
      [64, 48, 3, 3],
    ],
    weights: [1],
  },
  {
    label: 'head: 3×3, 64 → 64 at 148²',
    op: 'conv2d',
    attributes: { padding: 1 },
    inputs: [[64, 148, 148], [64, 64, 3, 3], [64]],
    weights: [1, 2],
  },
  {
    label: 'head: resize 64 × 148² → 296²',
    op: 'resize',
    attributes: { height: 296, width: 296, mode: 'bilinear', alignCorners: true },
    inputs: [[64, 148, 148]],
  },
  {
    label: 'head: 3×3, 64 → 32 at 296²',
    op: 'conv2d',
    attributes: { padding: 1 },
    inputs: [[64, 296, 296], [32, 64, 3, 3], [32]],
    weights: [1, 2],
  },
  {
    label: 'head: resize 32 × 296² → 518²',
    op: 'resize',
    attributes: { height: 518, width: 518, mode: 'bilinear', alignCorners: true },
    inputs: [[32, 296, 296]],
  },
  {
    label: 'head: 3×3, 32 → 32 at 518²',
    op: 'conv2d',
    attributes: { padding: 1 },
    inputs: [[32, 518, 518], [32, 32, 3, 3], [32]],
    weights: [1, 2],
  },
  {
    label: 'head: 1×1, 32 → 1 at 518²',
    op: 'conv2d',
    inputs: [[32, 518, 518], [1, 32, 1, 1], [1]],
    weights: [1, 2],
  },
];

async function operatorCosts(): Promise<void> {
  console.log(
    `\neach operator alone, after ${SUSTAINED_MS} ms of it; ms a dispatch, single | half`,
  );
  for (const operation of OPERATIONS) {
    const single = await timeOperation(operation, false);
    const half = (operation.weights ?? []).length > 0 ? await timeOperation(operation, true) : null;
    console.log(
      `  ${operation.label.padEnd(36)} ${single.toFixed(3).padStart(8)}` +
        (half === null ? '' : ` | ${half.toFixed(3).padStart(8)}`),
    );
  }
}

async function encoderCosts(): Promise<void> {
  const encoder = vitEncoder({ image: 518, patch: 14, dim: D, heads: 6, hidden: F, blocks }, 53);
  const unfused = encoder.nodes.filter((node) => node.op === 'gelu').flatMap((node) => node.inputs);
  const image = new Map([['image', seeded(59, 3 * 518 * 518, 1)]]);
  const whole = async (graph: DeviceGraph, half: boolean): Promise<number> => {
    const runner = await createGraphRunner({ device, half }, graph);
    await runner.run(image);
    const ms = await sustained((commands, writes) => runner.encode(commands, writes), 1);
    runner.dispose();
    return ms;
  };
  console.log(`\nthe whole encoder, ${encoder.nodes.length} nodes, through the runner; ms a run`);
  let reference = 0;
  for (const half of [false, true]) {
    for (const fuse of [true, false]) {
      const ms = await whole(
        deviceGraph(encoder, fuse ? encoder.outputs : [...encoder.outputs, ...unfused]),
        half,
      );
      if (!half && fuse) reference = ms;
      console.log(
        `  ${half ? 'half' : 'single'} precision, GELU ${fuse ? 'fused' : 'apart'}`.padEnd(40) +
          ms.toFixed(2).padStart(8),
      );
    }
  }
  /*
   * **Attention's share, measured where it runs**, as a control on the figures taken alone. One run
   * of the operators timed attention at 2.6 ms a dispatch and the next two at 1.67, on the same
   * build; a figure taken alone is only as good as the device's state while it was taken. Each
   * attention is replaced by an add of the same shape, and the difference is what attention costs
   * inside the encoder's own pass — which is the number a budget is made of.
   */
  const without: NetworkGraph = {
    ...encoder,
    nodes: encoder.nodes.map((node) =>
      node.op === 'attention'
        ? { ...node, op: 'add', inputs: node.inputs.slice(0, 2), attributes: {} }
        : node,
    ),
  };
  const rest = await whole(deviceGraph(without), false);
  console.log(
    `  single, each attention an add instead`.padEnd(40) +
      rest.toFixed(2).padStart(8) +
      ` — attention ${(reference - rest).toFixed(2)} of it, ${((reference - rest) / blocks).toFixed(2)} a block`,
  );
}

/* ------------------------------------------------------------------------------------------------
 * The run
 * --------------------------------------------------------------------------------------------- */

let agreed = true;
if (only === 'all' || only === 'chain') agreed = await chains();
if (only === 'all' || only === 'operators') await operatorCosts();
if (only === 'all' || only === 'encoder') await encoderCosts();
const scope = await device.popErrorScope();
if (scope !== null) console.log(`device: ${scope.message}`);
/* Dawn asserts on a natural exit over objects already released; see the native host's `game.ts`. */
process.exit(agreed && scope === null ? 0 : 1);
