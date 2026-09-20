import { expect, test, vi } from 'vitest';

import { DEPTH_COMPARE_EQUAL } from '../../depthConvention.ts';
import { CULL_CONES, CULL_SETTINGS_FLOATS } from '../../shaders/gpudriven/cull.wgsl.ts';
import { FRUSTUM_FLOATS, frustumPlanes } from '../../gpudriven/frustum.ts';
import {
  SHADOW_LOOKUP_CORRECTION,
  SHADOW_RASTER_CORRECTION,
  SHADOW_CULL_CORRECTION,
  correctShadowMatrix,
  fitShadow,
  lightConeEye,
} from '../../gpudriven/shadowCamera.ts';
import type { ClusterSource } from '../../gpudriven/clusterUpload.ts';
import { GPU_DRIVEN_VERTEX_FLOATS } from '../../gpudriven/sceneUpload.ts';
import { StreamingScene, streamingScene } from '../../gpudriven/streamScene.ts';

import type { StreamHandle } from '../../gpudriven/streamScene.ts';

import type { GpuDrivenMesh } from '../../gpudriven/sceneUpload.ts';
import type { PassDevice, PrepareContext } from '../../pass.ts';
import {
  GPU_DRIVEN_LISTS,
  GpuDrivenPass,
  type GpuDrivenMaterial,
  type GpuDrivenShadowOptions,
  type GpuDrivenView,
} from './gpuDrivenPass.ts';

/**
 * A buffer the stub hands out, which keeps what the queue wrote into it.
 *
 * **What a dispatch reads is what the queue left there before the frame was submitted.** A
 * `queue.writeBuffer` takes effect when it is called, and the command buffer the frame is being
 * recorded into executes later, at `submit` — so two writes to one buffer either side of a
 * dispatch are both done before the dispatch runs, and it reads the second. That is the property
 * these tests lean on, and the one the pass once forgot.
 */
interface StubBuffer {
  readonly label: string;
  readonly bytes: Uint8Array;
  /** What it was made for, which a device validates and this stub otherwise would not. */
  readonly usage: number;
}

interface StubGroup {
  readonly label: string;
  readonly entries: readonly GPUBindGroupEntry[];
  /** Which group this was, counting from the first the device made. */
  readonly serial: number;
}

interface Command {
  readonly op: string;
  readonly args: readonly unknown[];
}

/**
 * A device and an encoder with no GPU behind them, which log what they were asked to do.
 *
 * Every encoder and pass call lands in `commands` in recording order, so a test can read the frame
 * back the way the device would execute it. Everything else answers with just enough of an object
 * for the pass to carry on.
 */
function recordingDevice() {
  const commands: Command[] = [];
  const pipelines: Record<string, unknown>[] = [];
  let groups = 0;
  const texture = (descriptor: GPUTextureDescriptor) => {
    const made = {
      label: descriptor.label ?? '',
      createView: () => ({ label: descriptor.label ?? '' }),
      destroy: () => undefined,
    };
    return made;
  };
  /*
   * **Descriptors are kept beside the commands rather than in them.** A pipeline's depth state is
   * state and not a command, so a test that reads only the encoder log cannot see it — which is how
   * two perturbations of exactly that state passed. They go in their own list so the fixed frame,
   * which is a recording of what the encoder was asked to do, still means that.
   */
  const pipeline = (descriptor: { label?: string }) => {
    pipelines.push(descriptor as Record<string, unknown>);
    return {
      label: descriptor.label ?? '',
      getBindGroupLayout: (group: number) => ({ label: `${descriptor.label ?? ''} ${group}` }),
    };
  };
  const buffers: (StubBuffer & { destroyed: boolean; destroy(): void })[] = [];
  const writes: { label: string; offset: number; bytes: number }[] = [];
  const device = {
    features: new Set<string>(),
    limits: {},
    queue: {
      writeBuffer(
        buffer: StubBuffer,
        offset: number,
        data: ArrayBufferView,
        dataOffset?: number,
        size?: number,
      ): void {
        /* The four-argument form is what a streamed upload uses: a window of a bigger array. */
        const element = (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
        const from = data.byteOffset + (dataOffset ?? 0) * element;
        const bytes =
          size === undefined ? data.byteLength - (dataOffset ?? 0) * element : size * element;
        buffer.bytes.set(new Uint8Array(data.buffer, from, bytes), offset);
        writes.push({ label: buffer.label, offset, bytes });
      },
      writeTexture: () => undefined,
      submit: () => undefined,
    },
    createBuffer: (
      descriptor: GPUBufferDescriptor,
    ): StubBuffer & { destroyed: boolean; destroy(): void } => {
      const made = {
        label: descriptor.label ?? '',
        bytes: new Uint8Array(descriptor.size),
        usage: descriptor.usage,
        destroyed: false,
        destroy: () => {
          made.destroyed = true;
        },
        /* A map that settles at once, onto whatever the buffer holds — which a test puts there. */
        mapAsync: () => Promise.resolve(),
        getMappedRange: () => made.bytes.buffer,
        unmap: () => undefined,
      };
      /* Kept, so a test can ask what size a buffer was made at rather than only what was written. */
      buffers.push(made);
      return made;
    },
    createTexture: texture,
    createSampler: (descriptor?: GPUSamplerDescriptor) => ({ label: descriptor?.label ?? '' }),
    createShaderModule: (descriptor: GPUShaderModuleDescriptor) => ({
      label: descriptor.label ?? '',
    }),
    createComputePipeline: pipeline,
    createRenderPipeline: pipeline,
    createBindGroup: (descriptor: GPUBindGroupDescriptor): StubGroup => ({
      label: descriptor.label ?? '',
      entries: [...descriptor.entries],
      serial: groups++,
    }),
  };
  const logging = (prefix: string): unknown =>
    new Proxy(
      {},
      {
        get:
          (_target, name) =>
          (...args: unknown[]) => {
            const op = `${prefix}${String(name)}`;
            commands.push({ op, args });
            if (op === 'beginComputePass') return logging('compute.');
            if (op === 'beginRenderPass') return logging('render.');
            return undefined;
          },
      },
    );
  const encoder = logging('') as GPUCommandEncoder;
  return { device: device as unknown as GPUDevice, encoder, commands, pipelines, buffers, writes };
}

/** One triangle in one cluster, which is all a frame needs to issue every dispatch it has. */
function oneTriangleMeshes(): GpuDrivenMesh[] {
  const source: ClusterSource = {
    count: 1,
    triangleOffsets: new Uint32Array([0]),
    triangleCounts: new Uint32Array([1]),
    boundsCentre: new Float32Array(3),
    boundsRadius: new Float32Array([1]),
    coneAxis: new Float32Array(3),
    coneCutoff: new Float32Array([-1]),
    ownError: new Float32Array(1),
    parentError: new Float32Array([Infinity]),
    indices: new Uint32Array([0, 1, 2]),
  };
  return [
    {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      colours: new Float32Array(9).fill(1),
      clusters: source,
      material: 0,
    },
  ];
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** The jitter of a frame that is not reconstructed. */
const NO_JITTER = new Float32Array(2);

const VIEW: GpuDrivenView = {
  viewProj: IDENTITY,
  eye: [0, 0, 3],
  lightDir: [0, -1, 0],
  lightColour: [1, 1, 1],
  ambient: [0.2, 0.2, 0.2],
  ambientGround: [0.1, 0.1, 0.1],
  lodThreshold: 1,
  fovY: 1,
};

/** A pass that has been mounted, sized and given a view, and one frame of it recorded. */
function recordedFrame(
  view: GpuDrivenView = VIEW,
  materials: readonly GpuDrivenMaterial[] = [
    { tint: [1, 1, 1], emissive: 0 },
    { tint: [1, 0, 0], emissive: 1 },
  ],
) {
  const { device, encoder, commands } = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), materials);
  const mounted: PassDevice = {
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  };
  pass.init(mounted);
  pass.resize(100, 40);
  pass.setView(view);
  const frame: PrepareContext = {
    backend: 'webgpu',
    encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  };
  pass.prepare(frame);
  return commands;
}

/**
 * The same frame, and then the presentation.
 *
 * **A contributed pass fills its own target in `prepare` and puts it on screen in `draw`**, at the
 * point the caller invoked `drawPass` — so the fixed frame above, recorded from `prepare` alone,
 * holds every dispatch and no presentation at all. That is what it means and it stays that way;
 * the blit gets its own recording rather than being folded into it.
 */
function recordedPresent(shadow: GpuDrivenShadowOptions = {}) {
  const { device, encoder, commands, pipelines } = recordingDevice();
  const pass = new GpuDrivenPass(
    streamingScene(oneTriangleMeshes(), IDENTITY),
    [{ tint: [1, 1, 1], emissive: 0 }],
    shadow,
  );
  pass.init({
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });
  pass.resize(100, 40);
  pass.setView(VIEW);
  pass.prepare({
    backend: 'webgpu',
    encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  });
  pass.draw({
    backend: 'webgpu',
    pass: encoder as unknown as GPURenderPassEncoder,
    outputTransform: 0,
    outputExposure: 1,
    jitter: NO_JITTER,
  });
  const blit = pipelines.find((one) => String(one['label']).startsWith('gpu-driven blit'));
  return {
    commands,
    blit: blit as {
      label: string;
      depthStencil: GPUDepthStencilState;
      fragment: GPUFragmentState;
    },
  };
}

/**
 * The bind group each dispatch of the named pipeline ran with, at `group`, in recording order.
 *
 * Walks the log as a device would: `setPipeline` and `setBindGroup` are state that persists
 * within one pass until changed, and a new pass starts with none.
 */
/** The compute pass the light's own cut, cull and compaction run in, ahead of its map. */
const SHADOW_CULL = 'gpu-driven shadow cull';
/** And the one its pyramid and its second half run in, between the map's two draws. */
const SHADOW_OCCLUSION = 'gpu-driven shadow occlusion';

/**
 * The groups bound at every dispatch of one pipeline, in order.
 *
 * **The camera's by default and the light's on request**, because the shadow runs the same three
 * front-half pipelines over its own buffers: a test about the camera's cut that took the first
 * `lod cut` it met would be reading the light's, which binds different flags on purpose.
 */
