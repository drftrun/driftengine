/**
 * Where every mover was last frame, drawn into the reconstruction's motion target.
 *
 * Moved out of `renderer.ts` when it grew variants: the renderer decides *which* draws moved and
 * hands them here; this owns how their motion is drawn. See `shaders/recon/motion.wgsl.ts` for what
 * a texel carries, why it is a pass of its own, and why its matrices are unjittered.
 */
import { DEPTH_COMPARE_EQUAL, DEPTH_FORMAT } from '../../depthConvention.ts';
import {
  MOTION_DRAW_FLOATS,
  MOTION_DRAW_STRIDE,
  MOTION_FRAME_FLOATS,
  MOTION_TARGET_FORMAT,
  RECON_MOTION_WGSL,
} from '../../shaders/recon/motion.wgsl.ts';
import { INSTANCE_STRIDE } from '../../instances.ts';
import type { GpuMesh } from './buffers.ts';

/** What a record is, which decides the vertex stage and what else it binds. */
const RIGID = 0;
const SKINNED = 1;
const DYNAMIC = 2;
const INSTANCED = 3;

/** An instanced record's per-draw matrices are not read; this fills their slot. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class MotionPass {
  private readonly device: GPUDevice;
  /** The frame's movers, in the order they were drawn. */
  private readonly meshes: GpuMesh[] = [];
  /** Two matrices a mover — this frame's model and last frame's — at `MOTION_DRAW_FLOATS` apart. */
  private matrices = new Float32Array(0);
  private count = 0;
  /** `RIGID` or `SKINNED` per record, grown beside `matrices`. */
  private kinds = new Uint8Array(0);
  /** A skinned record's two palettes, this frame's and last frame's, by record index. */
  private readonly paletteNow: (GPUTextureView | null)[] = [];
  private readonly paletteWas: (GPUTextureView | null)[] = [];
  /** A rewritten record's last-frame rows, by record index. */
  private readonly previousRows: (GPUBuffer | null)[] = [];
  /** One pipeline per stride for rewritten meshes: current and previous rows at that stride. */
  private readonly dynamicPipelines = new Map<number, GPURenderPipeline>();
  /** An instanced record's placement this frame and last frame, and how many slots pair. */
  private readonly instancesNow: (GPUBuffer | null)[] = [];
  private readonly instancesWas: (GPUBuffer | null)[] = [];
  private instanceCounts = new Uint32Array(0);
  private readonly instancedPipelines = new Map<number, GPURenderPipeline>();
  private layout: GPUBindGroupLayout | null = null;
  private paletteLayout: GPUBindGroupLayout | null = null;
  private skinnedLayout: GPUPipelineLayout | null = null;
  /** Keyed by stride and the two skin offsets, packed into one number so a lookup builds nothing. */
  private readonly skinnedPipelines = new Map<number, GPURenderPipeline>();
  /**
   * A bind group per pair of palette views. The ring keeps its textures from frame to frame, so a
   * steady scene settles on a handful of pairs and builds nothing per frame.
   */
  private readonly paletteGroups = new Map<GPUTextureView, Map<GPUTextureView, GPUBindGroup>>();
  private module: GPUShaderModule | null = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  private readonly pipelines = new Map<number, GPURenderPipeline>();
  private frameBuffer: GPUBuffer | null = null;
  private drawBuffer: GPUBuffer | null = null;
  private drawCapacity = 0;
  private group: GPUBindGroup | null = null;
  private readonly frameStaging = new Float32Array(MOTION_FRAME_FLOATS);
  private drawStaging = new Uint8Array(0);
  /** A float view of `drawStaging`, made when it is, so a frame's upload allocates nothing. */
  private drawFloats = new Float32Array(0);

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** A frame states its movers afresh. */
  reset(): void {
    this.count = 0;
  }

  /** A rigid mover: the same positions under last frame's model. */
  recordRigid(mesh: GpuMesh, model: ArrayLike<number>, previousModel: ArrayLike<number>): void {
    this.take(mesh, model, previousModel, RIGID);
  }

  /** A skinned mover: its positions under last frame's pose as well as last frame's model. */
  recordSkinned(
    mesh: GpuMesh,
    model: ArrayLike<number>,
    previousModel: ArrayLike<number>,
    palette: GPUTextureView,
    previousPalette: GPUTextureView,
  ): void {
    const at = this.take(mesh, model, previousModel, SKINNED);
    this.paletteNow[at] = palette;
    this.paletteWas[at] = previousPalette;
  }

  /** A rewritten mesh: its vertices as they were, read from `previous`, under last frame's model. */
  recordDynamic(
    mesh: GpuMesh,
    model: ArrayLike<number>,
    previousModel: ArrayLike<number>,
    previous: GPUBuffer,
  ): void {
    const at = this.take(mesh, model, previousModel, DYNAMIC);
    this.previousRows[at] = previous;
  }

  /** An instanced batch: its first `count` slots, each under last frame's placement of that slot. */
  recordInstanced(
    mesh: GpuMesh,
    placement: GPUBuffer,
    previousPlacement: GPUBuffer,
    count: number,
  ): void {
    const at = this.take(mesh, IDENTITY, IDENTITY, INSTANCED);
    this.instancesNow[at] = placement;
    this.instancesWas[at] = previousPlacement;
    this.instanceCounts[at] = count;
  }

  /** One record's slot: its mesh, its two matrices and its kind. Returns the record's index. */
  private take(
    mesh: GpuMesh,
    model: ArrayLike<number>,
    previousModel: ArrayLike<number>,
    kind: number,
  ): number {
    const at = this.count;
    const wanted = (at + 1) * MOTION_DRAW_FLOATS;
    if (this.matrices.length < wanted) {
      /* Doubling, so a scene settles on one allocation rather than one a draw. */
      const grown = new Float32Array(Math.max(wanted, this.matrices.length * 2, 64));
      grown.set(this.matrices);
      this.matrices = grown;
      const kinds = new Uint8Array(grown.length / MOTION_DRAW_FLOATS);
      kinds.set(this.kinds);
      this.kinds = kinds;
      const counts = new Uint32Array(kinds.length);
      counts.set(this.instanceCounts);
      this.instanceCounts = counts;
    }
    this.matrices.set(model as ArrayLike<number> & Iterable<number>, at * MOTION_DRAW_FLOATS);
    this.matrices.set(
      previousModel as ArrayLike<number> & Iterable<number>,
      at * MOTION_DRAW_FLOATS + 16,
    );
    this.meshes[at] = mesh;
    this.kinds[at] = kind;
    this.count = at + 1;
    return at;
  }

  /**
   * The pipeline layout and module, built once.
   *
   * **The position alone**, at offset zero of the mesh's interleaved rows: that is all the rigid
   * stage reads, and positions are the layout's first attribute and never optional.
   */
  private buildLayout(): void {
    if (this.layout !== null) return;
    this.layout = this.device.createBindGroupLayout({
      label: 'recon.motion.layout',
      entries: [
        { binding: 0, visibility: 0x1, buffer: { type: 'uniform' as const } },
        {
          binding: 1,
          visibility: 0x1,
          buffer: { type: 'uniform' as const, hasDynamicOffset: true },
        },
      ],
    });
    this.module = this.device.createShaderModule({
      label: 'recon.motion',
      code: RECON_MOTION_WGSL,
    });
    this.pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.layout],
    });
    /* The two palettes, read with `textureLoad` at integer texels: unfilterable is exact. */
    this.paletteLayout = this.device.createBindGroupLayout({
      label: 'recon.motion.palettes',
      entries: [
        { binding: 0, visibility: 0x1, texture: { sampleType: 'unfilterable-float' as const } },
        { binding: 1, visibility: 0x1, texture: { sampleType: 'unfilterable-float' as const } },
      ],
    });
    this.skinnedLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.layout, this.paletteLayout],
    });
  }

  /**
   * The skinned pipeline for one stride and one placement of the joints and weights in it.
   *
   * Same fragment stage, winding and depth test as the rigid one — see `pipelineFor` — with the two
   * skinning attributes read from the interleaved rows at the offsets the mesh records.
   */
  private skinnedPipelineFor(
    stride: number,
    offsets: { readonly joints: number; readonly weights: number },
  ): GPURenderPipeline | null {
    const key = (stride * 4096 + offsets.joints) * 4096 + offsets.weights;
    const held = this.skinnedPipelines.get(key);
    if (held !== undefined) return held;
    const module = this.module;
    const layout = this.skinnedLayout;
    if (module === null || layout === null) return null;
    const pipeline = this.device.createRenderPipeline({
      label: `recon.motion.skinned.${String(stride)}`,
      layout,
      vertex: {
        module,
        entryPoint: 'motionSkinnedVert',
        buffers: [
          {
            arrayStride: stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 11, offset: offsets.joints, format: 'float32x4' },
              { shaderLocation: 12, offset: offsets.weights, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'motionFrag', targets: [{ format: MOTION_TARGET_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: DEPTH_COMPARE_EQUAL,
      },
    });
    this.skinnedPipelines.set(key, pipeline);
    return pipeline;
  }

  /** The rewritten pipeline for one stride: position from each of two buffers of that stride. */
  private dynamicPipelineFor(stride: number): GPURenderPipeline | null {
    const held = this.dynamicPipelines.get(stride);
    if (held !== undefined) return held;
    const module = this.module;
    const layout = this.pipelineLayout;
    if (module === null || layout === null) return null;
    const pipeline = this.device.createRenderPipeline({
      label: `recon.motion.dynamic.${String(stride)}`,
      layout,
      vertex: {
        module,
        entryPoint: 'motionDynamicVert',
        buffers: [
          {
            arrayStride: stride,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
          {
            arrayStride: stride,
            attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: { module, entryPoint: 'motionFrag', targets: [{ format: MOTION_TARGET_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: DEPTH_COMPARE_EQUAL,
      },
    });
    this.dynamicPipelines.set(stride, pipeline);
    return pipeline;
  }

  /**
   * The instanced pipeline for one mesh stride: the mesh's positions, then this frame's and last
   * frame's placements, one matrix an instance, as the scene's instanced stage reads them.
   */
  private instancedPipelineFor(stride: number): GPURenderPipeline | null {
    const held = this.instancedPipelines.get(stride);
    if (held !== undefined) return held;
    const module = this.module;
    const layout = this.pipelineLayout;
    if (module === null || layout === null) return null;
    const placement = (first: number): GPUVertexBufferLayout => ({
      arrayStride: INSTANCE_STRIDE,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: first, offset: 0, format: 'float32x4' },
        { shaderLocation: first + 1, offset: 16, format: 'float32x4' },
        { shaderLocation: first + 2, offset: 32, format: 'float32x4' },
        { shaderLocation: first + 3, offset: 48, format: 'float32x4' },
      ],
    });
    const pipeline = this.device.createRenderPipeline({
      label: `recon.motion.instanced.${String(stride)}`,
      layout,
      vertex: {
        module,
        entryPoint: 'motionInstancedVert',
        buffers: [
          {
            arrayStride: stride,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
          placement(2),
          placement(6),
        ],
      },
      fragment: { module, entryPoint: 'motionFrag', targets: [{ format: MOTION_TARGET_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: DEPTH_COMPARE_EQUAL,
      },
    });
    this.instancedPipelines.set(stride, pipeline);
    return pipeline;
  }

  /** The bind group holding one pair of palettes, built the first time the pair is seen. */
  private paletteGroup(now: GPUTextureView, was: GPUTextureView): GPUBindGroup | null {
    const layout = this.paletteLayout;
    if (layout === null) return null;
    let byWas = this.paletteGroups.get(now);
    if (byWas === undefined) {
      byWas = new Map();
      this.paletteGroups.set(now, byWas);
    }
    let group = byWas.get(was);
    if (group === undefined) {
      group = this.device.createBindGroup({
        label: 'recon.motion.palettes',
        layout,
        entries: [
          { binding: 0, resource: now },
          { binding: 1, resource: was },
        ],
      });
      byWas.set(was, group);
    }
    return group;
  }

  /** The pipeline for one vertex stride, built on first sight of it. */
  private pipelineFor(stride: number): GPURenderPipeline | null {
    const held = this.pipelines.get(stride);
    if (held !== undefined) return held;
    const module = this.module;
    const layout = this.pipelineLayout;
    if (module === null || layout === null) return null;
    const pipeline = this.device.createRenderPipeline({
      label: `recon.motion.${String(stride)}`,
      layout,
      vertex: {
        module,
        entryPoint: 'motionVert',
        buffers: [
          {
            arrayStride: stride,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: { module, entryPoint: 'motionFrag', targets: [{ format: MOTION_TARGET_FORMAT }] },
      /*
       * **The scene's own winding**, because this draws the scene's geometry through the scene's
       * clip transform — the product the renderer hands over already carries the negation that
       * `naga` writes into every generated vertex stage, so the faces come out the way they did
       * and a `cw` front face here would draw the inside of every mesh. §3 row 57.
       */
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: DEPTH_FORMAT,
        /*
         * **Tested and not written.** The frame's depth is finished; this pass only wants the
         * pixels the scene actually kept, and `DEPTH_COMPARE_EQUAL` is the comparison that admits
         * exactly them — the same transform on the same positions gives the same depth, which is
         * why the rasterisation matrix is handed over whole rather than rebuilt here.
         *
         * **And the equality is not fragile here**, which was worth measuring rather than
         * assuming: this driver contracts multiply-adds (§3 row 107) and two shader modules can
         * contract a matrix product differently, so an equality across them could have admitted
         * only some of a surface. Run with `greater-equal` instead, the ghost measured the same
         * to the pixel — 5,942 either way — so nothing is being dropped.
         */
        depthWriteEnabled: false,
        depthCompare: DEPTH_COMPARE_EQUAL,
      },
    });
    this.pipelines.set(stride, pipeline);
    return pipeline;
  }

  /**
   * Every mover of the frame, into `target`, tested against the finished `depth`.
   *
   * **After everything that draws and before the resolve reads it.** `raster` is the scene's clip
   * transform with the generated stages' y negation folded in; `viewProj` and `previousViewProj`
   * are this frame's and last frame's unjittered view-projections.
   *
   * **Cleared every frame, even when nothing moved.** A texel left from last frame is a flag saying
   * "a draw wrote this", and the resolve would take a motion belonging to a surface that is no
   * longer there. The clear is the pass's own load operation, so an empty frame still runs it.
   */
  run(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    depth: GPUTextureView,
    raster: Float32Array,
    viewProj: Float32Array,
    previousViewProj: Float32Array,
    timestampWrites: GPURenderPassTimestampWrites | undefined,
  ): void {
    this.buildLayout();
    const layout = this.layout;
    if (layout === null) return;
    const pass = encoder.beginRenderPass({
      label: 'recon.motion',
      timestampWrites,
      colorAttachments: [
        { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
      depthStencilAttachment: {
        view: depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        depthReadOnly: false,
      },
    });

    const count = this.count;
    if (count > 0) {
      const bytes = count * MOTION_DRAW_STRIDE;
      if (this.drawCapacity < count) {
        this.drawBuffer?.destroy();
        this.drawCapacity = Math.max(count, this.drawCapacity * 2, 16);
        this.drawBuffer = this.device.createBuffer({
          label: 'recon.motion.draws',
          size: this.drawCapacity * MOTION_DRAW_STRIDE,
          usage: 0x40 | 0x8, // UNIFORM | COPY_DST
        });
        this.drawStaging = new Uint8Array(this.drawCapacity * MOTION_DRAW_STRIDE);
        this.drawFloats = new Float32Array(this.drawStaging.buffer);
        this.group = null;
      }
      this.frameBuffer ??= this.device.createBuffer({
        label: 'recon.motion.frame',
        size: MOTION_FRAME_FLOATS * 4,
        usage: 0x40 | 0x8,
      });
      this.group ??= this.device.createBindGroup({
        label: 'recon.motion.group',
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuffer } },
          {
            binding: 1,
            resource: { buffer: this.drawBuffer as GPUBuffer, size: MOTION_DRAW_STRIDE },
          },
        ],
      });

      this.frameStaging.set(raster, 0);
      this.frameStaging.set(viewProj, 16);
      this.frameStaging.set(previousViewProj, 32);
      this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameStaging);

      /* Copied a float at a time rather than through `subarray`, which is a view allocated per
         mover per frame. */
      for (let i = 0; i < count; i += 1) {
        const from = i * MOTION_DRAW_FLOATS;
        const to = (i * MOTION_DRAW_STRIDE) / 4;
        for (let k = 0; k < MOTION_DRAW_FLOATS; k += 1) {
          this.drawFloats[to + k] = this.matrices[from + k] as number;
        }
      }
      this.device.queue.writeBuffer(this.drawBuffer as GPUBuffer, 0, this.drawStaging, 0, bytes);

      let bound: GPURenderPipeline | null = null;
      for (let i = 0; i < count; i += 1) {
        const mesh = this.meshes[i];
        if (mesh === undefined) continue;
        const kind = this.kinds[i];
        let pipeline: GPURenderPipeline | null = null;
        let instances = 1;
        if (kind === INSTANCED) {
          const now = this.instancesNow[i] ?? null;
          const was = this.instancesWas[i] ?? null;
          if (now === null || was === null) continue;
          pipeline = this.instancedPipelineFor(mesh.vertexStride);
          pass.setVertexBuffer(1, now);
          pass.setVertexBuffer(2, was);
          instances = this.instanceCounts[i] ?? 0;
        } else if (kind === DYNAMIC) {
          const previous = this.previousRows[i] ?? null;
          if (previous === null) continue;
          pipeline = this.dynamicPipelineFor(mesh.vertexStride);
          pass.setVertexBuffer(1, previous);
        } else if (kind === SKINNED) {
          const offsets = mesh.skinOffsets;
          const now = this.paletteNow[i] ?? null;
          const was = this.paletteWas[i] ?? null;
          if (offsets === null || now === null || was === null) continue;
          pipeline = this.skinnedPipelineFor(mesh.vertexStride, offsets);
          const palettes = this.paletteGroup(now, was);
          if (pipeline === null || palettes === null) continue;
          pass.setBindGroup(1, palettes);
        } else {
          pipeline = this.pipelineFor(mesh.vertexStride);
        }
        if (pipeline === null) continue;
        if (pipeline !== bound) {
          pass.setPipeline(pipeline);
          bound = pipeline;
        }
        pass.setBindGroup(0, this.group, [i * MOTION_DRAW_STRIDE]);
        pass.setVertexBuffer(0, mesh.vertexBuffers[0] as GPUBuffer);
        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
        pass.drawIndexed(mesh.indexCount, instances);
      }
    }
    pass.end();
  }

  dispose(): void {
    this.paletteGroups.clear();
    this.frameBuffer?.destroy();
    this.drawBuffer?.destroy();
    this.frameBuffer = null;
    this.drawBuffer = null;
    this.drawCapacity = 0;
    this.group = null;
  }
}
