import { expect, it } from 'vitest';

import { GpuSkinnedCloth } from './gpuSkinnedCloth.ts';
import type { SkinnedClothSetup } from '@driftengine/physics';

/**
 * A device that writes everything down in one list, in order — writes, dispatches and submits — so
 * a test can read what a submit saw. What it hands back is labelled and otherwise inert.
 */
function recordingDevice() {
  const log: { op: string; label?: string; offset?: number; offsets?: number[]; data?: unknown }[] =
    [];
  const labelled = (label = '') => ({ label });
  const pass = {
    setPipeline: (pipeline: { label: string }) =>
      log.push({ op: 'pipeline', label: pipeline.label }),
    setBindGroup: (index: number, group: { label: string }, offsets?: number[]) => {
      if (index === 0) log.push({ op: 'group', offsets: [...(offsets ?? [])] });
    },
    dispatchWorkgroups: () => log.push({ op: 'dispatch' }),
    end: () => {},
  };
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => ({ ...labelled(d.label), destroy: () => {} }),
    createTexture: (d: GPUTextureDescriptor) => ({
      ...labelled(d.label),
      createView: () => labelled(d.label),
      destroy: () => {},
    }),
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => labelled(d.label),
    createPipelineLayout: () => labelled('layout'),
    createBindGroup: (d: GPUBindGroupDescriptor) => labelled(d.label),
    createShaderModule: (d: GPUShaderModuleDescriptor) => labelled(d.label),
    createComputePipeline: (d: GPUComputePipelineDescriptor) => labelled(d.label),
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      finish: () => labelled('commands'),
      copyBufferToBuffer: () => {},
    }),
    queue: {
      writeBuffer: (
        buffer: { label: string },
        offset: number,
        data: ArrayBufferView | ArrayBuffer,
      ) => log.push({ op: 'write', label: buffer.label, offset, data }),
      writeTexture: () => {},
      submit: () => log.push({ op: 'submit' }),
    },
  };
  return { device: device as unknown as GPUDevice, log };
}