function groupsAtDispatch(
  commands: readonly Command[],
  pipeline: string,
  group: number,
  among: 'camera' | 'light' = 'camera',
) {
  const found: StubGroup[] = [];
  let current = '';
  let light = false;
  let bound = new Map<number, StubGroup>();
  for (const command of commands) {
    if (command.op === 'beginComputePass') {
      current = '';
      const label = (command.args[0] as { label?: string }).label;
      light = label === SHADOW_CULL || label === SHADOW_OCCLUSION;
      bound = new Map();
    } else if (command.op === 'compute.setPipeline') {
      current = (command.args[0] as { label: string }).label;
    } else if (command.op === 'compute.setBindGroup') {
      bound.set(command.args[0] as number, command.args[1] as StubGroup);
    } else if (
      command.op.startsWith('compute.dispatchWorkgroups') &&
      current === pipeline &&
      light === (among === 'light')
    ) {
      const at = bound.get(group);
      if (at !== undefined) found.push(at);
    }
  }
  return found;
}

function bufferAt(group: StubGroup, binding: number): StubBuffer {
  const entry = group.entries.find((candidate) => candidate.binding === binding);
  if (entry === undefined) throw new Error(`${group.label} binds nothing at ${binding}`);
  return (entry.resource as unknown as { buffer: StubBuffer }).buffer;
}

/*
 * **Phase one judges what was visible last frame without the pyramid**, because the pyramid it
 * would test against is last frame's, seen from last frame's camera. A cluster that stale pyramid
 * wrongly hides is not drawn by phase one — and phase two judges only what the history does *not*
 * hold, so it is not drawn by phase two either, and can vanish for a frame while the camera moves.
 *
 * The pass meant this: it wrote the flag as 0 for phase one and as 1 before phase two. But both
 * writes went to the same buffer through the queue, and both land before the frame is submitted,
 * so phase one read the 1.
 */
test('phase one culls with the pyramid switched off and phase two with it on', () => {
  const commands = recordedFrame();
  const culls = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0);
  expect(culls).toHaveLength(2);
  const hasPyramid = (group: StubGroup) =>
    new Float32Array(bufferAt(group, 2).bytes.buffer, 0, 8)[3];
  expect(hasPyramid(culls[0] as StubGroup)).toBe(0);
  expect(hasPyramid(culls[1] as StubGroup)).toBe(1);
});

test('both phases read the same eye and the same pyramid shape', () => {
  const commands = recordedFrame();
  const [one, two] = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0);
  const settings = (group: StubGroup | undefined) =>
    Array.from(new Float32Array(bufferAt(group as StubGroup, 2).bytes.buffer, 0, 8));
  const first = settings(one);
  const second = settings(two);
  expect(first.slice(0, 3)).toEqual([0, 0, 3]);
  expect([...first.slice(0, 3), ...first.slice(4)]).toEqual([
    ...second.slice(0, 3),
    ...second.slice(4),
  ]);
  /*
   * Not square, so a width and a height the wrong way round are caught. The width is the one the
   * raster drew, not the row padded to 64's multiple, and a pyramid over 100 by 40 has seven
   * levels: 100, 50, 25, 12, 6, 3, 1.
   */
  expect(first.slice(4)).toEqual([100, 40, 7, 1]);
});

/**
 * One command as a line of text, with every object named by what it is rather than where it lives.
 *
 * A bind group has no label, so it is named by the order it was first bound in; a buffer, a
 * pipeline or a view by its label; a pass descriptor by its label and what it does to its
 * attachments. Two frames whose lines are equal issue the same commands against the same objects
 * in the same order, which is what "the same passes in the same order" has to mean on a device.
 */
function frameText(commands: readonly Command[]): string[] {
  const name = (value: unknown): string => {
    if (typeof value === 'number') return String(value);
    if (value === undefined || value === null) return String(value);
    if (typeof value !== 'object') return JSON.stringify(value);
    const record = value as Record<string, unknown>;
    if ('entries' in record) return `group${String(record['serial'])}`;
    if ('colorAttachments' in record || 'timestampWrites' in record) {
      const colour =
        (record['colorAttachments'] as Array<Record<string, unknown>> | undefined) ?? [];
      const depth = record['depthStencilAttachment'] as Record<string, unknown> | undefined;
      const ops = [
        ...colour.map((a) => `colour ${String(a['loadOp'])}`),
        ...(depth === undefined
          ? []
          : /* A read-only attachment carries no load op, and saying "undefined" hides which it is. */
            [
              depth['depthReadOnly'] === true
                ? 'depth read-only'
                : `depth ${String(depth['depthLoadOp'])}`,
            ]),
      ];
      return `{${String(record['label'])}${ops.length === 0 ? '' : `: ${ops.join(', ')}`}}`;
    }
    if ('texture' in record) return `texture(${name(record['texture'])})`;
    if ('buffer' in record) return `buffer(${name(record['buffer'])})`;
    if ('label' in record) return String(record['label']);
    if ('width' in record) return `${String(record['width'])}x${String(record['height'])}`;
    return '?';
  };
  return commands.map((command) => `${command.op}(${command.args.map(name).join(', ')})`);
}

/**
 * **The frame the pass encoded before the graph scheduled it**, taken from the fixed-order encoder on
 * 2026-09-17 with this file's one triangle, two materials and a 100 by 40 frame. It is the claim
 * Wave 1A's twelfth task makes — the same passes in the same order — in the only form a test can
 * hold it: every command, every object it names, in sequence.
 *
 * **The same day it gained the instance cull**, `wave2a`'s fifth task: one compute pass after the
 * map and before the cut, and one bind group made after the cut's, which moves every group made
 * after it up by one. Nothing else in the frame changed.
 *
 * **And on 2026-09-18 it gained a transparent half and still did not change.** Twenty-one of these
 * eighty-eight lines moved and every one of them moved by a bind group's serial number — the cut's
 * second group and the blended compaction's are made before the rest — while the passes, their
 * order, their attachments and every dispatch stayed exactly as they were. That is the claim in
 * the strongest form available: a scene with no blended material encodes the frame it encoded
 * before transparency existed, command for command.
 *
 * **The same day the map stopped drawing every slot**, and that one is a change to the frame rather
 * than a renumbering: the shadow stage clears its draw block, runs the front half's three pipelines
 * over the light's own buffers and draws what they listed indirectly, seventeen lines where it was
 * five. Every other line moved by a bind group's serial only — two for the light's cut and
 * compaction, made beside the blended half's, and three past the light's cull, made with the
 * sized groups — and every old serial maps to exactly one new one, in order.
 *
 * **And the same day again, the map was drawn in the frame's two halves**, fifty-six lines where
 * it was seventeen: the light's history cleared beside its two draw blocks, phase one's cull and
 * compaction and its draw, then a pyramid of that depth — a seed and ten reductions over half a
 * 2048 map — phase two's cull and compaction against it, and a second draw over the first. The
 * other eighty-three lines moved by a bind group's serial only, the light's groups now being made
 * with the static ones, and every old serial maps to exactly one new one, in order.
 */
