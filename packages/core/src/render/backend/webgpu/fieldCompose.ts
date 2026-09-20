/**
 * The world's distance field, composed on the device from what the frame declared.
 *
 * **Extracted from `GiFieldPass` rather than written beside it**, because two copies of this
 * arithmetic is exactly the hazard `composeField.wgsl.ts` opens by naming: a shader and a
 * TypeScript function cannot import a struct from each other, so every restatement of the layout
 * is a place the two can drift. There was already one restatement — the reference and the shader,
 * which `scripts/gi-parity.mjs` holds together. A third, in a renderer that composed its own field
 * while a contributed pass composed another, would be one nothing checks.
 *
 * **What changed from the pass is where the instances come from.** `GiFieldPass` took them in its
 * constructor and uploaded them once at `init`, which is right for a rig whose scene is fixed and
 * wrong for a renderer whose consumer declares its fields every frame. Here the instances arrive
 * in a `DistanceFieldScene`, the instance count reaches the shader through the params, and the
 * samples live in a buffer that grows to fit the scene and is never reallocated by a steady one.
 *
 * **The samples are uploaded only when the packing changed.** A field is megabytes and a placement
 * is bytes; a composer that rewrote the samples every frame would move the whole world across the
 * bus to say what it said last frame. `DistanceFieldScene.packingChanged` is what knows.
 */

import { placeCascade } from '../../gi/globalField.ts';
import { MAX_DISTANCE_FIELDS } from '../../gi/fieldScene.ts';
import {
  COMPOSE_FIELD_WGSL,
  COMPOSE_INSTANCE_FLOATS,
  COMPOSE_OUTPUT_BASE,
  COMPOSE_PARAM_FLOATS,
  COMPOSE_PARAM_STRIDE,
  COMPOSE_WORKGROUP,
  INSTANCE_ALBEDO,
  INSTANCE_BOUNDS,
  INSTANCE_DIMS,
  INSTANCE_OFFSET,
  INSTANCE_SCALE,
} from '../../shaders/gi/composeField.wgsl.ts';
import { CASCADE_FLOATS } from '../../shaders/gi/sampleField.wgsl.ts';

import type { ReadonlyMat4, ReadonlyVec3 } from 'gl-matrix';
import type { DistanceFieldScene } from '../../gi/fieldScene.ts';
import type { GlobalFieldCascade } from '../../gi/globalField.ts';
import type { PassDistanceField } from '../../pass.ts';

const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const STORAGE = 0x0080;
const QUERY_RESOLVE = 0x0200;
const MAP_READ = 0x0001;

/**
 * What a composed field is, to anything that reads it.
 *
 * **Declared in `pass.ts` rather than here**, because it is what the seam hands a contributed pass
 * and a second declaration of one shape is the drift this file's header is about. This is an alias
 * so a reader of the composer does not have to leave it to learn what it produces.
 */
export type ComposedField = PassDistanceField;

/**
 * What the renderer composes with when a consumer only said `quality.indirectLight`.
 *
 * **Three cascades of 49, four metres at the innermost**, which is `demo/giFieldRig.ts`'s
 * measurement and its reasoning: 49 rather than 33 puts the innermost cascade's step at 16.7 cm
 * rather than 25, the difference between a 1.1 m object having six samples across it and four.
 * The three together are 1.4 MB on the device, and the outermost reaches sixteen metres — beyond
 * which the chain's probe level answers and never declines.
 */
export const DEFAULT_FIELD_COMPOSE: FieldComposeOptions = {
  resolution: 49,
  cascades: 3,
  radius: 4,
};

export interface FieldComposeOptions {
  /** Samples a side, every cascade. */
  readonly resolution: number;
  readonly cascades: number;
  /** The innermost cascade's half-extent in metres. Each one out reaches twice as far. */
  readonly radius: number;
}

export class FieldComposer {
  private readonly options: FieldComposeOptions;
  private readonly samples: number;
  /** The cascade geometry, kept on the CPU because `placeCascade` is what decides it. */
  private readonly cascades: GlobalFieldCascade[] = [];

  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  /** One a cascade, each binding that cascade's own params at its own aligned offset. */
  private groups: GPUBindGroup[] = [];

