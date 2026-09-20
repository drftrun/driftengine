import { expect, test } from 'vitest';

import type { DeviceGraph } from './deviceGraph.ts';
import { createGraphRunner } from './runner.ts';

/**
 * **A run the device refused is refused, not answered.** WebGPU reports a validation failure at
 * `finish` or `submit`, not at the call that caused it, and a refused command buffer runs nothing —
 * so without a scope around the run, the readback maps and hands back whatever the buffers held
 * before, and a network answers with a plausible, stale map. The device here is a stand-in that
 * accepts everything at creation and refuses the submitted run, as a real one does when two
 * bindings of one dispatch alias a buffer.
 */

const graph: DeviceGraph = {
  inputs: [{ name: 'x', shape: [4] }],
  outputs: ['y'],
  nodes: [{ op: 'relu', inputs: ['x'], output: 'y', attributes: {} }],
  tensors: [],
  shapes: new Map<string, readonly number[]>([
    ['x', [4]],
    ['y', [4]],
  ]),
};

function refusingDevice(): GPUDevice {
  const scopes: (GPUError | null)[] = [];
  let submitted = false;
  const buffer = () => ({
    destroy: () => undefined,
    mapAsync: async () => undefined,
    getMappedRange: () => new Float32Array([7, 7, 7, 7]).buffer,
    unmap: () => undefined,
  });
  const pass = {
    setPipeline: () => undefined,
    setBindGroup: () => undefined,
    dispatchWorkgroups: () => undefined,
    end: () => undefined,
  };
  return {
    limits: { maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: buffer,
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createComputePipelineAsync: async () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      copyBufferToBuffer: () => undefined,
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: () => undefined,
      submit: () => {
        submitted = true;
      },
    },
    pushErrorScope: () => {
      scopes.push(null);
    },
    popErrorScope: async () => {
      scopes.pop();
      return submitted
        ? ({ message: 'a buffer is bound writable and read-only in one dispatch' } as GPUError)
        : null;
    },
  } as unknown as GPUDevice;
}

test('A RUN THE DEVICE REFUSED IS REFUSED, naming why, rather than answered with stale buffers', async () => {
  const runner = await createGraphRunner({ device: refusingDevice(), half: false }, graph);
  await expect(runner.run(new Map([['x', new Float32Array(4)]]))).rejects.toThrow(
    /refused.*writable and read-only/,
  );
});