const FIXED_FRAME: readonly string[] = [
  'clearBuffer(gpu-driven draw one, 4, 4)',
  'clearBuffer(gpu-driven draw two, 4, 4)',
  'clearBuffer(gpu-driven history b)',
  'clearBuffer(gpu-driven bin counts)',
  'beginRenderPass({gpu-driven clear colour: colour clear})',
  'render.end()',
  'clearBuffer(gpu-driven draw shadow, 4, 4)',
  'clearBuffer(gpu-driven draw shadow two, 4, 4)',
  'clearBuffer(gpu-driven shadow history b)',
  'beginComputePass({gpu-driven shadow cull})',
  'compute.setPipeline(gpu-driven lod cut)',
  'compute.setBindGroup(0, group4)',
  'compute.dispatchWorkgroups(1)',
  'compute.setPipeline(gpu-driven cull clusters)',
  'compute.setBindGroup(0, group9)',
  'compute.dispatchWorkgroups(1)',
  'compute.setPipeline(gpu-driven compact)',
  'compute.setBindGroup(0, group5)',
  'compute.dispatchWorkgroups(1)',
  'compute.end()',
  'beginRenderPass({gpu-driven shadow: depth clear})',
  'render.setPipeline(gpu-driven shadow)',
  'render.setBindGroup(0, group0)',
  'render.drawIndirect(gpu-driven draw shadow, 0)',
  'render.end()',
  'beginComputePass(gpu-driven shadow occlusion)',
  'compute.setPipeline(gpu-driven shadow hzb seed)',
  'compute.setBindGroup(0, group11)',
  'compute.dispatchWorkgroups(128, 128)',
  'compute.setPipeline(gpu-driven hzb reduce)',
  'compute.setBindGroup(0, group12)',
  'compute.dispatchWorkgroups(64, 64)',
  'compute.setBindGroup(0, group13)',
  'compute.dispatchWorkgroups(32, 32)',
  'compute.setBindGroup(0, group14)',
  'compute.dispatchWorkgroups(16, 16)',
  'compute.setBindGroup(0, group15)',
  'compute.dispatchWorkgroups(8, 8)',
  'compute.setBindGroup(0, group16)',
  'compute.dispatchWorkgroups(4, 4)',
  'compute.setBindGroup(0, group17)',
  'compute.dispatchWorkgroups(2, 2)',
  'compute.setBindGroup(0, group18)',
  'compute.dispatchWorkgroups(1, 1)',
  'compute.setBindGroup(0, group19)',
  'compute.dispatchWorkgroups(1, 1)',
  'compute.setBindGroup(0, group20)',
  'compute.dispatchWorkgroups(1, 1)',
  'compute.setBindGroup(0, group21)',
  'compute.dispatchWorkgroups(1, 1)',
  'compute.setPipeline(gpu-driven cull clusters)',
  'compute.setBindGroup(0, group10)',
  'compute.dispatchWorkgroups(1)',
  'compute.setPipeline(gpu-driven compact)',
  'compute.setBindGroup(0, group6)',
  'compute.dispatchWorkgroups(1)',
  'compute.end()',
  'beginRenderPass({gpu-driven shadow, phase 2: depth load})',
  'render.setPipeline(gpu-driven shadow)',
  'render.setBindGroup(0, group1)',
  'render.drawIndirect(gpu-driven draw shadow two, 0)',
  'render.end()',
  'beginComputePass({gpu-driven instance cull})',
  'compute.setPipeline(gpu-driven cull instances)',
  'compute.setBindGroup(0, group23)',
  'compute.dispatchWorkgroups(1)',
  'compute.end()',
  'beginComputePass({gpu-driven cut and phase one cull})',
  'compute.setPipeline(gpu-driven lod cut)',
  'compute.setBindGroup(0, group2)',
  'compute.dispatchWorkgroups(1)',
  'compute.setPipeline(gpu-driven cull clusters)',
  'compute.setBindGroup(0, group30)',
  'compute.dispatchWorkgroups(1)',
  'compute.setPipeline(gpu-driven compact)',
  'compute.setBindGroup(0, group26)',
  'compute.dispatchWorkgroups(1)',
  'compute.end()',
  'beginRenderPass({gpu-driven phase 1: colour clear, depth clear})',
  'render.setPipeline(gpu-driven visbuffer)',
  'render.setBindGroup(0, group28)',
  'render.setViewport(0, 0, 100, 40, 0, 1)',
  'render.drawIndirect(gpu-driven draw one, 0)',
  'render.end()',
  'beginComputePass({gpu-driven depth pyramid})',
  'compute.setPipeline(gpu-driven hzb seed)',
  'compute.setBindGroup(0, group33)',
  'compute.dispatchWorkgroups(13, 5)',
  'compute.setPipeline(gpu-driven hzb reduce)',
  'compute.setBindGroup(0, group34)',
  'compute.dispatchWorkgroups(7, 3)',
  'compute.setBindGroup(0, group35)',
  'compute.dispatchWorkgroups(4, 2)',
  'compute.setBindGroup(0, group36)',
  'compute.dispatchWorkgroups(2, 1)',
  'compute.setBindGroup(0, group37)',
  'compute.dispatchWorkgroups(1, 1)',
  'compute.setBindGroup(0, group38)',
  'compute.dispatchWorkgroups(1, 1)',
  'compute.setBindGroup(0, group39)',
  'compute.dispatchWorkgroups(1, 1)',
  'compute.end()',
  'beginComputePass({gpu-driven phase two cull})',
  'compute.setPipeline(gpu-driven cull clusters)',
  'compute.setBindGroup(0, group31)',
  'compute.dispatchWorkgroups(1)',
  'compute.setPipeline(gpu-driven compact)',
  'compute.setBindGroup(0, group27)',
  'compute.dispatchWorkgroups(1)',
  'compute.end()',
  'beginRenderPass({gpu-driven phase 2: colour load, depth load})',
  'render.setPipeline(gpu-driven visbuffer)',
  'render.setBindGroup(0, group29)',
  'render.setViewport(0, 0, 100, 40, 0, 1)',
  'render.drawIndirect(gpu-driven draw two, 0)',
  'render.end()',
  'copyTextureToBuffer(texture(gpu-driven visibility), buffer(gpu-driven visibility), 128x40)',
  'beginComputePass({gpu-driven material bins})',
  'compute.setPipeline(gpu-driven bin count)',
  'compute.setBindGroup(0, group40)',
  'compute.dispatchWorkgroups(80)',
  'compute.setPipeline(gpu-driven bin offsets)',
  'compute.setBindGroup(0, group41)',
  'compute.dispatchWorkgroups(1)',
  'compute.end()',
  'copyBufferToBuffer(gpu-driven bin offsets, 0, gpu-driven bin cursors, 0, 8)',
  'beginComputePass({gpu-driven scatter and shade})',
  'compute.setPipeline(gpu-driven bin scatter)',
  'compute.setBindGroup(0, group42)',
  'compute.dispatchWorkgroups(80)',
  'compute.setPipeline(gpu-driven shade)',
  'compute.setBindGroup(0, group43)',
  'compute.setBindGroup(1, group24)',
  'compute.dispatchWorkgroupsIndirect(gpu-driven bin dispatch, 0)',
  'compute.setBindGroup(1, group25)',
  'compute.dispatchWorkgroupsIndirect(gpu-driven bin dispatch, 12)',
  'compute.end()',
];

/**
 * The fifty-six commands the directional map costs — the light's two halves and its pyramid — which
 * is what an unshadowed frame does not issue.
 */
const SHADOW_AT = FIXED_FRAME.indexOf('clearBuffer(gpu-driven draw shadow, 4, 4)');
const SHADOW_STAGE = 56;
const SHADOW_PASS = FIXED_FRAME.slice(SHADOW_AT, SHADOW_AT + SHADOW_STAGE);

test('A SCHEDULED FRAME ENCODES THE FIXED FRAME, command for command', () => {
  expect(frameText(recordedFrame())).toEqual(FIXED_FRAME);
});

test('AN UNSHADOWED FRAME DRAWS NO MAP, and every other command is the same', () => {
  expect(SHADOW_PASS[0]).toBe('clearBuffer(gpu-driven draw shadow, 4, 4)');
  expect(SHADOW_PASS.slice(-5)).toEqual([
    'beginRenderPass({gpu-driven shadow, phase 2: depth load})',
    'render.setPipeline(gpu-driven shadow)',
    'render.setBindGroup(0, group1)',
    'render.drawIndirect(gpu-driven draw shadow two, 0)',
    'render.end()',
  ]);
  /* By position: `render.end()` closes every render pass, so a filter by text would take them all. */
  const unshadowed = [
    ...FIXED_FRAME.slice(0, SHADOW_AT),
    ...FIXED_FRAME.slice(SHADOW_AT + SHADOW_STAGE),
  ];
  expect(unshadowed).toHaveLength(FIXED_FRAME.length - SHADOW_STAGE);
  expect(frameText(recordedFrame({ ...VIEW, shadowStrength: 0 }))).toEqual(unshadowed);
});

test('a frame whose shadow is faint but not gone still draws the map', () => {
  expect(frameText(recordedFrame({ ...VIEW, shadowStrength: 0.01 }))).toEqual(FIXED_FRAME);
});

/*
 * **The test is the shader's, negated, and not its opposite.** The lookup returns early where the
 * strength is `<= 0`, which a NaN is not — so the shader reads the map, and a pass that asked
 * `> 0` instead would cull a map something is about to sample.
 */
test('a strength that is not a number draws the map, because the shader reads it', () => {
  expect(frameText(recordedFrame({ ...VIEW, shadowStrength: Number.NaN }))).toEqual(FIXED_FRAME);
});

/*
 * **The map used to be every cluster slot the scene had room for.** `draw(384, capacity)` over an
 * identity list: live or not, culled or not, at every level of detail at once. The voxel sandbox's
 * port measured it at 2.10 ms of shadow at radius 6 and 9.04 at radius 14 — a cost that grew with
 * the memory budget rather than with anything the light could see. It is the front half's three
 * stages run a fourth time now, against the light, into a list of its own, drawn indirectly.
 */
test('THE MAP IS DRAWN IN TWO HALVES, as the frame is, with a pyramid of the first between them', () => {
  /*
   * **The light's own occlusion, which a low sun is where it pays.** A three-degree sun over a city
   * sees a strip of it a kilometre deep, and every building behind the first row toward the sun is
   * in that row's shadow: the frustum and the cones kept 27,913 clusters there and drew all of
   * them. So the light runs the camera's two phases over buffers of its own — phase one what it
   * kept last frame, a pyramid of what that drew, phase two the rest against it — and draws each
   * half indirectly into one map.
   */
  const text = frameText(recordedFrame()).map((line) => line.replace(/group\d+/g, 'group'));
  const at = text.indexOf(`beginComputePass({${SHADOW_CULL}})`);
  expect(at).toBeGreaterThan(0);
  /* A 2048 map's pyramid starts at 1024 and has eleven levels, ten of them reduced. */
  const reduce: string[] = [];
  for (let edge = 512; edge >= 1; edge >>= 1) {
    const groups = Math.ceil(edge / 8);
    reduce.push(
      'compute.setBindGroup(0, group)',
      `compute.dispatchWorkgroups(${groups}, ${groups})`,
    );
  }
  const expected = [
    /* The two words the compactions count in, and the half of the history this frame writes. */
    'clearBuffer(gpu-driven draw shadow, 4, 4)',
    'clearBuffer(gpu-driven draw shadow two, 4, 4)',
    'clearBuffer(gpu-driven shadow history b)',
    `beginComputePass({${SHADOW_CULL}})`,
    'compute.setPipeline(gpu-driven lod cut)',
    'compute.setBindGroup(0, group)',
    'compute.dispatchWorkgroups(1)',
    'compute.setPipeline(gpu-driven cull clusters)',
    'compute.setBindGroup(0, group)',
    'compute.dispatchWorkgroups(1)',
    'compute.setPipeline(gpu-driven compact)',
    'compute.setBindGroup(0, group)',
    'compute.dispatchWorkgroups(1)',
    'compute.end()',
    'beginRenderPass({gpu-driven shadow: depth clear})',
    'render.setPipeline(gpu-driven shadow)',
    'render.setBindGroup(0, group)',
    'render.drawIndirect(gpu-driven draw shadow, 0)',
    'render.end()',
    /* No braces: it writes no time, because the stage is timed from its first pass to its last. */
    `beginComputePass(${SHADOW_OCCLUSION})`,
    'compute.setPipeline(gpu-driven shadow hzb seed)',
    'compute.setBindGroup(0, group)',
    'compute.dispatchWorkgroups(128, 128)',
    'compute.setPipeline(gpu-driven hzb reduce)',
    ...reduce,
    'compute.setPipeline(gpu-driven cull clusters)',
    'compute.setBindGroup(0, group)',
    'compute.dispatchWorkgroups(1)',
    'compute.setPipeline(gpu-driven compact)',
    'compute.setBindGroup(0, group)',
    'compute.dispatchWorkgroups(1)',
    'compute.end()',
    'beginRenderPass({gpu-driven shadow, phase 2: depth load})',
    'render.setPipeline(gpu-driven shadow)',
    'render.setBindGroup(0, group)',
    'render.drawIndirect(gpu-driven draw shadow two, 0)',
    'render.end()',
    /* And the camera's front half after it, as before. */
    'beginComputePass({gpu-driven instance cull})',
  ];
  expect(text.slice(at - 3, at - 3 + expected.length)).toEqual(expected);
  expect(text.filter((line) => line.startsWith('render.draw('))).toEqual([]);
});

