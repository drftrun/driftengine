/**
 * A few probes a frame, traced down the GI chain and convolved into the grid the shading samples.
 *
 * **The light arrives through `gridIrradiance` and nowhere else**, which is Wave 4A's own
 * constraint: a second per-pixel irradiance buffer beside the one the shading already mixes into
 * its ambient is a design failure rather than an optimisation. So this writes the *irradiance level
 * of the existing probe array* — the same texels a rasterised bake would have written — and the lit
 * pass changes not at all.
 *
 * **Three steps on one encoder, in order.** A compute dispatch traces `PROBE_DIRECTIONS` rays for
 * each scheduled probe; a second convolves those rays into an octahedral map; a render pass a layer
 * carries the map into the array. They are separate because the convolution reads every ray of its
 * probe, so tracing per texel would cast the same rays `edge²` times.
 *
 * **The array is sampled by the first step and written by the third, and that is legal.** WebGPU
 * forbids a texture being read and written inside one pass, not across passes on one encoder. What
 * it costs is a frame of latency in the bounce, which a probe volume has anyway because it
 * accumulates — and the accumulation is what makes the solution multi-bounce.
 *
 * **The grid does not have to be seeded, and two wrong diagnoses said it did.** A traced probe
 * gathers radiance from the field it hits and reads what that surface is worth *from the probes* —
 * the maintainer's answer of 2026-09-17, and what makes the solution converge on several bounces.
 * Since Task 8 it also evaluates the *sun* at the hit, so it introduces light of its own and a grid
 * starting at black climbs away from black. It is not a fixed point.
 *
 * It looked like one twice. `demo/dev/bounce.html` with no rasterised capture came back at a
 * uniform 209 of 255, first read as "converges on whatever it started with" and then as undefined
 * memory in the probe array. It was neither: `flatTextures` resolves `uEnvironment` to a one-texel
 * **white** stand-in while `probeBaked` is false, and a flat bind group holds whatever texture
 * existed when it was built — so a renderer whose grid is filled by tracing kept that white for
 * ever, and 209 is 0.82 (the room's albedo) times 255. `markProbeFilled` rebuilds the groups when
 * the last layer lands, and the room now measures the same with the capture and without it.
 *
 * So `bakeProbeGrid` is an optional head start rather than a requirement, and **the wave's
 * criterion of "no baked lighting" is met literally**: `scripts/bounce-check.mjs` runs the page
 * with `?seed=0` and asserts it.
 *
 * **A layer nothing has ever rasterised gets its whole chain written once**, because the roughness
 * levels of an unseeded array hold undefined contents and a reflective surface sampling those is
 * worse than one sampling a flat colour. A seeded layer keeps the chain it was given and only its
 * irradiance level is rewritten, which is the level the diffuse term reads.
 */

import { PROBE_DIRECTIONS } from '../../gi/probeTrace.ts';
import { probeUpdateSchedule } from '../../gi/probeVolume.ts';
import { irradianceLevelFor } from '../../prefilterEnvMap.ts';
import {
  BAKE_COUNTS,
  BAKE_EDGE,
  BAKE_FRAME,
  BAKE_ORIGIN,
  BAKE_SCHEDULED,
  BAKE_SPACING,
  BAKE_SKY_COLOUR,
  BAKE_SUN_COLOUR,
  BAKE_SUN_DIR,
  PROBE_BAKE_FLOATS,
  PROBE_BAKE_WORKGROUP,
  PROBE_BLIT_FLOATS,
  PROBE_BLIT_STRIDE,
  PROBE_BLIT_WGSL,
  PROBE_RAY_FLOATS,
  PROBE_TEXEL_FLOATS,
  probeBakeWgsl,
} from '../../shaders/gi/probeBake.wgsl.ts';
import { PROBE_MARCH_DEFAULTS, PROBE_MARCH_FLOATS } from '../../shaders/gi/probeTrace.wgsl.ts';
import {
  PROBE_VOLUME_FLOATS,
  VOLUME_COUNTS,
  VOLUME_EDGE,
  VOLUME_INV_SPACING,
  VOLUME_LEVEL,
  VOLUME_ORIGIN,
  VOLUME_RADIANCE_EDGE,
  VOLUME_RADIANCE_LEVEL,
} from '../../shaders/gi/probeVolume.wgsl.ts';

