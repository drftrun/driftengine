/**
 * A graph on a device: its buffers, its pipelines, and one compute pass that runs it.
 *
 * **A binder over `schedule.ts`**, which decides everything and is tested without a device; what is
 * left here is creating what the schedule names and recording its dispatches. One pass holds the
 * whole graph, because WebGPU orders a pass's dispatches and makes each one's writes visible to the
 * next — a network is a chain of dependent dispatches and needs nothing more.
 *
 * **Creation is asynchronous, and it is where anything wrong is reported**: a value larger than the
 * device can bind is refused by name before a buffer exists, and every pipeline is built with
 * `createComputePipelineAsync`, which rejects on a kernel that does not compile. A runner that was
 * created runs. Identical kernels share one pipeline — a transformer repeats one block's shapes
 * once per layer, so its pipelines number its distinct shapes rather than its nodes.
 *
 * `encode` records the graph into a caller's encoder, so a network can run inside a frame or under
 * a timestamp query; `run` is the whole round trip, and one is in flight at a time, because its
 * readback buffers are the runner's and a second run would map them while the first holds them.
 * **A run the device refuses is refused too**: WebGPU reports a validation failure at `submit`,
 * and a refused command buffer runs nothing, so without the scope around it the readback would
 * map and return whatever the buffers last held — a plausible answer to a question never run.
 */
import { shapeSize, type DeviceGraph } from './deviceGraph.ts';
import type { InferenceDevice } from './device.ts';
import { scheduleGraph } from './schedule.ts';

/* The usage and stage flags by value: a host with no browser has no `GPUBufferUsage` global. */
const MAP_READ = 0x0001;
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const STORAGE = 0x0080;
const COMPUTE = 0x4;
const MODE_READ = 0x0001;