test('THE LIGHT\u2019S SECOND HALF CULLS AGAINST ITS OWN PYRAMID, through the raster\u2019s matrix turned over', () => {
  const commands = recordedFrame();
  const [one, two] = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0, 'light');
  const [seed] = groupsAtDispatch(commands, 'gpu-driven shadow hzb seed', 0, 'light');
  const [, compactTwo] = groupsAtDispatch(commands, 'gpu-driven compact', 0, 'light');
  for (const group of [one, two, seed, compactTwo]) expect(group).toBeDefined();
  const settings = (group: StubGroup | undefined) =>
    Array.from(
      new Float32Array(bufferAt(group as StubGroup, 2).bytes.buffer, 0, CULL_SETTINGS_FLOATS),
    );
  const first = settings(one);
  const second = settings(two);
  /* The pyramid only in the second half; its shape, the cones and the count in both. */
  expect(first[3]).toBe(0);
  expect(second[3]).toBe(1);
  for (const values of [first, second]) {
    expect(values.slice(4, 8)).toEqual([1024, 1024, 11, 1]);
    expect(values[CULL_CONES]).toBe(1);
  }
  /* The light's pyramid and its table of levels, not the camera's. */
  const pyramid = bufferAt(seed as StubGroup, 2);
  expect(pyramid.label).toBe('gpu-driven shadow pyramid');
  for (const group of [one, two]) {
    expect(bufferAt(group as StubGroup, 4)).toBe(pyramid);
    expect(bufferAt(group as StubGroup, 5).label).toBe('gpu-driven shadow level starts');
    expect(bufferAt(group as StubGroup, 0).label).toBe('gpu-driven shadow planes');
  }
  /* Seeded from the map at its whole size. */
  expect(Array.from(new Uint32Array(bufferAt(seed as StubGroup, 0).bytes.buffer, 0, 2))).toEqual([
    2048, 2048,
  ]);
  const view = (seed as StubGroup).entries.find((entry) => entry.binding === 1);
  expect(view).toBeDefined();
  expect(((view as GPUBindGroupEntry).resource as { label?: string }).label).toBe(
    'gpu-driven shadow',
  );

  /* Projected through the raster's matrix with its depth turned over, as the pyramid is stored. */
  const sphere = new Float32Array(4);
  streamingScene(oneTriangleMeshes(), IDENTITY).sceneBounds(sphere);
  const light = new Float32Array(16);
  fitShadow(sphere, VIEW.eye, undefined, VIEW.lightDir, 2048, light);
  const raster = correctShadowMatrix(SHADOW_RASTER_CORRECTION, light, new Float32Array(16));
  const cull = correctShadowMatrix(SHADOW_CULL_CORRECTION, raster, new Float32Array(16));
  const matrix = bufferAt(two as StubGroup, 1);
  expect(matrix.label).toBe('gpu-driven shadow cull matrix');
  expect(Array.from(new Float32Array(matrix.bytes.buffer, 0, 16))).toEqual(Array.from(cull));

  /* The second half's compaction: phase two, the light's history read and the other half written. */
  expect(
    Array.from(new Uint32Array(bufferAt(compactTwo as StubGroup, 0).bytes.buffer, 0, 2)),
  ).toEqual([1, 1]);
  expect(bufferAt(compactTwo as StubGroup, 3).label).toBe('gpu-driven shadow history a');
  expect(bufferAt(compactTwo as StubGroup, 5).label).toBe('gpu-driven shadow history b');
  expect(bufferAt(compactTwo as StubGroup, 4).label).toBe('gpu-driven shadow list two');
  expect(bufferAt(compactTwo as StubGroup, 6).label).toBe('gpu-driven draw shadow two');
});

test('THE LIGHT\u2019S HISTORY SWAPS ON A FRAME THAT DRAWS THE MAP, and on no other', () => {
  const { device, encoder, commands } = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
    { tint: [1, 1, 1], emissive: 0 },
  ]);
  pass.init({
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });
  pass.resize(100, 40);
  const read = (view: GpuDrivenView) => {
    commands.length = 0;
    pass.setView(view);
    pass.prepare({
      backend: 'webgpu',
      encoder,
      environment: null,
      distanceField: null,
      jitter: NO_JITTER,
    });
    const [compact] = groupsAtDispatch(commands, 'gpu-driven compact', 0, 'light');
    return compact === undefined ? null : bufferAt(compact, 3).label;
  };
  expect(read(VIEW)).toBe('gpu-driven shadow history a');
  expect(read(VIEW)).toBe('gpu-driven shadow history b');
  /* An unshadowed frame draws no map and writes no history, so the next reads what the last wrote. */
  expect(read({ ...VIEW, shadowStrength: 0 })).toBeNull();
  expect(read(VIEW)).toBe('gpu-driven shadow history a');
});

test('THE LIGHT\u2019S CUT HIDES NO MESH, and every buffer it writes is its own', () => {
  /*
   * **The camera's instance flags would drop exactly the casters a low sun needs.** A tree behind
   * the viewer is outside the camera's view and still shadows the path in front of them, so the
   * light's cut reads a buffer of zeros — nothing hidden — where the camera's reads the flags its
   * instance cull wrote. It takes the camera's level of detail, the same parameters, so a surface
   * shadows itself at the level it is drawn at rather than acne between two.
   */
  const commands = recordedFrame();
  const [cut] = groupsAtDispatch(commands, 'gpu-driven lod cut', 0, 'light');
  const [cull] = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0, 'light');
  const [compact] = groupsAtDispatch(commands, 'gpu-driven compact', 0, 'light');
  const [cameraCut] = groupsAtDispatch(commands, 'gpu-driven lod cut', 0);
  const [cameraCompact] = groupsAtDispatch(commands, 'gpu-driven compact', 0);
  for (const group of [cut, cull, compact, cameraCut, cameraCompact]) expect(group).toBeDefined();
  const light = { cut: cut as StubGroup, cull: cull as StubGroup, compact: compact as StubGroup };

  const none = bufferAt(light.cut, 4);
  expect(none.label).toBe('gpu-driven instance flags, none');
  expect([...none.bytes].every((byte) => byte === 0)).toBe(true);
  expect(bufferAt(light.cut, 0)).toBe(bufferAt(cameraCut as StubGroup, 0));

  /* Its own selection, keep and list, so neither half of the frame reads what the other wrote. */
  const selected = bufferAt(light.cut, 2);
  expect(selected.label).toBe('gpu-driven shadow selected');
  expect(bufferAt(light.cull, 7)).toBe(selected);
  expect(bufferAt(light.cull, 6).label).toBe('gpu-driven shadow keep');
  expect(bufferAt(light.cull, 0).label).toBe('gpu-driven shadow planes');
  expect(bufferAt(light.compact, 1)).toBe(selected);
  expect(bufferAt(light.compact, 2)).toBe(bufferAt(light.cull, 6));
  expect(bufferAt(light.compact, 4).label).toBe('gpu-driven shadow list');
  expect(bufferAt(light.compact, 6).label).toBe('gpu-driven draw shadow');

  /*
   * **Against the light's own history**, phase one of two: what the light kept last frame. Not the
   * camera's, which would put one view's visibility into the other's phase one — `twoPhase.ts`'s
   * "one history per view" — and next frame's camera history is not written by it either.
   */
  expect(bufferAt(light.compact, 3).label).toBe('gpu-driven shadow history a');
  expect(bufferAt(light.compact, 5).label).toBe('gpu-driven shadow history b');
  expect(bufferAt(light.compact, 3)).not.toBe(bufferAt(cameraCompact as StubGroup, 3));
  expect(bufferAt(light.compact, 5)).not.toBe(bufferAt(cameraCompact as StubGroup, 5));
  expect(Array.from(new Uint32Array(bufferAt(light.compact, 0).bytes.buffer, 0, 2))).toEqual([
    0, 1,
  ]);

  /* And the map's raster reads the list the compaction wrote. */
  let raster: StubGroup | undefined;
  let inMap = false;
  for (const command of commands) {
    if (command.op === 'beginRenderPass') {
      inMap = (command.args[0] as { label?: string }).label === 'gpu-driven shadow';
    } else if (inMap && command.op === 'render.setBindGroup') raster = command.args[1] as StubGroup;
  }
  expect(bufferAt(raster as StubGroup, 1)).toBe(bufferAt(light.compact, 4));
});

test('THE LIGHT\u2019S CULL IS ITS FRUSTUM AND ITS OWN SIDE OF A SURFACE, with no camera in it', () => {
  /*
   * **The camera's pyramid is the camera's depth, and the camera's cones are the camera's side of a
   * surface.** A cluster hidden from the eye behind a wall still casts, and one facing away from the
   * eye still faces the sun. What the light's cull takes is its own: its box's six planes, taken
   * from the matrix the lookup reads, and its own cones — from an eye stood toward the sun, because
   * the map's raster culls the faces turned from the light and a cluster of nothing else draws
   * nothing there. It was switched off, and in the city that was half of 46,000 clusters.
   */
  const commands = recordedFrame();
  const [cull] = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0, 'light');
  const settings = new Float32Array(
    bufferAt(cull as StubGroup, 2).bytes.buffer,
    0,
    CULL_SETTINGS_FLOATS,
  );
  expect(settings[3]).toBe(0);
  expect(settings[CULL_CONES]).toBe(1);
  expect(settings[7]).toBe(1);
  const cone = lightConeEye(VIEW.eye, VIEW.lightDir, [0, 0, 0]);
  expect([settings[0], settings[1], settings[2]]).toEqual(cone.map(Math.fround));

  const planes = new Float32Array(bufferAt(cull as StubGroup, 0).bytes.buffer, 0, FRUSTUM_FLOATS);
  /* The scene's own sphere, which for one cluster is the box round its bounds and not its bounds. */
  const sphere = new Float32Array(4);
  streamingScene(oneTriangleMeshes(), IDENTITY).sceneBounds(sphere);
  const light = new Float32Array(16);
  fitShadow(sphere, VIEW.eye, undefined, VIEW.lightDir, 2048, light);
  const lookup = correctShadowMatrix(SHADOW_LOOKUP_CORRECTION, light, new Float32Array(16));
  const expected = new Float32Array(FRUSTUM_FLOATS);
  frustumPlanes(lookup, expected);
  expect([...planes]).toEqual([...expected]);
});