import type { ProbeGrid } from '../../probeGrid.ts';
import type { PassDistanceField } from '../../pass.ts';

const COPY_DST = 0x0008;
const COPY_SRC = 0x0004;
const MAP_READ = 0x0001;
const QUERY_RESOLVE = 0x0200;
const STORAGE = 0x0080;
const UNIFORM = 0x0040;
const VISIBILITY_FRAGMENT = 0x2;
const VISIBILITY_COMPUTE = 0x4;

/**
 * How many probes are refreshed a frame.
 *
 * **Five, and the number is a cost rather than a quality.** Each is `PROBE_DIRECTIONS` marches down
 * a three-level chain, and what makes a probe converge is the direction set turning between
 * refreshes rather than any single refresh being final. A 64-probe grid comes all the way round in
 * thirteen frames, which at sixty a second is a fifth of a second for a light that moved.
 */
export const PROBES_PER_FRAME = 5;

export interface ProbeBakeTargets {
  /** The array the shading samples, whose irradiance level this writes. */
  readonly array: GPUTexture;
  /** A view of the whole array, for the dispatches that read what the last frame left. */
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  /** Texels across level 0, gutter included. */
  readonly edge: number;
  readonly format: GPUTextureFormat;
}

export class ProbeBaker {
  private readonly device: GPUDevice;
  private readonly targets: ProbeBakeTargets;
  /** Which mip holds the cosine convolution, and how many texels across it is. */
  private readonly level: number;
  private readonly levelEdge: number;
  private readonly texels: number;

  private readonly tracePipeline: GPUComputePipeline;
  private readonly convolvePipeline: GPUComputePipeline;
  private readonly blitPipeline: GPURenderPipeline;
  private readonly computeLayout: GPUBindGroupLayout;

  private readonly marchBuffer: GPUBuffer;
  private readonly bakeBuffer: GPUBuffer;
  private readonly volumeBuffer: GPUBuffer;
  private readonly scheduleBuffer: GPUBuffer;
  private readonly rayBuffer: GPUBuffer;
  private readonly irradianceBuffer: GPUBuffer;
  private readonly blitParams: GPUBuffer;

  private readonly blitGroup: GPUBindGroup;
  /** Rebuilt only when the field it was built against is a different object. */
  private computeGroup: GPUBindGroup | null = null;
  private boundTo: PassDistanceField | null = null;

  private readonly marchScratch = new Float32Array(PROBE_MARCH_FLOATS);
  private readonly marchInts = new Uint32Array(this.marchScratch.buffer);
  private readonly bakeScratch = new Float32Array(PROBE_BAKE_FLOATS);
  private readonly volumeScratch = new Float32Array(PROBE_VOLUME_FLOATS);
  private readonly scheduleScratch = new Int32Array(PROBES_PER_FRAME);
  private readonly scheduleUpload = new Uint32Array(PROBES_PER_FRAME);

  /** One view a layer a level, built when the grid changes rather than in the frame loop. */
  private views: GPUTextureView[][] = [];
  /** Which layers have had their whole chain written, so the first fill happens once. */
  private filled = new Uint8Array(0);
  private layers = 0;

  private frameIndex = 0;

  /**
   * The device's own clock around the two dispatches, where it has one.
   *
   * **Beside the work it measures, exactly as `FieldComposer`'s is.** Without it the only figure
   * indirect light could publish was the *composition's*, and the trace — which is the half the
   * feature is named for — had no cost anyone could quote. The blits are outside the pair
   * deliberately: they are render passes an encoder interleaves with the frame's own, and a span
   * that covered them would be measuring the frame rather than the bake.
   */
  private readonly queries: GPUQuerySet | null;
  private readonly queryResolve: GPUBuffer | null;
  private readonly queryRead: GPUBuffer | null;
  private queryCopied = false;
  private queryMapping = false;
  private timed = false;
  private bakeMsValue = 0;