export interface GraphRunner {
  /** Records every dispatch of the graph into `encoder`, in one compute pass. */
  encode(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void;
  /** Writes the inputs, runs the graph and reads its outputs back, each by name. */
  run(inputs: ReadonlyMap<string, Float32Array>): Promise<Map<string, Float32Array>>;
  dispose(): void;
}

export async function createGraphRunner(
  inference: InferenceDevice,
  graph: DeviceGraph,
): Promise<GraphRunner> {
  const { device } = inference;
  const schedule = scheduleGraph(graph, { half: inference.half });
  const namesOf = new Map<number, string[]>();
  for (const [name, slot] of schedule.plan.slotOf) {
    namesOf.set(slot, [...(namesOf.get(slot) ?? []), name]);
  }
  const limit = device.limits.maxStorageBufferBindingSize;
  const oversized = schedule.bytes.flatMap((bytes, slot) =>
    bytes > limit ? [`${(namesOf.get(slot) ?? []).join('/')} (${bytes} bytes)`] : [],
  );
  if (oversized.length > 0) {
    throw new Error(
      `${oversized.join(', ')} ${oversized.length === 1 ? 'is' : 'are'} larger than the ` +
        `${limit} bytes this device can bind as one buffer`,
    );
  }

  device.pushErrorScope('validation');
  const buffers = schedule.bytes.map((size, slot) =>
    device.createBuffer({
      label: `inference ${(namesOf.get(slot) ?? []).join('/')}`,
      size,
      usage: STORAGE | COPY_DST | COPY_SRC,
    }),
  );
  for (const upload of schedule.uploads) {
    device.queue.writeBuffer(buffers[upload.slot] as GPUBuffer, 0, padded(upload.data));
  }

  const layouts = new Map<number, GPUBindGroupLayout>();
  const layoutFor = (inputs: number): GPUBindGroupLayout => {
    let layout = layouts.get(inputs);
    if (layout === undefined) {
      const entries: GPUBindGroupLayoutEntry[] = [];
      for (let i = 0; i <= inputs; i += 1) {
        entries.push({
          binding: i,
          visibility: COMPUTE,
          buffer: { type: i < inputs ? 'read-only-storage' : 'storage' },
        });
      }
      layout = device.createBindGroupLayout({ label: `inference ${inputs} in`, entries });
      layouts.set(inputs, layout);
    }
    return layout;
  };
  const pipelines = new Map<string, Promise<GPUComputePipeline>>();
  const steps = await Promise.all(
    schedule.steps.map(async (step) => {
      const layout = layoutFor(step.slots.length - 1);
      let pipeline = pipelines.get(step.code);
      if (pipeline === undefined) {
        pipeline = device.createComputePipelineAsync({
          label: `inference ${step.label}`,
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: {
            module: device.createShaderModule({ label: step.label, code: step.code }),
            entryPoint: 'main',
          },
        });
        pipelines.set(step.code, pipeline);
      }
      const group = device.createBindGroup({
        label: `inference ${step.label}`,
        layout,
        entries: step.slots.map((slot, binding) => ({
          binding,
          resource: { buffer: buffers[slot] as GPUBuffer },
        })),
      });
      return { pipeline: await pipeline, group, workgroups: step.workgroups };
    }),
  );
  const staging = graph.outputs.map((name) => {
    const bytes = Math.max(4, shapeSize(graph.shapes.get(name) ?? []) * 4);
    return {
      name,
      source: buffers[schedule.plan.slotOf.get(name) as number] as GPUBuffer,
      bytes,
      buffer: device.createBuffer({
        label: `inference readback ${name}`,
        size: bytes,
        usage: MAP_READ | COPY_DST,
      }),
    };
  });
  const invalid = await device.popErrorScope();
  if (invalid !== null)
    throw new Error(`the device refused a network's buffers: ${invalid.message}`);

  const encode = (encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites) => {
    const pass = encoder.beginComputePass(timestampWrites === undefined ? {} : { timestampWrites });
    for (const step of steps) {
      pass.setPipeline(step.pipeline);
      pass.setBindGroup(0, step.group);
      pass.dispatchWorkgroups(step.workgroups[0], step.workgroups[1], step.workgroups[2]);
    }
    pass.end();
  };

  let running = false;
  const run = async (inputs: ReadonlyMap<string, Float32Array>) => {
    if (running) throw new Error('a network runner runs one graph at a time; await the last run');
    for (const input of graph.inputs) {
      const values = inputs.get(input.name);
      const expected = shapeSize(input.shape);
      if (values === undefined || values.length !== expected) {
        throw new RangeError(
          `input "${input.name}" needs ${expected} values and was given ${values?.length ?? 'none'}`,
        );
      }
    }
    running = true;
    try {
      for (const input of graph.inputs) {
        const slot = schedule.plan.slotOf.get(input.name) as number;
        device.queue.writeBuffer(
          buffers[slot] as GPUBuffer,
          0,
          inputs.get(input.name) as Float32Array,
        );
      }
      device.pushErrorScope('validation');
      const encoder = device.createCommandEncoder({ label: 'inference run' });
      encode(encoder);
      for (const out of staging)
        encoder.copyBufferToBuffer(out.source, 0, out.buffer, 0, out.bytes);
      device.queue.submit([encoder.finish()]);
      const refused = await device.popErrorScope();
      if (refused !== null)
        throw new Error(`the device refused a network's run: ${refused.message}`);
      await Promise.all(staging.map((out) => out.buffer.mapAsync(MODE_READ)));
      const results = new Map<string, Float32Array>();
      for (const out of staging) {
        const values = new Float32Array(out.buffer.getMappedRange().slice(0));
        const count = shapeSize(graph.shapes.get(out.name) ?? []);
        results.set(out.name, count === values.length ? values : values.subarray(0, count));
        out.buffer.unmap();
      }
      return results;
    } finally {
      running = false;
    }
  };

  const dispose = () => {
    for (const buffer of buffers) buffer.destroy();
    for (const out of staging) out.buffer.destroy();
  };
  return { encode, run, dispose };
}

/* A queue write is sized in fours, so an odd count of halves is written with one of padding. */
function padded(data: Float32Array | Uint16Array): Float32Array | Uint16Array {
  if (data.byteLength % 4 === 0) return data;
  const out = new Uint16Array(data.length + 1);
  out.set(data);
  return out;
}