test('PAST ITS FOLLOW RADIUS THE MAP FOLLOWS THE EYE, and under it the scene fit is untouched', () => {
  /*
   * Two triangles six hundred metres apart are a world to a map of radius 40, and one triangle is
   * not. The matrix the raster is handed is the fit `shadowCamera.ts` holds the properties of.
   */
  const far = new Float32Array([...IDENTITY]);
  far[12] = 600;
  /* A builder rather than a scene, because `matrixOf` mounts a pass each time and a scene goes to one. */
  const world = (): StreamingScene =>
    streamingScene(
      [...oneTriangleMeshes(), ...oneTriangleMeshes()],
      new Float32Array([...IDENTITY, ...far]),
    );
  const matrixOf = (scene: StreamingScene, followRadius?: number): number[] => {
    const { device, encoder, writes, buffers } = recordingDevice();
    const pass = new GpuDrivenPass(scene, [{ tint: [1, 1, 1], emissive: 0 }], {
      ...(followRadius === undefined ? {} : { followRadius }),
    });
    pass.init({
      backend: 'webgpu',
      device,
      format: 'rgba8unorm',
      depthFormat: 'depth32float',
      samples: 1,
      clipCorrection: IDENTITY,
      depthCorrection: IDENTITY,
      reconstruction: false,
    });
    pass.resize(100, 40);
    pass.setView(VIEW);
    pass.prepare({
      backend: 'webgpu',
      encoder,
      environment: null,
      distanceField: null,
      jitter: NO_JITTER,
    });
    expect(writes.some((write) => write.label === 'gpu-driven shadow matrix')).toBe(true);
    const matrix = buffers.find((buffer) => buffer.label === 'gpu-driven shadow matrix');
    return Array.from(new Float32Array((matrix as StubBuffer).bytes.buffer, 0, 16));
  };
  const expected = (scene: StreamingScene, follow?: number): number[] => {
    const sphere = new Float32Array(4);
    scene.sceneBounds(sphere);
    const light = new Float32Array(16);
    fitShadow(sphere, VIEW.eye, follow, VIEW.lightDir, 2048, light);
    return Array.from(correctShadowMatrix(SHADOW_RASTER_CORRECTION, light, new Float32Array(16)));
  };
  expect(matrixOf(world(), 40)).toEqual(expected(world(), 40));
  expect(matrixOf(world(), 40)).not.toEqual(expected(world()));
  /* No radius, or a scene inside it: the fit every rig was photographed with. */
  expect(matrixOf(world())).toEqual(expected(world()));
  const small = (): StreamingScene => streamingScene(oneTriangleMeshes(), IDENTITY);
  expect(matrixOf(small(), 40)).toEqual(expected(small()));
});

test('THE CUT READS THE FLAGS THE INSTANCE CULL WROTE, and the cluster cull reads the cut', () => {
  /*
   * The stage exists for the buffers it connects, so the test is that they are connected: one
   * flag buffer written by the instance cull and read by the cut, and one selection buffer
   * written by the cut and read by both phases of the cluster cull. A group that bound a fresh
   * buffer of the right size would pass every other test in this file.
   */
  const commands = recordedFrame();
  const [instances] = groupsAtDispatch(commands, 'gpu-driven cull instances', 0);
  const [cut] = groupsAtDispatch(commands, 'gpu-driven lod cut', 0);
  const culls = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0);
  expect(instances).toBeDefined();
  expect(cut).toBeDefined();
  const flags = bufferAt(instances as StubGroup, 2);
  expect(flags.label).toBe('gpu-driven instance flags');
  expect(bufferAt(cut as StubGroup, 4)).toBe(flags);
  /* The cut learns a cluster's mesh from the meta the raster already reads. */
  expect(bufferAt(cut as StubGroup, 3).label).toBe('gpu-driven cluster meta');
  expect(culls).toHaveLength(2);
  for (const cull of culls) expect(bufferAt(cull, 7)).toBe(bufferAt(cut as StubGroup, 2));
  /* And the instance cull reads the same corrected matrix the cluster cull's planes came from. */
  expect(bufferAt(instances as StubGroup, 0)).toBe(bufferAt(culls[0] as StubGroup, 1));
});

test('each mesh is uploaded as the sphere round its clusters, in the world', () => {
  /*
   * One mesh of one cluster whose sphere is the unit sphere at the origin, placed two units along
   * x and doubled: its instance is the sphere of radius two about (2, 0, 0).
   */
  const { device, encoder, commands } = recordingDevice();
  const placed = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 2, 0, 0, 1]);
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), placed), [
    { tint: [1, 1, 1], emissive: 0 },
  ]);
  pass.init({
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });
  pass.resize(100, 40);
  pass.setView(VIEW);
  pass.prepare({
    backend: 'webgpu',
    encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  });
  const [instances] = groupsAtDispatch(commands, 'gpu-driven cull instances', 0);
  const spheres = bufferAt(instances as StubGroup, 1);
  expect(spheres.label).toBe('gpu-driven instance spheres');
  expect(Array.from(new Float32Array(spheres.bytes.buffer, 0, 4))).toEqual([2, 0, 0, 2]);
  expect(bufferAt(instances as StubGroup, 2).bytes.byteLength).toBe(4);
});

test('THE PASS MAKES THE SCENE\u2019S BUFFERS AT THE CAPACITY IT DECLARED, and writes only what the scene holds', () => {
  /*
   * **What this can say and what it cannot.** It cannot say the picture is right — the captures in
   * this task's steps do that. What it says is that the six buffers reach the device at the sizes
   * and strides the shaders index them by, which is the thing that changed.
   *
   * **Sized by capacity rather than by content**, which is what makes room for a mesh that has not
   * arrived yet. A static scene declares a capacity equal to its content, so nothing moves for one.
   */
  const scene = streamingScene(oneTriangleMeshes(), IDENTITY, {
    vertices: 16,
    indices: 32,
    clusters: 4,
    meshes: 2,
  });
  const stub = recordingDevice();
  const pass = new GpuDrivenPass(scene, [{ tint: [1, 1, 1], emissive: 0 }]);
  pass.init({
    backend: 'webgpu',
    device: stub.device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });

  const vertices = stub.buffers.find((b) => b.label === 'gpu-driven vertices');
  expect(vertices?.bytes.byteLength).toBe(16 * GPU_DRIVEN_VERTEX_FLOATS * 4);
  const meta = stub.buffers.find((b) => b.label === 'gpu-driven cluster meta');
  expect(meta?.bytes.byteLength).toBe(4 * 4 * 4);
  const transforms = stub.buffers.find((b) => b.label === 'gpu-driven transforms');
  expect(transforms?.bytes.byteLength).toBe(2 * 16 * 4);

  /* The one triangle the scene was filled with, written where it stands and nothing past it. */
  const geometry = stub.writes.filter(
    (w) => w.label === 'gpu-driven vertices' || w.label === 'gpu-driven indices',
  );
  expect(geometry).toEqual([
    { label: 'gpu-driven vertices', offset: 0, bytes: 3 * GPU_DRIVEN_VERTEX_FLOATS * 4 },
    { label: 'gpu-driven indices', offset: 0, bytes: 3 * 4 },
  ]);
  /* Position, normal, colour, uv and glow: the scene's interleave, arriving whole. */
  expect(Array.from(new Float32Array((vertices as StubBuffer).bytes.buffer, 0, 12))).toEqual([
    0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0,
  ]);
});

test('the cluster count every per-cluster dispatch is sized by is the capacity', () => {
  /* A dispatch sized by the live count would have to be re-recorded whenever a mesh arrives. */
  const scene = streamingScene(oneTriangleMeshes(), IDENTITY, {
    vertices: 16,
    indices: 32,
    clusters: 4,
    meshes: 2,
  });
  const pass = new GpuDrivenPass(scene, [{ tint: [1, 1, 1], emissive: 0 }]);
  expect(pass.clusterCount).toBe(4);
});

/** A pass mounted over a stub, with the stub returned so a test can read its writes. */
function mountedOver(scene: StreamingScene) {
  const stub = recordingDevice();
  const pass = new GpuDrivenPass(scene, [{ tint: [1, 1, 1], emissive: 0 }]);
  const mounted: PassDevice = {
    backend: 'webgpu',
    device: stub.device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  };
  pass.init(mounted);
  pass.resize(100, 40);
  pass.setView(VIEW);
  const frame: PrepareContext = {
    backend: 'webgpu',
    encoder: stub.encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  };
  return { stub, pass, frame, mounted };
}

const ROOM = { vertices: 64, indices: 128, clusters: 8, meshes: 4 };

test('A MESH\u2019S GEOMETRY IS WRITTEN WHEN IT IS ADDED, its clusters when the frame is recorded', () => {
  /*
   * **The scene keeps no copy**, so there is nothing for a frame to read the geometry out of
   * later: it goes to the device when the mesh is placed. The records that point at it still go
   * with the frame, which is what keeps a quiet frame free.
   */
  const scene = streamingScene(oneTriangleMeshes(), IDENTITY, ROOM);
  const { stub, pass, frame } = mountedOver(scene);
  const labelled = (label: string) => stub.writes.filter((w) => w.label === label);

  stub.writes.length = 0;
  pass.prepare(frame);
  expect(labelled('gpu-driven vertices'), 'a quiet frame wrote geometry').toEqual([]);
  expect(labelled('gpu-driven cluster meta'), 'a quiet frame wrote records').toEqual([]);

  stub.writes.length = 0;
  const handle = scene.add(oneTriangleMeshes()[0] as GpuDrivenMesh, IDENTITY, 0) as StreamHandle;
  expect(labelled('gpu-driven vertices')).toEqual([
    {
      label: 'gpu-driven vertices',
      offset: handle.vertexBase * GPU_DRIVEN_VERTEX_FLOATS * 4,
      bytes: handle.vertexCount * GPU_DRIVEN_VERTEX_FLOATS * 4,
    },
  ]);
  expect(labelled('gpu-driven indices')).toEqual([
    { label: 'gpu-driven indices', offset: handle.indexBase * 4, bytes: handle.indexCount * 4 },
  ]);
  expect(labelled('gpu-driven cluster meta')).toEqual([]);

  stub.writes.length = 0;
  pass.prepare(frame);
  expect(labelled('gpu-driven vertices'), 'the geometry was written twice').toEqual([]);
  expect(labelled('gpu-driven cluster meta').length).toBe(1);
});

test('A SCENE GOES TO ONE PASS: a second is refused by name, and a disposed pass is written to no more', () => {
  const scene = streamingScene(oneTriangleMeshes(), IDENTITY, ROOM);
  const { stub, pass, mounted } = mountedOver(scene);
  expect(() => mountedOver(scene)).toThrow(/build the scene again for a second pass/);

  pass.dispose(mounted);
  stub.writes.length = 0;
  /* A chunk built before its page unmounted still lands, and goes nowhere: its buffers are gone. */
  expect(scene.add(oneTriangleMeshes()[0] as GpuDrivenMesh, IDENTITY, 0)).not.toBeNull();
  expect(stub.writes).toEqual([]);
  expect(() => mountedOver(scene)).toThrow(/build the scene again for a second pass/);
});