  constructor(device: GPUDevice, targets: ProbeBakeTargets) {
    this.device = device;
    this.targets = targets;
    this.level = irradianceLevelFor(targets.edge);
    this.levelEdge = Math.max(1, targets.edge >> this.level);
    this.texels = this.levelEdge * this.levelEdge;

    const module = device.createShaderModule({ label: 'probe bake', code: probeBakeWgsl() });
    /*
     * **One explicit layout for both dispatches, and `'auto'` cannot do it.** An auto-generated
     * layout belongs to the pipeline that generated it and is compatible with no other, so a bind
     * group built from the trace pipeline's would be rejected by the convolve pipeline — two
     * entry points of the same module over exactly the same bindings. Written out, one group
     * serves both, and there is one place a binding number can be wrong rather than two.
     */
    const storageRead = { type: 'read-only-storage' } as const;
    this.computeLayout = device.createBindGroupLayout({
      label: 'probe bake.layout',
      entries: [
        { binding: 0, visibility: VISIBILITY_COMPUTE, buffer: storageRead },
        { binding: 1, visibility: VISIBILITY_COMPUTE, buffer: storageRead },
        { binding: 2, visibility: VISIBILITY_COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: VISIBILITY_COMPUTE, buffer: { type: 'uniform' } },
        { binding: 4, visibility: VISIBILITY_COMPUTE, buffer: storageRead },
        { binding: 5, visibility: VISIBILITY_COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: VISIBILITY_COMPUTE, buffer: { type: 'storage' } },
        { binding: 7, visibility: VISIBILITY_COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 8,
          visibility: VISIBILITY_COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d-array' },
        },
        { binding: 9, visibility: VISIBILITY_COMPUTE, sampler: { type: 'filtering' } },
        { binding: 10, visibility: VISIBILITY_COMPUTE, buffer: storageRead },
      ],
    });
    const computeLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.computeLayout],
    });
    this.tracePipeline = device.createComputePipeline({
      label: 'probe bake trace',
      layout: computeLayout,
      compute: { module, entryPoint: 'traceMain' },
    });
    this.convolvePipeline = device.createComputePipeline({
      label: 'probe bake convolve',
      layout: computeLayout,
      compute: { module, entryPoint: 'convolveMain' },
    });

    const blit = device.createShaderModule({ label: 'probe blit', code: PROBE_BLIT_WGSL });
    /*
     * **An explicit layout rather than `'auto'`, because the parameters are read by dynamic
     * offset.** An inferred layout declares `hasDynamicOffset: false`, so `setBindGroup` with an
     * offset is rejected — and the alternative is a bind group a draw, which is the per-frame
     * allocation the house rules are about. `filmPass.ts` writes the same layout for the same
     * reason.
     */
    const blitLayout = device.createBindGroupLayout({
      label: 'probe blit.layout',
      entries: [
        {
          binding: 0,
          visibility: VISIBILITY_FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: PROBE_BLIT_FLOATS * 4,
          },
        },
        {
          binding: 1,
          visibility: VISIBILITY_FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });
    this.blitPipeline = device.createRenderPipeline({
      label: 'probe blit',
      layout: device.createPipelineLayout({ bindGroupLayouts: [blitLayout] }),
      vertex: { module: blit, entryPoint: 'blitVert' },
      fragment: {
        module: blit,
        entryPoint: 'blitFrag',
        targets: [{ format: targets.format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.marchBuffer = this.uniform('march', PROBE_MARCH_FLOATS * 4);
    this.bakeBuffer = this.uniform('bake', PROBE_BAKE_FLOATS * 4);
    this.volumeBuffer = this.uniform('volume', PROBE_VOLUME_FLOATS * 4);
    this.scheduleBuffer = this.storage('schedule', PROBES_PER_FRAME * 4);
    this.rayBuffer = this.storage(
      'rays',
      PROBES_PER_FRAME * PROBE_DIRECTIONS * PROBE_RAY_FLOATS * 4,
    );
    this.irradianceBuffer = this.storage(
      'irradiance',
      PROBES_PER_FRAME * this.texels * PROBE_TEXEL_FLOATS * 4,
    );

    /*
     * **The blit's parameters are written once and read by dynamic offset**, because a slot's
     * number never changes: slot 0 is always slot 0. Building a bind group a draw would be the
     * per-frame allocation the house rules are about, and a uniform rewritten between draws would
     * give every draw the last write — the hazard `FieldComposer` documents for its cascades.
     */
    this.blitParams = this.device.createBuffer({
      label: 'probe blit params',
      size: PROBES_PER_FRAME * (this.level + 1) * PROBE_BLIT_STRIDE,
      usage: UNIFORM | COPY_DST,
    });
    const params = new Float32Array(PROBE_BLIT_FLOATS);
    for (let slot = 0; slot < PROBES_PER_FRAME; slot += 1) {
      for (let level = 0; level <= this.level; level += 1) {
        params[0] = slot;
        params[1] = this.levelEdge;
        params[2] = Math.max(1, targets.edge >> level);
        device.queue.writeBuffer(this.blitParams, this.blitOffset(slot, level), params);
      }
    }

    this.blitGroup = device.createBindGroup({
      label: 'probe blit',
      layout: blitLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.blitParams,
            offset: 0,
            size: PROBE_BLIT_FLOATS * 4,
          },
        },
        { binding: 1, resource: { buffer: this.irradianceBuffer } },
      ],
    });

    const clocked = device.features.has('timestamp-query');
    this.queries = clocked
      ? device.createQuerySet({ label: 'probe bake timings', type: 'timestamp', count: 2 })
      : null;
    this.queryResolve = clocked
      ? device.createBuffer({
          label: 'probe bake timings resolve',
          size: 16,
          usage: QUERY_RESOLVE | COPY_SRC,
        })
      : null;
    this.queryRead = clocked
      ? device.createBuffer({
          label: 'probe bake timings read',
          size: 16,
          usage: COPY_DST | MAP_READ,
        })
      : null;
  }

  /**
   * The device milliseconds the last measured bake took, or null where nothing measured it.
   *
   * One frame behind, because a timestamp is read back and a readback that blocked would be the
   * measurement changing what it measures. It covers one refresh — `PROBES_PER_FRAME` probes —
   * rather than a whole grid, which is what a frame actually pays.
   */
  get bakeMs(): number | null {
    return this.timed ? this.bakeMsValue : null;
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
        this.bakeMsValue = to > from ? Number(to - from) / 1e6 : 0;
        this.timed = true;
      })
      .catch(() => {
        /* A device that will not map its own query buffer reports no timing and bakes anyway. */
      })
      .finally(() => {
        this.queryMapping = false;
        this.queryCopied = false;
      });
  }

  private blitOffset(slot: number, level: number): number {
    return (slot * (this.level + 1) + level) * PROBE_BLIT_STRIDE;
  }

  private uniform(label: string, bytes: number): GPUBuffer {
    return this.device.createBuffer({
      label: `probe bake ${label}`,
      size: Math.max(16, Math.ceil(bytes / 16) * 16),
      usage: UNIFORM | COPY_DST,
    });
  }

  private storage(label: string, bytes: number): GPUBuffer {
    return this.device.createBuffer({
      label: `probe bake ${label}`,
      size: Math.max(4, bytes),
      usage: STORAGE | COPY_DST,
    });
  }

  /**
   * Build the per-layer views a grid needs, and forget which layers were filled.
   *
   * Called when the grid changes rather than every frame: a view is cheap and sixty-four of them
   * are not, and the frame path is the one place this project does not allocate.
   */
  setGrid(layers: number): void {
    if (layers === this.layers && this.views.length === layers) return;
    this.layers = layers;
    this.filled = new Uint8Array(layers);
    this.views = [];
    for (let layer = 0; layer < layers; layer += 1) {
      const perLevel: GPUTextureView[] = [];
      for (let level = 0; level <= this.level; level += 1) {
        perLevel.push(
          this.targets.array.createView({
            label: `probe.array ${String(layer)}.${String(level)}`,
            dimension: '2d',
            baseMipLevel: level,
            mipLevelCount: 1,
            baseArrayLayer: layer,
            arrayLayerCount: 1,
          }),
        );
      }
      this.views.push(perLevel);
    }
  }

  /** Whether every layer has had its chain written, which is what makes the array safe to sample. */
  get complete(): boolean {
    if (this.layers === 0) return false;
    for (let layer = 0; layer < this.layers; layer += 1) {
      if (this.filled[layer] !== 1) return false;
    }
    return true;
  }

  /**
   * Refresh this frame's share of the grid.
   *
   * Returns how many probes were baked, which is zero when there is nothing to trace against.
   */
  bake(
    encoder: GPUCommandEncoder,
    field: PassDistanceField,
    grid: ProbeGrid,
    seeded: boolean,
    sun: {
      readonly direction: ArrayLike<number>;
      readonly colour: ArrayLike<number>;
      readonly sky: ArrayLike<number>;
    },
  ): number {
    if (this.layers !== grid.layers) this.setGrid(grid.layers);
    const scheduled = probeUpdateSchedule(
      grid.layers,
      PROBES_PER_FRAME,
      this.frameIndex,
      this.scheduleScratch,
    );
    if (scheduled === 0) return 0;

    const queue = this.device.queue;
    for (let slot = 0; slot < scheduled; slot += 1) {
      this.scheduleUpload[slot] = this.scheduleScratch[slot] as number;
    }
    queue.writeBuffer(this.scheduleBuffer, 0, this.scheduleUpload, 0, scheduled);

    /* The march, from the same defaults `gi/traceField.ts` gives the reference. */
    this.marchInts[0] = PROBE_MARCH_DEFAULTS.steps;
    this.marchInts[1] = field.levels;
    this.marchInts[2] = field.side;
    this.marchInts[3] = scheduled * PROBE_DIRECTIONS;
    this.marchScratch[4] = PROBE_MARCH_DEFAULTS.reachM;
    this.marchScratch[5] = PROBE_MARCH_DEFAULTS.hitEpsilonM;
    this.marchScratch[6] = field.finestStep;
    this.marchScratch[7] = PROBE_MARCH_DEFAULTS.coneAngle;
    this.marchScratch[8] = field.outerBounds[0] as number;
    this.marchScratch[9] = field.outerBounds[1] as number;
    this.marchScratch[10] = field.outerBounds[2] as number;
    this.marchScratch[12] = field.outerBounds[3] as number;
    this.marchScratch[13] = field.outerBounds[4] as number;
    this.marchScratch[14] = field.outerBounds[5] as number;
    queue.writeBuffer(this.marchBuffer, 0, this.marchScratch);

    for (let axis = 0; axis < 3; axis += 1) {
      this.bakeScratch[BAKE_ORIGIN + axis] = grid.origin[axis] as number;
      this.bakeScratch[BAKE_SPACING + axis] = grid.spacing[axis] as number;
      this.bakeScratch[BAKE_COUNTS + axis] = grid.counts[axis] as number;
      this.volumeScratch[VOLUME_ORIGIN + axis] = grid.origin[axis] as number;
      this.volumeScratch[VOLUME_INV_SPACING + axis] = grid.invSpacing[axis] as number;
      this.volumeScratch[VOLUME_COUNTS + axis] = grid.counts[axis] as number;
    }
    this.bakeScratch[BAKE_EDGE] = this.levelEdge;
    this.bakeScratch[BAKE_FRAME] = this.frameIndex;
    this.bakeScratch[BAKE_SCHEDULED] = scheduled;
    /*
     * **The sun, because the trace shades what it hits rather than reading a capture.** That is
     * the whole of what a traced grid buys over a rasterised one: a light that moves changes the
     * bounce at the next refresh, where a bake keeps sending the light it was taken under.
     */
    for (let axis = 0; axis < 3; axis += 1) {
      this.bakeScratch[BAKE_SUN_DIR + axis] = sun.direction[axis] ?? 0;
      this.bakeScratch[BAKE_SUN_COLOUR + axis] = sun.colour[axis] ?? 0;
      this.bakeScratch[BAKE_SKY_COLOUR + axis] = sun.sky[axis] ?? 0;
    }
    queue.writeBuffer(this.bakeBuffer, 0, this.bakeScratch);

    this.volumeScratch[VOLUME_EDGE] = this.levelEdge;
    this.volumeScratch[VOLUME_LEVEL] = this.level;
    /*
     * **Level 0, which is radiance**, and it is what a ray gathers. The irradiance level above is
     * what the bake *writes*; reading it back as though it were radiance is what made the first
     * traced room dimmer and greyer than the rasterised one — see `probeVolumeRadianceAt`.
     */
    this.volumeScratch[VOLUME_RADIANCE_EDGE] = this.targets.edge;
    this.volumeScratch[VOLUME_RADIANCE_LEVEL] = 0;
    queue.writeBuffer(this.volumeBuffer, 0, this.volumeScratch);

    if (this.boundTo !== field || this.computeGroup === null) {
      this.computeGroup = this.device.createBindGroup({
        label: 'probe bake',
        layout: this.computeLayout,
        entries: [
          { binding: 0, resource: { buffer: field.cascades } },
          { binding: 1, resource: { buffer: field.samples } },
          { binding: 2, resource: { buffer: this.marchBuffer } },
          { binding: 3, resource: { buffer: this.bakeBuffer } },
          { binding: 4, resource: { buffer: this.scheduleBuffer } },
          { binding: 5, resource: { buffer: this.rayBuffer } },
          { binding: 6, resource: { buffer: this.irradianceBuffer } },
          { binding: 7, resource: { buffer: this.volumeBuffer } },
          { binding: 8, resource: this.targets.view },
          { binding: 9, resource: this.targets.sampler },
          { binding: 10, resource: { buffer: field.albedo } },
        ],
      });
      this.boundTo = field;
    }

    const pass = encoder.beginComputePass({
      label: 'probe bake',
      timestampWrites:
        this.queries === null
          ? undefined
          : { querySet: this.queries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
    });
    pass.setBindGroup(0, this.computeGroup);
    pass.setPipeline(this.tracePipeline);
    pass.dispatchWorkgroups(Math.ceil((scheduled * PROBE_DIRECTIONS) / PROBE_BAKE_WORKGROUP), 1, 1);
    pass.setPipeline(this.convolvePipeline);
    pass.dispatchWorkgroups(Math.ceil((scheduled * this.texels) / PROBE_BAKE_WORKGROUP), 1, 1);
    pass.end();

    if (this.queries !== null && this.queryResolve !== null && this.queryRead !== null) {
      if (!this.queryCopied && !this.queryMapping) {
        encoder.resolveQuerySet(this.queries, 0, 2, this.queryResolve, 0);
        encoder.copyBufferToBuffer(this.queryResolve, 0, this.queryRead, 0, 16);
        this.queryCopied = true;
      }
    }

    for (let slot = 0; slot < scheduled; slot += 1) {
      const layer = this.scheduleScratch[slot] as number;
      const first = this.filled[layer] !== 1 && !seeded;
      /* Every level once for an unseeded layer, then the irradiance level for ever. See above. */
      const from = first ? 0 : this.level;
      for (let level = from; level <= this.level; level += 1) {
        const view = this.views[layer]?.[level];
        if (view === undefined) continue;
        const target = encoder.beginRenderPass({
          label: `probe blit ${String(layer)}.${String(level)}`,
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: BLACK }],
        });
        target.setPipeline(this.blitPipeline);
        target.setBindGroup(0, this.blitGroup, [this.blitOffset(slot, level)]);
        target.draw(3, 1, 0, 0);
        target.end();
      }
      this.filled[layer] = 1;
    }

    this.frameIndex += 1;
    return scheduled;
  }

  dispose(): void {
    this.queries?.destroy();
    this.queryResolve?.destroy();
    this.queryRead?.destroy();
    this.marchBuffer.destroy();
    this.bakeBuffer.destroy();
    this.volumeBuffer.destroy();
    this.scheduleBuffer.destroy();
    this.rayBuffer.destroy();
    this.irradianceBuffer.destroy();
    this.blitParams.destroy();
    this.views = [];
    this.computeGroup = null;
    this.boundTo = null;
  }
}

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