  private readonly paramBuffer: GPUBuffer;
  private readonly instanceBuffer: GPUBuffer;
  private readonly fieldBuffer: GPUBuffer;
  /** The colour of whatever won the union at each sample, three floats. */
  private readonly albedoBuffer: GPUBuffer;
  /**
   * Where each cascade stands, as the field's readers see it: moved by a copy encoded after the
   * composition, never written by the queue. See `cascadeStaged`.
   */
  private readonly cascadeBuffer: GPUBuffer;
  /**
   * **This frame's bounds, on their way to `cascadeBuffer`.** A queue write lands when it is made
   * and an encoded command when its command buffer runs, and a reader of the field — the march in
   * a contributed pass's `prepare` — is encoded before the composition. Written straight into the
   * buffer readers bind, the bounds arrived a frame ahead of the samples they describe, and every
   * frame a cascade stepped the field was read one voxel off. Staged here and copied after the
   * composition's dispatches, a reader before them sees last frame's bounds with last frame's
   * samples and a reader after them sees this frame's with this frame's.
   */
  private readonly cascadeStaged: GPUBuffer;
  /**
   * The declared sources' samples, grown to fit rather than allocated at the budget.
   *
   * **The budget is a ceiling and not a size.** `MAX_DISTANCE_FIELD_SAMPLES` is sixteen megabytes;
   * a scene with two 33-cubed fields wants two hundred and eighty kilobytes, and a renderer that
   * reserved the ceiling would charge every consumer for the largest one imaginable. It grows when
   * a frame declares more than it holds and never shrinks, so a scene that cycles between two sets
   * of fields settles rather than reallocating.
   */
  private sourceBuffer: GPUBuffer;
  private sourceFloats = 0;

  private readonly paramScratch = new Float32Array(COMPOSE_PARAM_FLOATS);
  private readonly cascadeScratch: Float32Array;
  private readonly instanceScratch = new Float32Array(
    MAX_DISTANCE_FIELDS * COMPOSE_INSTANCE_FLOATS,
  );
  private readonly outerBounds = new Float32Array(6);

  /** False until a frame has actually composed something, so a reader knows not to trace. */
  private composed = false;

  /**
   * The device's own clock around the dispatch, where it has one.
   *
   * **Moved here from `GiFieldPass` with the dispatch it measures.** A timestamp belongs beside
   * the work, and this is now the only place the world's field is composed — so the figure a rig
   * reports is the figure the renderer actually pays rather than a second composition's.
   */
  private queries: GPUQuerySet | null = null;
  private queryResolve: GPUBuffer | null = null;
  private queryRead: GPUBuffer | null = null;
  private queryCopied = false;
  private queryMapping = false;
  private timed = false;
  private composeMsValue = 0;