test('A QUIET FRAME DOES NOT REFIT THE SHADOW SPHERE, which walks every cluster slot', () => {
  /*
   * **The early return is a cost rather than a correctness guard, and a cost needs a test too.**
   * `sceneBounds` walks `capacity.clusters` records, and the capacity is what a streaming world
   * declares for the chunks it might hold rather than the ones it has — hundreds of thousands of
   * slots for a large radius. Walking them every frame to arrive at the answer from last frame is
   * pure waste, and perturbation found that removing the guard broke nothing: the loops below it
   * iterate empty arrays, so the frame is still correct and merely slower.
   */
  const scene = streamingScene(oneTriangleMeshes(), IDENTITY, ROOM);
  const { pass, frame } = mountedOver(scene);
  pass.prepare(frame);

  const refits = vi.spyOn(scene, 'sceneBounds');
  pass.prepare(frame);
  expect(refits, 'nothing changed and the sphere was refitted anyway').not.toHaveBeenCalled();

  scene.add(oneTriangleMeshes()[0] as GpuDrivenMesh, IDENTITY, 0);
  pass.prepare(frame);
  expect(refits).toHaveBeenCalledTimes(1);
  refits.mockRestore();
});

test('THE UPLOAD IS RECORDED BEFORE ANY DISPATCH READS IT', () => {
  /*
   * **`queue.writeBuffer` is ordered against other queue work and not against an encoder's
   * commands**, which this backend has already paid for once: rewriting one params buffer between
   * dispatches gave every dispatch the last write. So the streamed spans have to be written before
   * the frame records anything that reads them.
   */
  const scene = streamingScene(oneTriangleMeshes(), IDENTITY, ROOM);
  const { stub, pass, frame } = mountedOver(scene);
  scene.add(oneTriangleMeshes()[0] as GpuDrivenMesh, IDENTITY, 0);

  stub.writes.length = 0;
  stub.commands.length = 0;
  pass.prepare(frame);
  /* The records, which are what a frame uploads: the geometry went up when the mesh was added. */
  expect(stub.writes.some((w) => w.label === 'gpu-driven cluster meta')).toBe(true);
  /* Nothing was recorded into the encoder before that write, because nothing had been recorded. */
  expect(stub.commands.length).toBeGreaterThan(0);
});

test('THE SHADOW SPHERE FOLLOWS THE LIVE MESHES, which is what makes its edges crawl', () => {
  /*
   * **Asserted rather than merely accepted**, because §3.4 of the design names the crawl as a known
   * limitation and a limitation nothing measures is a guess. A test that pins the behaviour is what
   * makes the eventual cascade work a change rather than a discovery.
   */
  const scene = streamingScene(oneTriangleMeshes(), IDENTITY, ROOM);
  const { pass, frame } = mountedOver(scene);
  pass.prepare(frame);
  const near = pass.shadowExtent();

  const far = new Float32Array(IDENTITY);
  far[12] = 200;
  scene.add(oneTriangleMeshes()[0] as GpuDrivenMesh, far, 0);
  pass.prepare(frame);
  expect(pass.shadowExtent()).toBeGreaterThan(near * 2);
});

/*
 * **The transparent half, which every opaque frame must be able to prove it did not pay for.**
 *
 * The fixture above is the strongest form of that claim — a frame with no blended material encodes
 * the same commands it encoded before this existed, in the same order — and these two name the
 * claim so a reader does not have to diff a hundred-line array to find it.
 */
test('A SCENE WITH NO BLENDED MATERIAL RECORDS NO TRANSPARENT PASS AT ALL', () => {
  /* The promise every term in this pipeline has made: a caller that does not ask pays nothing,
     and a frame that drew before draws the same. */
  const commands = frameText(recordedFrame());
  expect(commands.filter((line) => line.includes('blend'))).toEqual([]);
});

test('A SCENE TOO LARGE TO BIND IS REFUSED BY NAME at mount, not warned about a hundred times', () => {
  /*
   * **A buffer that can be created is not a buffer that can be bound.** The voxel sandbox's port at
   * a radius of ten sized a vertex buffer of 262,807,200 bytes against a device that bound 134,217,728
   * at once, and what came back was a flood of device warnings about invalid bind groups and a
   * world with no terrain in it — every frame, with nothing naming the capacity as the cause.
   */
  const stub = recordingDevice();
  const scene = streamingScene(oneTriangleMeshes(), IDENTITY);
  /* Just under the vertex buffer, which is the largest the scene makes, so it is the one named. */
  const ceiling = scene.capacity.vertices * GPU_DRIVEN_VERTEX_FLOATS * 4 - 4;
  (stub.device as unknown as { limits: Record<string, number> }).limits = {
    maxStorageBufferBindingSize: ceiling,
  };
  const pass = new GpuDrivenPass(scene, [{ tint: [1, 1, 1], emissive: 0 }]);
  expect(() =>
    pass.init({
      backend: 'webgpu',
      device: stub.device,
      format: 'rgba8unorm',
      depthFormat: 'depth32float',
      samples: 1,
      clipCorrection: IDENTITY,
      depthCorrection: IDENTITY,
      reconstruction: false,
    }),
  ).toThrow(
    new RegExp(
      `gpu-driven vertices needs \\d+ bytes bound at once, and this device binds at most ${ceiling}`,
    ),
  );
});

test('AND A FRAME TOO LARGE TO BIND IS REFUSED THE SAME WAY, when it is sized', () => {
  /* The visibility buffer is the frame's pixels, four bytes each, and it is bound whole as well. */
  const stub = recordingDevice();
  (stub.device as unknown as { limits: Record<string, number> }).limits = {
    maxStorageBufferBindingSize: 1 << 20,
  };
  /* A small map, so the light's pyramid fits under the ceiling and the frame is what meets it. */
  const pass = new GpuDrivenPass(
    streamingScene(oneTriangleMeshes(), IDENTITY),
    [{ tint: [1, 1, 1], emissive: 0 }],
    { mapSize: 256 },
  );
  pass.init({
    backend: 'webgpu',
    device: stub.device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });
  /* And it names what sizes it, which is the frame and not the scene. */
  expect(() => pass.resize(1024, 1024)).toThrow(
    /gpu-driven visibility needs \d+ bytes bound at once.*The frame's size sizes it/,
  );
});

test('AND THE LIGHT\u2019S PYRAMID, which the map\u2019s size sizes, is refused naming that', () => {
  /* Half a 2048 map and every level below: 5,593,088 bytes, and a ceiling just under it. */
  const stub = recordingDevice();
  (stub.device as unknown as { limits: Record<string, number> }).limits = {
    maxStorageBufferBindingSize: 5_593_088 - 4,
  };
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
    { tint: [1, 1, 1], emissive: 0 },
  ]);
  expect(() =>
    pass.init({
      backend: 'webgpu',
      device: stub.device,
      format: 'rgba8unorm',
      depthFormat: 'depth32float',
      samples: 1,
      clipCorrection: IDENTITY,
      depthCorrection: IDENTITY,
      reconstruction: false,
    }),
  ).toThrow(/gpu-driven shadow pyramid needs 5593088 bytes bound at once.*shadow map's size/);
});

test('THE BLENDED RUN CULLS WITHOUT CONES, because its raster draws both sides', () => {
  /*
   * **The cone test assumes a cluster is seen from one side**, which the visibility raster
   * enforces with back-face culling. The blended raster draws both sides — the far face of a pane
   * is seen through its near one — so a cone that says "every face points away" is true of a
   * blended cluster and still wrong to act on. It was never acted on until 2026-09-18, because
   * every cone's cutoff was read in the wrong trigonometry and nothing was ever cone-culled; the
   * day that was put right, the materials rig's pane lost its far face.
   */
  const commands = recordedFrame(VIEW, [
    { tint: [1, 1, 1], emissive: 0 },
    { tint: [0.2, 0.5, 1], emissive: 0, blend: true },
  ]);
  const culls = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0);
  expect(culls).toHaveLength(3);
  const settings = (group: StubGroup | undefined) =>
    Array.from(
      new Float32Array(bufferAt(group as StubGroup, 2).bytes.buffer, 0, CULL_SETTINGS_FLOATS),
    );
  const [one, two, blend] = culls.map(settings) as [number[], number[], number[]];
  expect(one[CULL_CONES]).toBe(1);
  expect(two[CULL_CONES]).toBe(1);
  expect(blend[CULL_CONES]).toBe(0);
  /* And otherwise it is phase two's run: the same eye, the pyramid on, the same shape. */
  expect(blend.slice(0, CULL_CONES)).toEqual(two.slice(0, CULL_CONES));
});

test('A BLENDED MATERIAL OPENS A TRANSPARENT PASS AND LEAVES THE OPAQUE ONE ALONE', () => {
  const commands = frameText(
    recordedFrame(VIEW, [
      { tint: [1, 1, 1], emissive: 0 },
      { tint: [0.2, 0.5, 1], emissive: 0, blend: true },
    ]),
  );
  expect(commands).toContain('beginComputePass({gpu-driven blend cull})');
  expect(commands).toContain(
    'beginRenderPass({gpu-driven blend draw: colour clear, colour clear, depth read-only})',
  );
  expect(commands).toContain('beginRenderPass({gpu-driven blend resolve: colour load})');
  /* And the opaque half is untouched, which is the other half of "leaves it alone". */
  expect(commands).toContain('beginRenderPass({gpu-driven phase 1: colour clear, depth clear})');
  expect(commands).toContain('beginRenderPass({gpu-driven phase 2: colour load, depth load})');
});

test('THE TRANSPARENT DRAW READS ITS OWN LIST AND ITS OWN ARGUMENTS', () => {
  /*
   * **The perturbation the plan named, as an assertion rather than a hope.** Writing the blended
   * clusters into the opaque argument buffer would leave every "opens a pass" test above green and
   * would draw the transparent set twice — once blended and once into the visibility buffer — so
   * the identity of the buffer is what has to be pinned.
   */
  const commands = frameText(
    recordedFrame(VIEW, [
      { tint: [1, 1, 1], emissive: 0 },
      { tint: [0.2, 0.5, 1], emissive: 0, blend: true },
    ]),
  );
  expect(commands).toContain('render.drawIndirect(gpu-driven draw blend, 0)');
  expect(commands).toContain('render.drawIndirect(gpu-driven draw one, 0)');
  expect(commands).toContain('render.drawIndirect(gpu-driven draw two, 0)');
  /* And the blend list is cleared like the other two, or last frame's count draws again. */
  expect(commands).toContain('clearBuffer(gpu-driven draw blend, 4, 4)');
});

