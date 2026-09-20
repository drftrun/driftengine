/**
 * What a refinement network costs on a device, measured on the engine's own evaluator.
 *
 * **The shape of reconstruction's learned tier is whatever fits, and this is how "fits" is found.**
 * Each candidate is the one evaluator the device has — in its fixed-shape form, which is what the
 * tier uses, and in its variable form beside it for the comparison — compiled into a compute pass
 * that runs it once per pixel of a frame at output resolution, reading its features from a storage
 * buffer as the tier will read them from the resolved frame, and writing three channels back. The
 * time is the device's own, from timestamps written around many dispatches after a warm-up, and
 * divided. **Not the wall clock**, which this binding reports in steps of its event poll: every
 * shape read 2.0 ms, and the largest exactly 4.0, whatever it was asked to do.
 *
 * **It measures this machine, and says which one.** The slowest device the engine claims is a
 * mid-range phone; a desktop part is ten to thirty times faster at this arithmetic, so a figure here
 * is an upper bound on what a phone can afford only after it is divided by that — which is why the
 * plan keeps the phone's own measurement open until one runs this.
 *
 *     npx tsx --conditions=drift-source tools/recon-train/budget.ts [--size=1280x720] [--runs=50]
 *
 * Runs in Node on Dawn through `@kmamal/gpu`, the native host's binding, so it needs no browser.
 */
import gpu from '@kmamal/gpu';

import {
  networkFixedWgsl,
  networkWgsl,
} from '../../packages/core/src/render/shaders/network.wgsl.ts';
import { networkWeightCount } from '../../packages/texture/src/inference.ts';

const OUTPUTS = 3;
const WIDTH = 32;
const DEPTH = 4;

function argOf(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const [width, height] = argOf('size', '1280x720').split('x').map(Number) as [number, number];
const runs = Number(argOf('runs', '50'));
const pixels = width * height;

interface Candidate {
  readonly inputs: number;
  readonly hidden: readonly number[];
  readonly scalar: 'f32' | 'f16';
  readonly form: 'fixed' | 'variable';
}

function shader(candidate: Candidate): string {
  const s = candidate.scalar;
  const evaluator =
    candidate.form === 'fixed'
      ? networkFixedWgsl({
          name: 'net',
          scalar: s,
          shape: { inputs: candidate.inputs, hidden: candidate.hidden, outputs: OUTPUTS },
        })
      : networkWgsl({ name: 'net', scalar: s, width: WIDTH, hidden: DEPTH });
  /* The fixed form reads its features straight into its own array, with a constant count: staging
     them through the variable form's wide array first puts them back in memory the compiler cannot
     keep in registers, which is the cost the fixed form exists to remove. */
  const load =
    candidate.form === 'fixed'
      ? `var input: array<${s}, ${candidate.inputs}>;
  for (var i = 0u; i < ${candidate.inputs}u; i = i + 1u) {
    input[i] = ${s}(features[p * ${candidate.inputs}u + i]);
  }
  let out = netEval(input);`
      : `var input: array<${s}, ${WIDTH}>;
  for (var i = 0u; i < shape.inputs; i = i + 1u) {
    input[i] = ${s}(features[p * shape.inputs + i]);
  }
  let w = shape.widths[0];
  let widths = array<u32, ${DEPTH}>(w.x, w.y, w.z, w.w);
  let out = netEval(0u, shape.inputs, shape.hidden, widths, shape.outputs, input);`;
  return /* wgsl */ `
${s === 'f16' ? 'enable f16;' : ''}
struct Shape {
  inputs: u32,
  hidden: u32,
  outputs: u32,
  pixels: u32,
  widths: array<vec4<u32>, 1>,
}
@group(0) @binding(0) var<storage, read> weights: array<${s}>;
@group(0) @binding(1) var<storage, read> features: array<f32>;
@group(0) @binding(2) var<storage, read_write> result: array<f32>;
@group(0) @binding(3) var<uniform> shape: Shape;

fn netWeight(index: u32) -> ${s} {
  return weights[index];
}
${evaluator}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = id.x;
  if (p >= shape.pixels) {
    return;
  }
  ${load}
  result[p * 3u] = f32(out[0]);
  result[p * 3u + 1u] = f32(out[1]);
  result[p * 3u + 2u] = f32(out[2]);
}
`;
}

const instance = gpu.create([]);
const adapter = await instance.requestAdapter({ powerPreference: 'high-performance' });
if (adapter === null) throw new Error('no adapter');
const halfAvailable = adapter.features.has('shader-f16');
if (!adapter.features.has('timestamp-query')) {
  throw new Error(
    'this adapter has no timestamp-query, and the wall clock here cannot time a pass',
  );
}
const device = await adapter.requestDevice({
  requiredFeatures: halfAvailable ? ['shader-f16', 'timestamp-query'] : ['timestamp-query'],
  requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
  },
});
const errors: string[] = [];
device.pushErrorScope('validation');

