import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { DistanceFieldScene } from '../../gi/fieldScene.ts';
import { FieldComposer } from './fieldCompose.ts';
import {
  COMPOSE_INSTANCE_FLOATS,
  COMPOSE_PARAM_STRIDE,
  INSTANCE_DIMS,
  INSTANCE_OFFSET,
  INSTANCE_SCALE,
} from '../../shaders/gi/composeField.wgsl.ts';

import type { FieldSource } from '../../gi/globalField.ts';

/**
 * The renderer's own composition, over a device that records rather than draws.
 *
 * **What these tests are for is the wiring, not the arithmetic.** `scripts/gi-parity.mjs` proves
 * the shader computes the field the reference computes, sample for sample; nothing here can say
 * anything about that. What it can say is whether each cascade gets its own params, whether the
 * instance count the shader reads is the count the frame declared, and whether sixteen megabytes
 * of samples are re-uploaded to say what they said last frame.
 */

interface StubBuffer {
  readonly label: string;
  readonly bytes: Uint8Array;
  destroyed: boolean;
}

interface Write {
  readonly label: string;
  readonly offset: number;
  readonly bytes: number;
}

function recordingDevice() {
  const writes: Write[] = [];
  const commands: string[] = [];
  /*
   * **What the encoder was asked to do, run only when the frame is submitted**, which is the
   * ordering a device keeps: a queue write lands when it is made, and an encoded command lands when
   * the command buffer holding it runs. `submit` below runs these in order.
   */
  let encoded: (() => void)[] = [];
  const buffers: StubBuffer[] = [];
  let groups = 0;
  const device = {
    features: new Set<string>(),
    queue: {
      writeBuffer(
        buffer: StubBuffer,
        offset: number,
        data: ArrayBufferView,
        dataOffset?: number,
        size?: number,
      ): void {
        const elements = data as unknown as Float32Array;
        const from = (dataOffset ?? 0) * elements.BYTES_PER_ELEMENT;
        const length =
          size === undefined ? data.byteLength - from : size * elements.BYTES_PER_ELEMENT;
        buffer.bytes.set(
          new Uint8Array(data.buffer, data.byteOffset + from, Math.min(length, data.byteLength)),
          offset,
        );
        writes.push({ label: buffer.label, offset, bytes: length });
      },
      submit: () => undefined,
    },
    createBuffer: (descriptor: GPUBufferDescriptor): StubBuffer & { destroy(): void } => {
      const made = {
        label: descriptor.label ?? '',
        bytes: new Uint8Array(descriptor.size),
        destroyed: false,
        destroy(): void {
          made.destroyed = true;
        },
      };
      buffers.push(made);
      return made;
    },
    createShaderModule: (descriptor: GPUShaderModuleDescriptor) => ({
      label: descriptor.label ?? '',
    }),
    createComputePipeline: (descriptor: { label?: string }) => ({
      label: descriptor.label ?? '',
      getBindGroupLayout: (group: number) => ({ label: `${descriptor.label ?? ''} ${group}` }),
    }),
    createBindGroup: (descriptor: GPUBindGroupDescriptor) => ({
      label: descriptor.label ?? '',
      entries: [...descriptor.entries],
      serial: groups++,
    }),
  };
  const encoder = {
    copyBufferToBuffer: (
      source: StubBuffer,
      sourceOffset: number,
      destination: StubBuffer,
      destinationOffset: number,
      size: number,
    ) => {
      commands.push(`copy:${source.label}->${destination.label}`);
      encoded.push(() =>
        destination.bytes.set(
          source.bytes.subarray(sourceOffset, sourceOffset + size),
          destinationOffset,
        ),
      );
    },
    beginComputePass: (descriptor?: { label?: string }) => {
      commands.push(`begin:${descriptor?.label ?? ''}`);
      return {
        setPipeline: () => commands.push('pipeline'),
        setBindGroup: (index: number, group: { label: string }) =>
          commands.push(`group:${group.label}`),
        dispatchWorkgroups: (x: number) => commands.push(`dispatch:${String(x)}`),
        end: () => commands.push('end'),
      };
    },
  };
  return {
    device: device as unknown as GPUDevice,
    encoder: encoder as unknown as GPUCommandEncoder,
    writes,
    commands,
    buffers,
    /** Run what was encoded, in order, as a device does at `submit`. */
    submit: (): void => {
      const due = encoded;
      encoded = [];
      for (const command of due) command();
    },
    bufferFor: (label: string) => buffers.filter((b) => b.label === label).at(-1) as StubBuffer,
  };
}

function sphere(resolution: number): FieldSource {
  return {
    field: new Float32Array(resolution ** 3).fill(1),
    dims: [resolution, resolution, resolution],
    bounds: Float32Array.from([-1, -1, -1, 1, 1, 1]),
  };
}

const OPTIONS = { resolution: 4, cascades: 3, radius: 2 };