test("AND THE BLENDED COMPACTION COUNTS INTO ITS OWN BLOCK, not the opaque half's", () => {
  /*
   * **The perturbation that survived the test above, which is why this one exists.** Pointing the
   * blended compaction's *seventh* binding at the opaque argument buffer left every assertion
   * green: the blended draw still names its own block, so it draws nothing, while the opaque
   * phase-one draw finds its instance count raised by every blended cluster in the scene and
   * rasterises them into the visibility buffer as though they were solid. The draw's identity was
   * pinned and the compaction's was not, and only the second one is where the count is written.
   */
  const stub = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
    { tint: [1, 1, 1], emissive: 0 },
    { tint: [0.2, 0.5, 1], emissive: 0, blend: true },
  ]);
  const mounted: PassDevice = {
    backend: 'webgpu',
    device: stub.device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  };
  pass.init(mounted);
  pass.resize(100, 40);
  pass.setView(VIEW);
  pass.prepare({
    backend: 'webgpu',
    encoder: stub.encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  });

  /* Three compactions now: phase one, phase two, and the blended set. */
  const compactions = groupsAtDispatch(stub.commands, 'gpu-driven compact', 0);
  expect(compactions).toHaveLength(3);
  expect(bufferAt(compactions[2] as (typeof compactions)[number], 6).label).toBe(
    'gpu-driven draw blend',
  );
  expect(bufferAt(compactions[2] as (typeof compactions)[number], 4).label).toBe(
    'gpu-driven list blend',
  );
  /* And neither of the opaque two was redirected into it. */
  expect(bufferAt(compactions[0] as (typeof compactions)[number], 6).label).toBe(
    'gpu-driven draw one',
  );
  expect(bufferAt(compactions[1] as (typeof compactions)[number], 6).label).toBe(
    'gpu-driven draw two',
  );
  /*
   * **And it is compacted against a history of zeros, which is what makes it take every cluster.**
   * `compact.test.ts` holds the rule this depends on; this holds the wiring. Bound to the real
   * history instead, the transparent set would be split by the occlusion phases the way the opaque
   * one is, and roughly half of it would be dropped each frame — surfaces flickering in and out as
   * the camera moves, which reads as a driver problem rather than as a binding.
   */
  expect(bufferAt(compactions[2] as (typeof compactions)[number], 3).label).toBe(
    'gpu-driven history zero',
  );
});

/*
 * **Two pipelines in one frame need one depth buffer, and until now they had two.**
 *
 * The blit presents colour with depth writes off and the comparison set to `always`, under a
 * comment saying this pass *is* the scene — true of a rig, whose scene is nothing but the rig, and
 * false of anything that draws its own geometry beside it. With no shared depth a forward-path mesh
 * behind GPU-driven geometry draws in front of it, and no ordering of the two fixes it: drawn
 * before the blit it is erased, drawn after it floats.
 */
test('THE BLIT WRITES NO DEPTH UNLESS THE PASS WAS ASKED FOR IT', () => {
  /* Every consumer before this drew nothing but this pipeline, so the frame's depth is something
     they never read and a write into it is a change to a frame they did not ask to change. */
  const present = recordedPresent();
  const plain = frameText(present.commands);
  expect(plain.filter((line) => line.includes('blit depth'))).toEqual([]);
  expect(plain).toContain('setPipeline(gpu-driven blit)');
  /*
   * **And the depth state, which is what the feature actually is.** The label says which shader
   * was compiled; `depthWriteEnabled` and `depthCompare` say what the frame's depth buffer gets,
   * and perturbing both left every assertion above green until this was added.
   */
  expect(present.blit.depthStencil.depthWriteEnabled).toBe(false);
  expect(present.blit.depthStencil.depthCompare).toBe('always');
});

test('AND WRITES IT WHEN IT WAS, which is what lets two pipelines share one frame', () => {
  const present = recordedPresent({ presentDepth: true });
  const shared = frameText(present.commands);
  expect(shared).toContain('setPipeline(gpu-driven blit depth)');
  expect(shared.filter((line) => line === 'setPipeline(gpu-driven blit)')).toEqual([]);
  /* One blit, not two: the depth-writing one replaces it rather than following it. */
  expect(shared.filter((line) => line.startsWith('setPipeline(gpu-driven blit'))).toHaveLength(1);
  /*
   * **Written, and compared the frame's own way rather than `always`.** A blit that wrote depth
   * while still comparing `always` would hand the frame a depth buffer it had overwritten with
   * whatever this pass drew last, wherever the pass drew — including in front of geometry the
   * frame had already put there.
   */
  expect(present.blit.depthStencil.depthWriteEnabled).toBe(true);
  expect(present.blit.depthStencil.depthCompare).not.toBe('always');
  /*
   * **Or equal, and the equal is for a pane with nothing of this pipeline behind it.** Its pixel
   * carries the depth the pass cleared to, which is the frame's own clear, so a strict comparison
   * refuses it over the sky every time — `depth-share-check.mjs` measured both panes gone. Equal
   * lets it through and writes back the value that was already there.
   */
  expect(present.blit.depthStencil.depthCompare).toBe(DEPTH_COMPARE_EQUAL);
});

/*
 * **The width the raster drew at and the row the buffer stores are two numbers**, and the shading
 * pass needs both: the row to find a pixel, the width to put a triangle's corners where the raster
 * put them. The block carried the row alone, as `size.x`, which its own declaration calls the
 * width — so on any frame whose width is not a multiple of 64 every corner was placed as though the
 * frame were wider, and every texture coordinate slid sideways, further the further right, while
 * the triangles' own edges, which come from the buffer, stayed put. 1280 is a multiple of 64, which
 * is why no published capture showed it; the city under reconstruction, at 854 and 985, did.
 */
test('THE FRAME CARRIES THE WIDTH IT WAS RASTERISED AT, and the row the buffer stores apart', () => {
  const { device, encoder, buffers } = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
    { tint: [1, 1, 1], emissive: 0 },
  ]);
  pass.init({
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });
  pass.resize(100, 40);
  pass.setView(VIEW);
  pass.prepare({
    backend: 'webgpu',
    encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  });
  const frame = buffers.find((buffer) => buffer.label === 'gpu-driven frame');
  const floats = new Float32Array((frame as { bytes: Uint8Array }).bytes.buffer);
  /* `size` is the thirteenth vec4 and `pitch` the twenty-third, after the fog's four. */
  expect(Array.from(floats.subarray(52, 54))).toEqual([100, 40]);
  /* A hundred texels rounded up to the copy's sixty-four. */
  expect(floats[88]).toBe(128);
});

/*
 * **The pyramid covers the width the raster drew, not the row the buffer pads it to.**
 *
 * The cull maps a cluster's screen rectangle across the pyramid's width. Built over the padded
 * row, a cluster at the right edge of the picture was tested against the padding — the clear,
 * which hides nothing — and every other cluster against the depth of a point further right than it
 * stood, which can hide a cluster in plain view. The city at 854 pixels drew 2,184 clusters where
 * the same view at 1,280 drew 1,310.
 */
test('THE PYRAMID COVERS THE WIDTH THE RASTER DREW, not the row the buffer pads it to', () => {
  const { device, encoder, buffers } = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
    { tint: [1, 1, 1], emissive: 0 },
  ]);
  pass.init({
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });
  pass.resize(100, 40);
  pass.setView(VIEW);
  pass.prepare({
    backend: 'webgpu',
    encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  });
  const settings = buffers.find((buffer) => buffer.label === 'gpu-driven cull settings, phase two');
  const floats = new Float32Array((settings as { bytes: Uint8Array }).bytes.buffer);
  /* The base level's width and height, which is where the cull maps the picture onto. */
  expect(Array.from(floats.subarray(4, 6))).toEqual([100, 40]);
});

/*
 * **Under reconstruction the pass owes the frame its jitter and its depth, asked for or not.**
 *
 * The resolve un-jitters every sample and reprojects every history through the frame's depth.
 * This pass drew its world with the consumer's unjittered matrix and handed over no depth, so
 * every surface it drew stood at the clear — infinitely far — and a sliding camera's history of
 * it was never moved: the published city came back with its windows forty pixels from the frame
 * of the same moment. Measured on the device before either line here existed.
 */
test('UNDER RECONSTRUCTION THE RASTER TAKES THE FRAME’S JITTER, and the blit hands over its depth', () => {
  const { device, encoder, pipelines, buffers } = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
    { tint: [1, 1, 1], emissive: 0 },
  ]);
  pass.init({
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: true,
  });
  pass.resize(100, 40);
  /* w is minus z, as a perspective matrix has it, so the jitter has a w to be scaled by. */
  const viewProj = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]);
  pass.setView({ ...VIEW, viewProj });
  pass.prepare({
    backend: 'webgpu',
    encoder,
    environment: null,
    distanceField: null,
    jitter: new Float32Array([0.01, -0.02]),
  });

  /* Rows 0 and 1 gain the jitter times row 3, whose only entry is the -1 in column 2. */
  const frame = buffers.find((buffer) => buffer.label === 'gpu-driven frame');
  const raster = Array.from(new Float32Array((frame as { bytes: Uint8Array }).bytes.buffer, 0, 16));
  const expected = [1, 0, 0, 0, 0, 1, 0, 0, -0.01, 0.02, 1, -1, 0, 0, 0, 0];
  for (let i = 0; i < 16; i += 1) expect(raster[i]).toBeCloseTo(expected[i] as number, 7);

  const blit = pipelines.find((one) => String(one['label']).startsWith('gpu-driven blit'));
  expect(blit?.['label']).toBe('gpu-driven blit depth');
});

/*
 * **A pane over nothing this pipeline drew is composited over the frame, not painted over it.**
 *
 * The colour target holds premultiplied colour with a coverage in its alpha: one wherever the
 * visibility buffer covered a pixel, and the pane's own coverage where only a blended surface did.
 * A blit that writes its colour as opaque paints such a pane over black and throws away whatever
 * the frame held behind it — the sky — and one that discards below a half drops the pane entirely.
 * `depth-share-check.mjs` measured both on a device before this was written: a pane over a dark
 * backdrop and over a bright one came back the same pixel.
 */