/** A chain of three hanging from a pinned particle: two distance batches, as the CPU colours it. */
function chain(parameters: SkinnedClothSetup['parameters']): SkinnedClothSetup {
  return {
    positions: new Float32Array([0, 0, 0, 0, -1, 0, 0, -2, 0]),
    inverseMass: new Float32Array([0, 1, 1]),
    distance: {
      pairs: new Uint32Array([0, 1, 1, 2]),
      rest: new Float32Array([1, 1]),
      compliance: new Float32Array(2),
    },
    parameters,
  };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/*
 * **A frame is the CPU solver's steps, in the CPU solver's order.** The first pose resets: the pose
 * skinned, every particle to rest, then a step of two substeps, each predicted, its two batches
 * solved twice over, then limited and finished — and the particles published, in one submit.
 */
it("DISPATCHES A FRAME IN THE CPU SOLVER'S ORDER, IN ONE SUBMIT", () => {
  const { device, log } = recordingDevice();
  const cloth = new GpuSkinnedCloth(device, chain({ substeps: 2, iterations: 2 }));
  log.length = 0;
  cloth.advance(new Float32Array(16), IDENTITY, 1 / 60, 1);
  const order = log
    .filter((entry) => entry.op === 'pipeline' || entry.op === 'submit')
    .map((entry) =>
      entry.op === 'submit' ? 'submit' : (entry.label ?? '').replace('cloth.cloth', ''),
    );
  const substep = ['Predict', 'Distance', 'Distance', 'Distance', 'Distance', 'Limit', 'Finish'];
  expect(order).toEqual(['Pose', 'Rest', 'Begin', ...substep, ...substep, 'Publish', 'submit']);
});

/*
 * **No slot is written twice inside one submit**, which is the whole of the queue-order trap: a
 * write lands ahead of the submit, so a slot rewritten before it would hand every dispatch the last
 * values. Sixty settle steps outrun the ring; the solver must send what it has and start again.
 */
it("NEVER REWRITES A STEP'S SLOT INSIDE THE SUBMIT THAT READS IT, even past the ring", () => {
  const { device, log } = recordingDevice();
  const cloth = new GpuSkinnedCloth(device, chain({ settleSteps: 100 }));
  log.length = 0;
  cloth.advance(new Float32Array(16), IDENTITY, 1 / 60, 1);
  let written = new Set<number>();
  let submits = 0;
  for (const entry of log) {
    if (entry.op === 'submit') {
      submits++;
      written = new Set();
    }
    if (entry.op !== 'write' || entry.label !== 'cloth.steps') continue;
    expect(written.has(entry.offset ?? -1), `slot ${entry.offset} rewritten in one submit`).toBe(
      false,
    );
    written.add(entry.offset ?? -1);
  }
  expect(submits).toBeGreaterThan(1);
});

/*
 * **Each step reads a slot of its own, and a substep's first pass is the one that resets the
 * multipliers** — the CPU's `lambda.fill(0)`. Two steps a frame, two iterations: every distance
 * dispatch's batch slot says `first` on the first pass of its substep and not on the second.
 */
it("gives each step its own slot and resets the multipliers on a substep's first pass only", () => {
  const { device, log } = recordingDevice();
  const cloth = new GpuSkinnedCloth(device, chain({ iterations: 2 }));
  const batches = log.find((entry) => entry.label === 'cloth.batches');
  if (batches === undefined) throw new Error('the batches were never written');
  const words = new Uint32Array((batches.data as Uint32Array).buffer);
  log.length = 0;
  cloth.advance(new Float32Array(16), IDENTITY, 2 / 60, 1);
  const begins: number[] = [];
  const firsts: number[] = [];
  for (let k = 0; k < log.length; k++) {
    const entry = log[k];
    const group = log[k + 1];
    if (entry?.op !== 'pipeline' || group?.op !== 'group') continue;
    const [stepAt, batchAt] = group.offsets ?? [];
    if (entry.label === 'cloth.clothBegin') begins.push(stepAt ?? -1);
    if (entry.label === 'cloth.clothDistance') firsts.push(words[(batchAt ?? 0) / 4 + 2] as number);
  }
  expect(new Set(begins).size).toBe(2);
  /* Per step: two batches on the first pass, then the same two on the second. */
  expect(firsts).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
});

/*
 * **A pose's matrices are never rewritten under a dispatch that reads them.** A reset between frames
 * records its settle steps — which read the colliders — and the next frame's pose writes new ones;
 * written ahead of a submit still holding those steps, the settle would have run against the next
 * pose. Within a submit, the pose's write comes before every dispatch or not at all.
 */
it('NEVER REWRITES A POSE UNDER A DISPATCH THAT READS IT, across a reset', () => {
  const { device, log } = recordingDevice();
  const cloth = new GpuSkinnedCloth(device, chain({ settleSteps: 3 }));
  cloth.advance(new Float32Array(16), IDENTITY, 1 / 60, 1);
  log.length = 0;
  cloth.reset();
  cloth.advance(new Float32Array(16), IDENTITY, 1 / 60, 2);
  let dispatched = false;
  for (const entry of log) {
    if (entry.op === 'submit') dispatched = false;
    if (entry.op === 'dispatch') dispatched = true;
    if (entry.op === 'write' && entry.label === 'cloth.frame') {
      expect(dispatched, 'a pose written under dispatches already recorded').toBe(false);
    }
  }
});

/*
 * **The wind is the frame's, carried in each step's slot** rather than written once with the
 * set-up: a garment follows the scene's one wind, which changes every frame. Set before a frame,
 * it is what every slot that frame writes carries.
 */
it("CARRIES THE FRAME'S WIND IN EVERY STEP IT WRITES", () => {
  const { device, log } = recordingDevice();
  const cloth = new GpuSkinnedCloth(device, chain({ wind: [1, 2, 3] }));
  cloth.advance(new Float32Array(16), IDENTITY, 1 / 60, 1);
  cloth.setWind(4, 0, -2);
  log.length = 0;
  cloth.advance(new Float32Array(16), IDENTITY, 2 / 60, 2);
  const winds = log
    .filter((entry) => entry.op === 'write' && entry.label === 'cloth.steps')
    .map((entry) => Array.from(new Float32Array(entry.data as ArrayBuffer).subarray(28, 31)));
  expect(winds.length).toBeGreaterThan(2);
  for (const wind of winds) expect(wind).toEqual([4, 0, -2]);
});