  constructor(device: GPUDevice, options: FieldComposeOptions) {
    if (!(Math.trunc(options.resolution) >= 2)) {
      throw new Error(
        `FieldComposer: resolution is ${String(options.resolution)}; the minimum is 2.`,
      );
    }
    if (!(Math.trunc(options.cascades) >= 1)) {
      throw new Error(
        `FieldComposer: cascade count is ${String(options.cascades)}; the minimum is 1.`,
      );
    }
    if (!(options.radius > 0)) {
      throw new Error(`FieldComposer: radius is ${String(options.radius)} and must be positive.`);
    }
    this.device = device;
    this.options = options;
    this.samples = Math.trunc(options.resolution) ** 3;
    for (let level = 0; level < Math.trunc(options.cascades); level += 1) {
      this.cascades.push({
        /* Empty on the CPU: the samples live on the device and are never read back. */
        field: new Float32Array(0),
        albedo: new Float32Array(0),
        dims: [options.resolution, options.resolution, options.resolution],
        bounds: new Float32Array(6),
        step: 0,
      });
    }
    this.cascadeScratch = new Float32Array(this.cascades.length * CASCADE_FLOATS);

    /* One float, grown at the first frame that declares a source. See `sourceBuffer`. */
    this.sourceBuffer = this.storage('sources', 4);
    this.instanceBuffer = this.storage('instances', this.instanceScratch.byteLength);
    this.cascadeBuffer = this.storage('cascades', this.cascadeScratch.byteLength);
    this.cascadeStaged = device.createBuffer({
      label: 'gi-field cascades, staged',
      size: Math.max(4, this.cascadeScratch.byteLength),
      usage: COPY_SRC | COPY_DST,
    });
    this.paramBuffer = this.storage('params', this.cascades.length * COMPOSE_PARAM_STRIDE);
    this.fieldBuffer = this.storage('samples', this.samples * this.cascades.length * 4);
    this.albedoBuffer = this.storage('albedo', this.samples * this.cascades.length * 3 * 4);

    const module = device.createShaderModule({ label: 'gi compose', code: COMPOSE_FIELD_WGSL });
    this.pipeline = device.createComputePipeline({
      label: 'gi compose',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    this.rebuildGroups();

    if (device.features.has('timestamp-query')) {
      this.queries = device.createQuerySet({
        label: 'gi-field timings',
        type: 'timestamp',
        count: 2,
      });
      this.queryResolve = device.createBuffer({
        label: 'gi-field timings resolve',
        size: 16,
        usage: QUERY_RESOLVE | COPY_SRC,
      });
      this.queryRead = device.createBuffer({
        label: 'gi-field timings read',
        size: 16,
        usage: COPY_DST | MAP_READ,
      });
    }
  }

  /** One bind group a cascade. Rebuilt whenever the source buffer is replaced by a larger one. */
  private rebuildGroups(): void {
    const layout = this.pipeline.getBindGroupLayout(0);
    this.groups = this.cascades.map((_, level) =>
      this.device.createBindGroup({
        label: `gi compose ${String(level)}`,
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: this.paramBuffer,
              offset: level * COMPOSE_PARAM_STRIDE,
              size: COMPOSE_PARAM_FLOATS * 4,
            },
          },
          { binding: 1, resource: { buffer: this.instanceBuffer } },
          { binding: 2, resource: { buffer: this.sourceBuffer } },
          { binding: 3, resource: { buffer: this.fieldBuffer } },
          { binding: 4, resource: { buffer: this.albedoBuffer } },
        ],
      }),
    );
  }

  /**
   * Make room for `floats` of samples, replacing the buffer and its bind groups if it is short.
   *
   * **Grown to exactly what is asked rather than doubled.** A doubling policy is for something
   * appended to; this is rewritten whole whenever the packing changes, and the sizes involved are
   * a scene's whole set of baked fields — a quantity that changes when the world does and not
   * between frames of a steady one.
   */
  private ensureSources(floats: number): void {
    if (floats <= this.sourceFloats) return;
    this.sourceBuffer.destroy();
    this.sourceBuffer = this.storage('sources', floats * 4);
    this.sourceFloats = floats;
    this.rebuildGroups();
  }

  private storage(label: string, bytes: number): GPUBuffer {
    return this.device.createBuffer({
      label: `gi-field ${label}`,
      size: Math.max(4, bytes),
      usage: STORAGE | COPY_DST,
    });
  }

  /** The composed field, or null until a frame has composed one. */
  get field(): ComposedField | null {
    if (!this.composed) return null;
    return {
      samples: this.fieldBuffer,
      albedo: this.albedoBuffer,
      cascades: this.cascadeBuffer,
      levels: this.cascades.length,
      side: Math.trunc(this.options.resolution),
      finestStep: (this.cascades[0] as GlobalFieldCascade).step,
      outerBounds: this.outerBounds,
    };
  }

  /**
   * Compose every cascade from what the frame declared, centred on the eye.
   *
   * One dispatch a cascade rather than one for all of them: each has its own origin and step, and
   * a single dispatch would carry them in a buffer indexed by the invocation's own cascade — a
   * divide and a dependent read per thread to save a handful of dispatches.
   *
   * **A frame that declared nothing composes nothing and says so.** An empty instance list would
   * otherwise fill every cascade with the "no surface anywhere" value, which a march reads as an
   * infinite empty room — a ray that travels its whole reach and reports a miss. That is the right
   * answer, but it costs a full dispatch to write it and the field it produces was already there.
   */
  compose(encoder: GPUCommandEncoder, scene: DistanceFieldScene, eye: ReadonlyVec3): void {
    if (scene.length === 0) {
      this.composed = false;
      return;
    }
    const queue = this.device.queue;

    /*
     * **The samples only when the packing changed.** Sixteen megabytes a frame to say what it said
     * last frame is the upload this flag exists to avoid; `DistanceFieldScene` is what knows,
     * because it is what assigns the offsets and they are positional.
     */
    this.ensureSources(scene.sampleCount);
    if (scene.packingChanged) {
      /* Each source straight to its own offset: no staging copy, and no gap between them. */
      for (const source of scene.sources) {
        queue.writeBuffer(this.sourceBuffer, scene.offsetOf(source) * 4, source.field);
      }
    }

    let at = 0;
    scene.replay((instance) => {
      const base = at * COMPOSE_INSTANCE_FLOATS;
      writeInverse(instance.transform, this.instanceScratch, base);
      this.instanceScratch[base + INSTANCE_SCALE] = Math.hypot(
        instance.transform[0] ?? 0,
        instance.transform[1] ?? 0,
        instance.transform[2] ?? 0,
      );
      this.instanceScratch.set(instance.source.bounds, base + INSTANCE_BOUNDS);
      this.instanceScratch[base + INSTANCE_DIMS] = instance.source.dims[0];
      this.instanceScratch[base + INSTANCE_DIMS + 1] = instance.source.dims[1];
      this.instanceScratch[base + INSTANCE_DIMS + 2] = instance.source.dims[2];
      this.instanceScratch[base + INSTANCE_OFFSET] = scene.offsetOf(instance.source);
      this.instanceScratch[base + INSTANCE_ALBEDO] = instance.albedo[0] as number;
      this.instanceScratch[base + INSTANCE_ALBEDO + 1] = instance.albedo[1] as number;
      this.instanceScratch[base + INSTANCE_ALBEDO + 2] = instance.albedo[2] as number;
      at += 1;
    });
    queue.writeBuffer(
      this.instanceBuffer,
      0,
      this.instanceScratch,
      0,
      at * COMPOSE_INSTANCE_FLOATS,
    );

    /* Where the cascades stand this frame. `placeCascade` is shared with the reference. */
    for (let level = 0; level < this.cascades.length; level += 1) {
      const cascade = this.cascades[level] as GlobalFieldCascade;
      placeCascade(cascade, level, this.options.radius, eye);
      const slot = level * CASCADE_FLOATS;
      this.cascadeScratch.set(cascade.bounds, slot);
      this.cascadeScratch[slot + 6] = cascade.step;
    }
    queue.writeBuffer(this.cascadeStaged, 0, this.cascadeScratch);
    this.outerBounds.set((this.cascades[this.cascades.length - 1] as GlobalFieldCascade).bounds);

    /*
     * **Every cascade's params written before the pass opens, each at its own offset.**
     * `queue.writeBuffer` is a queue operation and is not ordered against an encoder's commands,
     * so rewriting one region between dispatches would give all of them the last write — every
     * cascade composed with the outermost one's origin and step.
     */
    for (let level = 0; level < this.cascades.length; level += 1) {
      const cascade = this.cascades[level] as GlobalFieldCascade;
      this.paramScratch[0] = cascade.bounds[0] as number;
      this.paramScratch[1] = cascade.bounds[1] as number;
      this.paramScratch[2] = cascade.bounds[2] as number;
      this.paramScratch[3] = cascade.step;
      this.paramScratch[4] = this.options.resolution;
      this.paramScratch[5] = this.options.resolution;
      this.paramScratch[6] = this.options.resolution;
      /* The reach, which is the cascade's half-extent. `composeGlobalField` fills with the same. */
      this.paramScratch[7] = ((cascade.bounds[3] as number) - (cascade.bounds[0] as number)) / 2;
      this.paramScratch[8] = at;
      this.paramScratch[COMPOSE_OUTPUT_BASE] = level * this.samples;
      queue.writeBuffer(this.paramBuffer, level * COMPOSE_PARAM_STRIDE, this.paramScratch);
    }

    const pass = encoder.beginComputePass({
      label: 'gi compose',
      timestampWrites:
        this.queries === null
          ? undefined
          : { querySet: this.queries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
    });
    pass.setPipeline(this.pipeline);
    for (let level = 0; level < this.cascades.length; level += 1) {
      pass.setBindGroup(0, this.groups[level] as GPUBindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.samples / COMPOSE_WORKGROUP), 1, 1);
    }
    pass.end();
    /* The bounds reach readers here, in step with the samples just written. See `cascadeStaged`. */
    encoder.copyBufferToBuffer(
      this.cascadeStaged,
      0,
      this.cascadeBuffer,
      0,
      this.cascadeScratch.byteLength,
    );
    this.composed = true;

    if (this.queries !== null && this.queryResolve !== null && this.queryRead !== null) {
      if (!this.queryCopied && !this.queryMapping) {
        encoder.resolveQuerySet(this.queries, 0, 2, this.queryResolve, 0);
        encoder.copyBufferToBuffer(this.queryResolve, 0, this.queryRead, 0, 16);
        this.queryCopied = true;
      }
    }
  }

  /**
   * The device milliseconds the last measured composition took, or null where nothing measured it.
   *
   * One frame behind, because a timestamp is read back and a readback that blocked would be the
   * measurement changing what it measures.
   */
  get composeMs(): number | null {
    return this.timed ? this.composeMsValue : null;
  }

  /** Ask for the last frame's figure, once the frame that recorded it has been submitted. */
  readTimings(): void {
    if (this.queryRead === null || !this.queryCopied || this.queryMapping) return;
    this.queryMapping = true;
    const buffer = this.queryRead;
    void buffer
      .mapAsync(MAP_READ)
      .then(() => {
        const stamps = new BigUint64Array(buffer.getMappedRange().slice(0));
        buffer.unmap();
        const from = stamps[0] ?? 0n;
        const to = stamps[1] ?? 0n;
        /* Nanoseconds, and a pair that never ran reads zero rather than a negative span. */
        this.composeMsValue = to > from ? Number(to - from) / 1e6 : 0;
        this.timed = true;
      })
      .catch(() => {
        /* A device that will not map its own query buffer reports no timing and composes anyway. */
      })
      .finally(() => {
        this.queryMapping = false;
        this.queryCopied = false;
      });
  }

  dispose(): void {
    this.paramBuffer.destroy();
    this.instanceBuffer.destroy();
    this.sourceBuffer.destroy();
    this.fieldBuffer.destroy();
    this.albedoBuffer.destroy();
    this.cascadeBuffer.destroy();
    this.cascadeStaged.destroy();
    this.queryResolve?.destroy();
    this.queryRead?.destroy();
    this.queries?.destroy();
  }
}

/**
 * The inverse of a rigid transform with a uniform scale, written into `out` at `at`.
 *
 * **Not a general inverse**, because `composeGlobalField` refuses anything else: a distance is not
 * preserved by a non-uniform scale and there is no factor to correct one by. Transposing the
 * rotation and dividing by the scale squared is exact for what is allowed, and a general inverse
 * here would be a fourth spelling of a constraint stated three times already.
 */
export function writeInverse(m: ReadonlyMat4, out: Float32Array, at: number): void {
  const scale = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0);
  const inverse = scale > 0 ? 1 / (scale * scale) : 0;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[at + col * 4 + row] = (m[row * 4 + col] ?? 0) * inverse;
    }
  }
  for (let row = 0; row < 3; row += 1) {
    out[at + 12 + row] = -(
      (out[at + row] as number) * (m[12] ?? 0) +
      (out[at + 4 + row] as number) * (m[13] ?? 0) +
      (out[at + 8 + row] as number) * (m[14] ?? 0)
    );
  }
  out[at + 3] = 0;
  out[at + 7] = 0;
  out[at + 11] = 0;
  out[at + 15] = 1;
}