test('THE BLIT LAYS ITS COLOUR OVER THE FRAME, premultiplied, with the depth shared or not', () => {
  const over: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  for (const shadow of [{}, { presentDepth: true }]) {
    const present = recordedPresent(shadow);
    const target = present.blit.fragment.targets[0] as GPUColorTargetState;
    expect(target.blend).toEqual(over);
  }
});

/**
 * A pass asked to count what it draws, mounted, sized and viewed; `frame()` records one more frame
 * and returns only its commands.
 */
function countingPass(
  materials: readonly GpuDrivenMaterial[] = [
    { tint: [1, 1, 1], emissive: 0 },
    { tint: [1, 1, 1], emissive: 0, blend: true },
  ],
  view: GpuDrivenView = VIEW,
) {
  const { device, encoder, commands, buffers } = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), materials);
  pass.countDrawn = true;
  pass.init({
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });
  pass.resize(100, 40);
  pass.setView(view);
  const frame = (): string[] => {
    commands.length = 0;
    pass.prepare({
      backend: 'webgpu',
      encoder,
      environment: null,
      distanceField: null,
      jitter: NO_JITTER,
    });
    return frameText(commands);
  };
  const buffer = (label: string) => {
    const found = buffers.find((one) => one.label === label);
    if (found === undefined) throw new Error(`no buffer ${label}`);
    return found;
  };
  return { pass, frame, buffer };
}

/** What a device settles before the next line of a test runs: every promise already resolved. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/*
 * **The occlusion cull's own number is how many clusters each list drew**, and it lives in the
 * second word of each list's indirect arguments, on the device. The city's case for being a city
 * is that number in a street against the same number above the roofs, so the pass copies the four
 * words out once every list has been drawn and reads them a frame later, as it reads its clock.
 */
test('A PASS NOT ASKED TO COUNT ENCODES NOTHING FOR IT', () => {
  expect(frameText(recordedFrame()).filter((line) => line.includes('drawn'))).toEqual([]);
});

test('A COUNTING PASS COPIES EACH LIST’S COUNT OUT AFTER EVERY DRAW THAT READ IT', () => {
  const lines = frameText(recordedFrame()).length;
  const text = countingPass().frame();
  /* The blended half adds its own stages; the copies are the last thing the frame does. */
  expect(text.length).toBeGreaterThan(lines);
  expect(text.slice(-6)).toEqual([
    'clearBuffer(gpu-driven drawn, 0, 20)',
    'copyBufferToBuffer(gpu-driven draw one, 4, gpu-driven drawn, 0, 4)',
    'copyBufferToBuffer(gpu-driven draw two, 4, gpu-driven drawn, 4, 4)',
    'copyBufferToBuffer(gpu-driven draw blend, 4, gpu-driven drawn, 8, 4)',
    /* The map is drawn in two halves, and its count is both. */
    'copyBufferToBuffer(gpu-driven draw shadow, 4, gpu-driven drawn, 12, 4)',
    'copyBufferToBuffer(gpu-driven draw shadow two, 4, gpu-driven drawn, 16, 4)',
  ]);
  for (const args of ['one', 'two', 'blend', 'shadow', 'shadow two']) {
    const drawn = text.lastIndexOf(`render.drawIndirect(gpu-driven draw ${args}, 0)`);
    const copied = text.findIndex((line) =>
      line.startsWith(`copyBufferToBuffer(gpu-driven draw ${args},`),
    );
    expect(drawn).toBeGreaterThan(0);
    expect(copied).toBeGreaterThan(drawn);
  }
});

test('A LIST THE FRAME DID NOT DRAW IS COUNTED AS NONE, not as the last frame that did', () => {
  /* No blended material and no shadow: two lists drawn, and the other two words cleared. */
  const { frame } = countingPass([{ tint: [1, 1, 1], emissive: 0 }], {
    ...VIEW,
    shadowStrength: 0,
  });
  expect(frame().slice(-3)).toEqual([
    'clearBuffer(gpu-driven drawn, 0, 20)',
    'copyBufferToBuffer(gpu-driven draw one, 4, gpu-driven drawn, 0, 4)',
    'copyBufferToBuffer(gpu-driven draw two, 4, gpu-driven drawn, 4, 4)',
  ]);
});

test('EVERY LIST’S ARGUMENTS CAN BE COPIED FROM, and the counts can be mapped', () => {
  /* A device refuses a copy out of a buffer not made COPY_SRC; this stub would not. */
  const { frame, buffer } = countingPass();
  frame();
  for (const args of ['one', 'two', 'blend', 'shadow', 'shadow two']) {
    expect(buffer(`gpu-driven draw ${args}`).usage & 0x0004).toBe(0x0004);
  }
  expect(buffer('gpu-driven drawn').usage).toBe(0x0001 | 0x0008);
});

test('THE COUNTS ARE READ A FRAME BEHIND, null until then, and a read in flight is not copied into', async () => {
  const { pass, frame, buffer } = countingPass();
  expect(GPU_DRIVEN_LISTS.map((list) => pass.drawnClusters(list))).toEqual([
    null,
    null,
    null,
    null,
  ]);
  frame();
  /* What the device's copies left there. */
  buffer('gpu-driven drawn').bytes.set(new Uint8Array(Uint32Array.from([5, 7, 2, 9, 4]).buffer));
  await settled();
  /* Copied, but not asked for: a map is started by the next frame, once this one is submitted. */
  expect(pass.drawnClusters('phaseOne')).toBeNull();
  const reading = frame();
  expect(reading.filter((line) => line.includes('gpu-driven drawn'))).toEqual([]);
  await settled();
  /* The map's two halves, as one count. */
  expect(GPU_DRIVEN_LISTS.map((list) => pass.drawnClusters(list))).toEqual([5, 7, 2, 13]);
  /* And once the read has settled, the next frame copies again. */
  expect(frame().filter((line) => line.includes('gpu-driven drawn'))).toHaveLength(6);
});

test('A DISPOSED PASS HAS DESTROYED EVERY BUFFER IT MADE, the counts\u2019 among them', () => {
  const { device, encoder, buffers } = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
    { tint: [1, 1, 1], emissive: 0 },
    { tint: [1, 1, 1], emissive: 0, blend: true },
  ]);
  pass.countDrawn = true;
  const mounted: PassDevice = {
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  };
  pass.init(mounted);
  pass.resize(100, 40);
  pass.setView(VIEW);
  pass.prepare({
    backend: 'webgpu',
    encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  });
  pass.dispose(mounted);
  expect(buffers.some((one) => one.label === 'gpu-driven drawn')).toBe(true);
  expect(buffers.filter((one) => !one.destroyed).map((one) => one.label)).toEqual([]);
});

/*
 * **Occlusion switched off is phase two with its pyramid off, and nothing else.** The instance cull
 * is the frustum alone and phase one never reads the pyramid, so the one test the switch has to
 * turn off is phase two's — and then the frame draws every cluster the frustum and the cones keep,
 * which is the count the occlusion cull's own share is measured against.
 */
test('A PASS WITH OCCLUSION OFF CULLS PHASE TWO WITHOUT THE PYRAMID, and changes nothing else', () => {
  const { device, encoder, commands } = recordingDevice();
  const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
    { tint: [1, 1, 1], emissive: 0 },
    { tint: [1, 0, 0], emissive: 1 },
  ]);
  pass.occlusion = false;
  pass.init({
    backend: 'webgpu',
    device,
    format: 'rgba8unorm',
    depthFormat: 'depth32float',
    samples: 1,
    clipCorrection: IDENTITY,
    depthCorrection: IDENTITY,
    reconstruction: false,
  });
  pass.resize(100, 40);
  pass.setView(VIEW);
  pass.prepare({
    backend: 'webgpu',
    encoder,
    environment: null,
    distanceField: null,
    jitter: NO_JITTER,
  });
  const culls = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0);
  const settings = (group: StubGroup | undefined) =>
    Array.from(new Float32Array(bufferAt(group as StubGroup, 2).bytes.buffer, 0, 9));
  expect(culls).toHaveLength(2);
  expect(settings(culls[0])[3]).toBe(0);
  expect(settings(culls[1])[3]).toBe(0);
  /* Every other word of phase two's settings is what it is with occlusion on. */
  const on = groupsAtDispatch(recordedFrame(), 'gpu-driven cull clusters', 0);
  const withIt = settings(on[1]);
  const without = settings(culls[1]);
  expect([...without.slice(0, 3), ...without.slice(4)]).toEqual([
    ...withIt.slice(0, 3),
    ...withIt.slice(4),
  ]);
  expect(withIt[3]).toBe(1);
  /* The light's second half as well, which is the same test against the light's own pyramid. */
  const [, lightTwo] = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0, 'light');
  expect(settings(lightTwo)[3]).toBe(0);
  /* And the frame is the fixed frame, command for command: a switch, not another schedule. */
  expect(frameText(commands)).toEqual(FIXED_FRAME);
});

test('AND THE GLASS IS CULLED WITHOUT THE PYRAMID TOO, which reads phase two\u2019s switch', () => {
  const culled = (occlusion: boolean) => {
    const { device, encoder, commands } = recordingDevice();
    const pass = new GpuDrivenPass(streamingScene(oneTriangleMeshes(), IDENTITY), [
      { tint: [1, 1, 1], emissive: 0 },
      { tint: [1, 1, 1], emissive: 0, blend: true },
    ]);
    pass.occlusion = occlusion;
    pass.init({
      backend: 'webgpu',
      device,
      format: 'rgba8unorm',
      depthFormat: 'depth32float',
      samples: 1,
      clipCorrection: IDENTITY,
      depthCorrection: IDENTITY,
      reconstruction: false,
    });
    pass.resize(100, 40);
    pass.setView(VIEW);
    pass.prepare({
      backend: 'webgpu',
      encoder,
      environment: null,
      distanceField: null,
      jitter: NO_JITTER,
    });
    const culls = groupsAtDispatch(commands, 'gpu-driven cull clusters', 0);
    expect(culls).toHaveLength(3);
    return new Float32Array(bufferAt(culls[2] as StubGroup, 2).bytes.buffer, 0, 9)[3];
  };
  expect(culled(true)).toBe(1);
  expect(culled(false)).toBe(0);
});