function at(x: number, scale = 1): mat4 {
  const model = mat4.create();
  mat4.translate(model, model, [x, 0, 0]);
  mat4.scale(model, model, [scale, scale, scale]);
  return model;
}

test('A FRAME THAT DECLARED NOTHING COMPOSES NOTHING, and says so rather than answering', () => {
  /*
   * An empty instance list fills every cascade with "no surface anywhere", which a march reads as
   * an infinite empty room. That is the right answer and it costs a full dispatch to write; the
   * field a reader would get is the one that was already there, so the honest report is null.
   */
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  composer.compose(gpu.encoder, new DistanceFieldScene(), [0, 0, 0]);

  expect(gpu.commands).toEqual([]);
  expect(composer.field).toBeNull();
});

test('every cascade is dispatched with its own bind group', () => {
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  const scene = new DistanceFieldScene();
  scene.record(sphere(4), at(0));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);

  expect(gpu.commands.filter((c) => c.startsWith('dispatch:'))).toHaveLength(OPTIONS.cascades);
  const bound = gpu.commands.filter((c) => c.startsWith('group:'));
  expect(bound).toEqual(['group:gi compose 0', 'group:gi compose 1', 'group:gi compose 2']);
  expect(composer.field?.levels).toBe(OPTIONS.cascades);
  expect(composer.field?.side).toBe(OPTIONS.resolution);
});

test('EACH CASCADE READS ITS OWN PARAMS, at its own aligned offset', () => {
  /*
   * `queue.writeBuffer` is a queue operation and is not ordered against an encoder's commands, so
   * one params region rewritten between dispatches gives every dispatch the last write — every
   * cascade composed with the outermost one's origin and step, which is a field simply wrong
   * everywhere. A slot a cascade is what keeps them apart, and the offsets are the evidence.
   */
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  const scene = new DistanceFieldScene();
  scene.record(sphere(4), at(0));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);

  const offsets = gpu.writes.filter((w) => w.label === 'gi-field params').map((w) => w.offset);
  expect(offsets).toEqual([0, COMPOSE_PARAM_STRIDE, COMPOSE_PARAM_STRIDE * 2]);

  /* And the three origins differ, because `placeCascade` nests them. */
  const params = new Float32Array(gpu.bufferFor('gi-field params').bytes.buffer);
  const steps = [0, 1, 2].map((level) => params[(level * COMPOSE_PARAM_STRIDE) / 4 + 3] as number);
  expect(steps[1]).toBeCloseTo((steps[0] as number) * 2, 6);
  expect(steps[2]).toBeCloseTo((steps[0] as number) * 4, 6);
});

test('the instance count the shader reads is the count the frame declared', () => {
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  const scene = new DistanceFieldScene();
  const source = sphere(4);
  scene.record(source, at(0));
  scene.record(source, at(3));
  scene.record(source, at(6));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);

  const params = new Float32Array(gpu.bufferFor('gi-field params').bytes.buffer);
  expect(params[8]).toBe(3);
});

test('AN INSTANCE CARRIES ITS SOURCE OFFSET, so two fields do not read one field', () => {
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  const scene = new DistanceFieldScene();
  const small = sphere(4);
  const large = sphere(5);
  scene.record(small, at(0));
  scene.record(large, at(3, 2));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);

  const instances = new Float32Array(gpu.bufferFor('gi-field instances').bytes.buffer);
  expect(instances[INSTANCE_OFFSET]).toBe(0);
  expect(instances[COMPOSE_INSTANCE_FLOATS + INSTANCE_OFFSET]).toBe(small.field.length);
  expect(instances[INSTANCE_DIMS]).toBe(4);
  expect(instances[COMPOSE_INSTANCE_FLOATS + INSTANCE_DIMS]).toBe(5);
  /* The scale the shader divides by, read off the matrix rather than asked for separately. */
  expect(instances[INSTANCE_SCALE]).toBeCloseTo(1, 6);
  expect(instances[COMPOSE_INSTANCE_FLOATS + INSTANCE_SCALE]).toBeCloseTo(2, 6);
});

test('THE SAMPLES ARE NOT RE-UPLOADED TO SAY WHAT THEY SAID LAST FRAME', () => {
  /*
   * The whole reason `DistanceFieldScene` tracks its packing. A field is megabytes and a placement
   * is bytes, so a composer that wrote the samples every frame would move the world across the bus
   * once a frame for no change. The placements are written every frame, and must be.
   */
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  const scene = new DistanceFieldScene();
  const source = sphere(4);

  scene.record(source, at(0));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);
  expect(gpu.writes.filter((w) => w.label === 'gi-field sources')).toHaveLength(1);

  scene.reset();
  scene.record(source, at(9));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);
  expect(gpu.writes.filter((w) => w.label === 'gi-field sources')).toHaveLength(1);
  expect(gpu.writes.filter((w) => w.label === 'gi-field instances')).toHaveLength(2);

  /* A different set of fields is a different packing, and that one is uploaded. */
  scene.reset();
  scene.record(source, at(0));
  scene.record(sphere(5), at(4));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);
  expect(gpu.writes.filter((w) => w.label === 'gi-field sources')).toHaveLength(3);
});