const candidates: Candidate[] = [];
for (const form of ['fixed', 'variable'] as const) {
  for (const scalar of halfAvailable ? (['f32', 'f16'] as const) : (['f32'] as const)) {
    for (const inputs of [11, 27]) {
      for (const hidden of [[8], [16], [8, 8], [16, 16], [32]]) {
        candidates.push({ inputs, hidden, scalar, form });
      }
    }
  }
}

const featureBuffer = device.createBuffer({
  size: pixels * 27 * 4,
  usage: gpu.GPUBufferUsage.STORAGE | gpu.GPUBufferUsage.COPY_DST,
});
const seeded = new Float32Array(pixels * 27);
for (let i = 0; i < seeded.length; i++) seeded[i] = ((i * 2654435761) % 1000) / 1000;
device.queue.writeBuffer(featureBuffer, 0, seeded);
const resultBuffer = device.createBuffer({
  size: pixels * 3 * 4,
  usage: gpu.GPUBufferUsage.STORAGE,
});
const shapeBuffer = device.createBuffer({
  size: 32,
  usage: gpu.GPUBufferUsage.UNIFORM | gpu.GPUBufferUsage.COPY_DST,
});

const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
const resolved = device.createBuffer({
  size: 16,
  usage: gpu.GPUBufferUsage.QUERY_RESOLVE | gpu.GPUBufferUsage.COPY_SRC,
});
const readback = device.createBuffer({
  size: 16,
  usage: gpu.GPUBufferUsage.MAP_READ | gpu.GPUBufferUsage.COPY_DST,
});

/* Typed off the adapter, because the WebGPU types this config reads predate `info`. */
const info = (adapter as unknown as { info?: { description?: string; device?: string } }).info;
console.log(`adapter: ${info?.description || info?.device || 'unnamed'}`);
console.log(`frame: ${width}x${height} (${pixels} pixels), ${runs} runs after a warm-up`);
for (const candidate of candidates) {
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: shader(candidate) }), entryPoint: 'main' },
  });
  const count = networkWeightCount({ ...candidate, outputs: OUTPUTS });
  const bytes = count * (candidate.scalar === 'f16' ? 2 : 4);
  const weightBuffer = device.createBuffer({
    size: Math.ceil(bytes / 4) * 4,
    usage: gpu.GPUBufferUsage.STORAGE | gpu.GPUBufferUsage.COPY_DST,
  });
  const shape = new Uint32Array([
    candidate.inputs,
    candidate.hidden.length,
    OUTPUTS,
    pixels,
    ...[0, 1, 2, 3].map((i) => candidate.hidden[i] ?? 0),
  ]);
  device.queue.writeBuffer(shapeBuffer, 0, shape);
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: weightBuffer } },
      { binding: 1, resource: { buffer: featureBuffer, size: pixels * candidate.inputs * 4 } },
      { binding: 2, resource: { buffer: resultBuffer } },
      { binding: 3, resource: { buffer: shapeBuffer } },
    ],
  });
  const dispatch = (times: number, timed: boolean): void => {
    const encoder = device.createCommandEncoder();
    for (let t = 0; t < times; t++) {
      const first = t === 0;
      const last = t === times - 1;
      const pass = encoder.beginComputePass(
        timed && (first || last)
          ? {
              timestampWrites: {
                querySet,
                ...(first ? { beginningOfPassWriteIndex: 0 } : {}),
                ...(last ? { endOfPassWriteIndex: 1 } : {}),
              },
            }
          : {},
      );
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(pixels / 64));
      pass.end();
    }
    if (timed) {
      encoder.resolveQuerySet(querySet, 0, 2, resolved, 0);
      encoder.copyBufferToBuffer(resolved, 0, readback, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
  };
  dispatch(5, false);
  dispatch(runs, true);
  await readback.mapAsync(gpu.GPUMapMode.READ);
  const stamps = new BigUint64Array(readback.getMappedRange().slice(0));
  readback.unmap();
  const ms = Number((stamps[1] ?? 0n) - (stamps[0] ?? 0n)) / 1e6 / runs;
  const macs = count - (candidate.hidden.reduce((a, b) => a + b, 0) + OUTPUTS);
  console.log(
    `${candidate.form.padEnd(8)} ${candidate.scalar}  ` +
      `${[candidate.inputs, ...candidate.hidden, OUTPUTS].join('-').padEnd(12)}` +
      `  ${String(macs).padStart(4)} multiply-adds a pixel  ${ms.toFixed(3)} ms a frame`,
  );
  weightBuffer.destroy();
}
const scope = await device.popErrorScope();
if (scope !== null) errors.push(scope.message);
for (const error of errors) console.log(`device: ${error}`);
/* Dawn asserts on a natural exit over objects already released; see the native host's `game.ts`. */
process.exit(errors.length === 0 ? 0 : 1);