test('the source buffer grows to fit a larger scene and the old one is released', () => {
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  const scene = new DistanceFieldScene();

  scene.record(sphere(4), at(0));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);
  const first = gpu.bufferFor('gi-field sources');
  expect(first.bytes.byteLength).toBeGreaterThanOrEqual(4 ** 3 * 4);

  scene.reset();
  scene.record(sphere(8), at(0));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);
  const second = gpu.bufferFor('gi-field sources');
  expect(second).not.toBe(first);
  expect(first.destroyed).toBe(true);
  expect(second.bytes.byteLength).toBeGreaterThanOrEqual(8 ** 3 * 4);

  /* And a smaller scene afterwards reuses it rather than shrinking. */
  scene.reset();
  scene.record(sphere(4), at(0));
  composer.compose(gpu.encoder, scene, [0, 0, 0]);
  expect(gpu.bufferFor('gi-field sources')).toBe(second);
});

test('the field reports the outermost cascade and the finest step a march needs', () => {
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  const scene = new DistanceFieldScene();
  scene.record(sphere(4), at(0));
  composer.compose(gpu.encoder, scene, [5, 0, 0]);

  const field = composer.field;
  expect(field).not.toBeNull();
  expect(field?.finestStep).toBeGreaterThan(0);
  /*
   * **Near the eye but snapped to its own step, not centred on it.** `placeCascade` rounds each
   * centre to a multiple of the cascade's step because a grid centred on the exact camera position
   * resamples the world at a new sub-pixel offset every frame, and the indirect light shimmers —
   * worst on a slow camera, which is when somebody is looking at it.
   */
  const bounds = field?.outerBounds as Float32Array;
  const width = (bounds[3] as number) - (bounds[0] as number);
  expect(width).toBeCloseTo(OPTIONS.radius * 2 * 2 ** (OPTIONS.cascades - 1), 4);
  const outerStep = width / (OPTIONS.resolution - 1);
  const centre = ((bounds[0] as number) + (bounds[3] as number)) / 2;
  expect(centre / outerStep).toBeCloseTo(Math.round(centre / outerStep), 5);
  expect(Math.abs(centre - 5)).toBeLessThanOrEqual(outerStep / 2 + 1e-4);
});

test('THE BOUNDS A READER SEES MOVE WITH THE FIELD THEY DESCRIBE, not a frame ahead of it', () => {
  /*
   * **A reader encoded before the composition reads last frame's field, and it has to read last
   * frame's bounds with it.** The field pass marches in `prepare`, at `beginFrame`, and the
   * renderer composes at `endFrame` — so the march is earlier in the command buffer than the
   * dispatches that rewrite the samples, and reads the samples the previous frame composed. The
   * bounds were written with `queue.writeBuffer`, which lands when it is made rather than when the
   * command buffer runs: so on every frame a cascade stepped, the march read the previous frame's
   * field through this frame's bounds, and the whole field sat one voxel off — 16.7 cm at the
   * finest cascade and 67 cm at the coarsest — for exactly one frame. At 120 frames a second a
   * camera moving through "The world as one distance field" showed every object with a clone that
   * popped in and out beside it. A held capture could never see it: a held frame redraws until the
   * two agree.
   *
   * So the new bounds go to a staging buffer, and reach the one readers bind by a copy encoded
   * straight after the composition: before it a reader sees the old pair, after it the new one.
   */
  const gpu = recordingDevice();
  const composer = new FieldComposer(gpu.device, OPTIONS);
  const scene = new DistanceFieldScene();
  scene.record(sphere(4), at(0));

  composer.compose(gpu.encoder, scene, [0, 0, 0]);
  gpu.submit();
  const readers = composer.field?.cascades as unknown as StubBuffer;
  const before = Array.from(new Float32Array(readers.bytes.buffer.slice(0)));

  /* A step: the eye moves further than any cascade's step, so every cascade moves. */
  composer.compose(gpu.encoder, scene, [9, 0, 0]);
  /* Recorded but not yet run: where a reader encoded ahead of this composition stands. */
  expect(Array.from(new Float32Array(readers.bytes.buffer.slice(0)))).toEqual(before);
  gpu.submit();
  const after = Array.from(new Float32Array(readers.bytes.buffer.slice(0)));
  expect(after).not.toEqual(before);

  /* And the copy is in the stream after the composition's pass, not before it. */
  const copy = gpu.commands.lastIndexOf('copy:gi-field cascades, staged->gi-field cascades');
  expect(copy).toBeGreaterThan(gpu.commands.lastIndexOf('end'));
  expect(gpu.writes.filter((write) => write.label === 'gi-field cascades')).toEqual([]);
});
