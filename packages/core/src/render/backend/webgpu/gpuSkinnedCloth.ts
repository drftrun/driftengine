/**
 * A skinned cloth solved on the device: `ClothControl`'s schedule, over buffers rather than arrays.
 *
 * **The CPU solver's steps, as dispatches.** A step is `clothBegin`, then per substep
 * `clothPredict`, every batch of every kind of constraint per iteration, `clothLimit` and
 * `clothFinish`; then `clothBlend` while a reset blends back in. The particles never leave the
 * device: a frame ends with `clothPublish` writing them, at the frame's `alpha`, into the particle
 * texture the bound mesh's vertex stage reads — so a garment costs no upload a frame at all.
 *
 * **One submit a frame, everything it needs written before it.** `queue.writeBuffer` lands ahead of
 * the whole submit rather than between two dispatches, which is the trap `AGENTS.md` (2026-08-27)
 * records for draws and is no different for dispatches. So every step takes a slot of its own, at a
 * dynamic offset, and the batches' ranges are slots written once; a frame that runs out of slots
 * submits what it has first and goes on, and so does a pose, whose matrices are one buffer.
 *
 * **What it gives up**: single precision, and a dispatch per batch — a garment of nine colours and
 * four iterations is about forty dispatches a step, which is cheap on a desktop part and is what the
 * budget in `demo/dev/skinnedCloth.html` measures. Self-collision is accepted and not simulated, as on
 * the CPU.
 */
import { ClothControl, exactExp, validateClothSetup } from '@driftengine/physics';
import type { ClothDevice, SkinnedClothSetup } from '@driftengine/physics';

import { packCloth } from './clothSolvePack.ts';
import type { PackedCloth } from './clothSolvePack.ts';
import { GpuClothParticles } from './clothTextures.ts';
import { CLOTH_SOLVE_WGSL, CLOTH_WORKGROUP } from './shaders/clothSolve.wgsl.ts';
import { shaderModule } from './shaderModules.ts';
import { DYNAMIC_ALIGNMENT } from './uniformRing.ts';

const STORAGE = 0x80;
const UNIFORM = 0x40;
const COPY_DST = 0x8;
const COPY_SRC = 0x4;
const MAP_READ = 0x1;
const COMPUTE = 0x4;

/** Step slots a submit holds before it is sent and the ring starts again. */
const STEP_SLOTS = 64;
/** Floats in a step's slot that are written: see `Step` in the shader. */
const STEP_FLOATS = 32;
const CONSTANT_BYTES = 80;

const ENTRIES = [
  'clothPose',
  'clothRest',
  'clothBegin',
  'clothPredict',
  'clothDistance',
  'clothBending',
  'clothTether',
  'clothLimit',
  'clothFinish',
  'clothBlend',
  'clothPublish',
] as const;
type Entry = (typeof ENTRIES)[number];

/** The layouts and one pipeline an entry point, built once a device and shared by every cloth. */
interface ClothKernels {
  readonly layout: GPUBindGroupLayout;
  readonly outputLayout: GPUBindGroupLayout;
  readonly pipelines: Readonly<Record<Entry, GPUComputePipeline>>;
}

const kernelsByDevice = new WeakMap<GPUDevice, ClothKernels>();

function kernelsFor(device: GPUDevice): ClothKernels {
  const held = kernelsByDevice.get(device);
  if (held !== undefined) return held;
  const uniform = (binding: number, dynamic: boolean): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: COMPUTE,
    buffer: { type: 'uniform', hasDynamicOffset: dynamic },
  });
  const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: COMPUTE,
    buffer: { type },
  });
  const layout = device.createBindGroupLayout({
    label: 'cloth.solve',
    entries: [
      uniform(0, false),
      uniform(1, true),
      uniform(2, true),
      storage(3, 'storage'),
      storage(4, 'storage'),
      storage(5, 'read-only-storage'),
      storage(6, 'read-only-storage'),
      storage(7, 'storage'),
      storage(8, 'read-only-storage'),
    ],
  });
  const outputLayout = device.createBindGroupLayout({
    label: 'cloth.publish',
    entries: [
      {
        binding: 0,
        visibility: COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba32float' },
      },
    ],
  });
  const module = shaderModule(device, { label: 'cloth.solve', code: CLOTH_SOLVE_WGSL });
  const solve = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const publish = device.createPipelineLayout({ bindGroupLayouts: [layout, outputLayout] });
  const pipelines = {} as Record<Entry, GPUComputePipeline>;
  for (const entry of ENTRIES) {
    pipelines[entry] = device.createComputePipeline({
      label: `cloth.${entry}`,
      layout: entry === 'clothPublish' ? publish : solve,
      compute: { module, entryPoint: entry },
    });
  }
  const kernels = { layout, outputLayout, pipelines };
  kernelsByDevice.set(device, kernels);
  return kernels;
}

/** One garment's solver on the device, and the particle textures it publishes into. */
export class GpuSkinnedCloth {
  /** The particles a bound mesh draws by: see `RendererApi.setCloth`. */
  readonly particles: GpuClothParticles;
  readonly count: number;

  private readonly control: ClothControl;
  private readonly packed: PackedCloth;
  private readonly kernels: ClothKernels;
  private readonly buffers: GPUBuffer[] = [];
  private readonly state: GPUBuffer;
  private readonly frameData: GPUBuffer;
  private readonly stepSlots: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly outputs: readonly [GPUBindGroup, GPUBindGroup];
  private readonly frameStaging: Float32Array<ArrayBuffer>;
  private readonly stepStaging = new ArrayBuffer(STEP_FLOATS * 4);
  private readonly stepFloats = new Float32Array(this.stepStaging);
  private readonly stepWords = new Uint32Array(this.stepStaging);
  /** Each batch's slot, by kind and by whether it opens a substep's iterations. */
  private readonly batchSlot: { distance: number; bending: number; tether: number };
  /** The air the steps drag toward: the set-up's until `setWind`, written into every step. */
  private readonly wind = new Float32Array(3);
  private readonly groups: number;
  private readonly substeps: number;
  private readonly iterations: number;

  private encoder: GPUCommandEncoder | null = null;
  private pass: GPUComputePassEncoder | null = null;
  private slot = 0;
  /** Where the pose a step starts from and the one it moves toward sit in `pose`, in floats. */
  private fromAt = 0;
  private toAt = 0;

  constructor(
    private readonly device: GPUDevice,
    setup: SkinnedClothSetup,
  ) {
    validateClothSetup(setup);
    const packed = packCloth(setup);
    this.packed = packed;
    const n = packed.count;
    this.count = n;
    this.kernels = kernelsFor(device);
    this.particles = new GpuClothParticles(device, n, true);
    this.groups = Math.ceil(n / CLOTH_WORKGROUP);

    const solver: ClothDevice = {
      targetsChanged: (change) => {
        this.targetsChanged(change);
      },
      rest: () => {
        this.rest();
      },
      step: (fraction, blend) => {
        this.step(fraction, blend);
      },
    };
    this.control = new ClothControl(setup, solver, false);
    const parameters = this.control.parameters;
    this.wind.set(parameters.wind);
    this.substeps = parameters.substeps;
    this.iterations = parameters.iterations;

    const buffer = (label: string, bytes: number, usage: number): GPUBuffer => {
      const made = device.createBuffer({
        label: `cloth.${label}`,
        size: Math.max(16, bytes),
        usage,
      });
      this.buffers.push(made);
      return made;
    };
    const constants = buffer('constants', CONSTANT_BYTES, UNIFORM | COPY_DST);
    this.stepSlots = buffer('steps', STEP_SLOTS * DYNAMIC_ALIGNMENT, UNIFORM | COPY_DST);
    const batchFloats = this.writeBatches();
    const batches = buffer('batches', batchFloats.byteLength, UNIFORM | COPY_DST);
    this.state = buffer('state', n * 12 * 4, STORAGE | COPY_DST | COPY_SRC);
    const pose = buffer('pose', n * 9 * 4, STORAGE);
    const statics = buffer('statics', packed.statics.byteLength, STORAGE | COPY_DST);
    const constraints = buffer('constraints', packed.constraints.byteLength, STORAGE | COPY_DST);
    const lambda = buffer('lambda', (packed.distances + packed.bendings) * 4, STORAGE);
    this.frameStaging = new Float32Array(packed.joints * 16 + packed.colliders * 8);
    this.frameData = buffer('frame', this.frameStaging.byteLength, STORAGE | COPY_DST);

    const queue = device.queue;
    queue.writeBuffer(constants, 0, this.constants());
    queue.writeBuffer(batches, 0, batchFloats);
    queue.writeBuffer(statics, 0, packed.statics as Float32Array<ArrayBuffer>);
    if (packed.constraints.byteLength > 0) {
      queue.writeBuffer(constraints, 0, packed.constraints as Uint32Array<ArrayBuffer>);
    }
    /* The rest pose until the first `setPose`, which resets the cloth to its own. */
    const state = new Float32Array(n * 12);
    state.set(setup.positions, 0);
    state.set(setup.positions, n * 9);
    queue.writeBuffer(this.state, 0, state);

    const slot = (bufferOf: GPUBuffer): GPUBufferBinding => ({
      buffer: bufferOf,
      size: DYNAMIC_ALIGNMENT,
    });
    this.group = device.createBindGroup({
      label: 'cloth.solve',
      layout: this.kernels.layout,
      entries: [
        { binding: 0, resource: { buffer: constants } },
        { binding: 1, resource: slot(this.stepSlots) },
        { binding: 2, resource: slot(batches) },
        { binding: 3, resource: { buffer: this.state } },
        { binding: 4, resource: { buffer: pose } },
        { binding: 5, resource: { buffer: statics } },
        { binding: 6, resource: { buffer: constraints } },
        { binding: 7, resource: { buffer: lambda } },
        { binding: 8, resource: { buffer: this.frameData } },
      ],
    });
    const output = (k: number): GPUBindGroup =>
      device.createBindGroup({
        label: 'cloth.publish',
        layout: this.kernels.outputLayout,
        entries: [{ binding: 0, resource: this.particles.viewOf(k) }],
      });
    this.outputs = [output(0), output(1)];
    this.batchSlot = {
      distance: 0,
      bending: (packed.distanceBatches.length - 1) * 2,
      tether: (packed.distanceBatches.length - 1 + packed.bendingBatches.length - 1) * 2,
    };
  }

  /**
   * One frame: the rig's pose, `dt` of the caller's time in whole fixed steps, and the particles at
   * the frame's `alpha` published for the draws that follow, as the particles of `frame`.
   */
  advance(globals: Float32Array, model: Float32Array, dt: number, frame: number): void {
    this.control.setPose(globals, model);
    this.control.advance(dt);
    const view = this.particles.publish(frame);
    this.dispatch('clothPublish', this.takeSlot(0, 0, this.control.alpha, null), 0, view);
    this.flush();
  }

  /** The frame's sample of the scene's wind, for the steps to come. See `SkinnedCloth.setWind`. */
  setWind(x: number, y: number, z: number): void {
    this.wind[0] = x;
    this.wind[1] = y;
    this.wind[2] = z;
  }

  /** Back to the skinned pose, settled; the next `advance` publishes it. */
  reset(): void {
    this.control.reset();
  }

  /**
   * The particles where the last step left them, read back: for the parity check, which compares
   * them with the CPU solver's. Not for a frame — it waits on the device.
   */
  async read(): Promise<Float32Array> {
    this.flush();
    const bytes = this.count * 12;
    const readback = this.device.createBuffer({
      label: 'cloth.readback',
      size: bytes,
      usage: MAP_READ | COPY_DST,
    });
    const encoder = this.device.createCommandEncoder({ label: 'cloth.read' });
    encoder.copyBufferToBuffer(this.state, 0, readback, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(MAP_READ);
    const out = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();
    return out;
  }

  /** Its buffers; the particle textures are the renderer's to retire with the frame. */
  dispose(): void {
    this.flush();
    for (const made of this.buffers) made.destroy();
  }

  private targetsChanged(change: 'posed' | 'settled' | 'consumed'): void {
    if (change !== 'posed') {
      this.fromAt = this.toAt;
      return;
    }
    /*
     * The pose's matrices and colliders are written ahead of the next submit, so anything already
     * recorded — a reset's settle steps, which read the colliders — is sent first, or it would run
     * against this pose rather than its own.
     */
    this.flush();
    this.writeFrameData();
    this.fromAt = this.toAt;
    this.toAt = this.toAt === 0 ? this.count * 3 : 0;
    this.dispatch('clothPose', this.takeSlot(0, 0, 0, null), 0, -1);
  }

  private rest(): void {
    this.dispatch('clothRest', this.takeSlot(1, 0, 0, null), 0, -1);
  }

  private step(fraction: number, blend: number): void {
    const at = this.takeSlot(fraction, blend, 0, this.control.targets);
    this.dispatch('clothBegin', at, 0, -1);
    const { distanceBatches, bendingBatches, tetherBatches } = this.packed;
    for (let s = 0; s < this.substeps; s++) {
      this.dispatch('clothPredict', at, 0, -1);
      for (let pass = 0; pass < this.iterations; pass++) {
        const first = pass === 0 ? 1 : 0;
        this.batches('clothDistance', distanceBatches, this.batchSlot.distance, first, at);
        this.batches('clothBending', bendingBatches, this.batchSlot.bending, first, at);
        this.batches('clothTether', tetherBatches, this.batchSlot.tether, first, at);
      }
      this.dispatch('clothLimit', at, 0, -1);
      this.dispatch('clothFinish', at, 0, -1);
    }
    if (blend > 0) this.dispatch('clothBlend', at, 0, -1);
  }

  /** Every batch of one kind, in colour order, each a dispatch over its range. */
  private batches(
    entry: Entry,
    batches: Uint32Array,
    firstSlot: number,
    first: number,
    stepAt: number,
  ): void {
    for (let b = 0; b + 1 < batches.length; b++) {
      const size = (batches[b + 1] as number) - (batches[b] as number);
      if (size === 0) continue;
      const slot = firstSlot + b * 2 + first;
      this.dispatch(entry, stepAt, slot * DYNAMIC_ALIGNMENT, -1, Math.ceil(size / CLOTH_WORKGROUP));
    }
  }

  private dispatch(
    entry: Entry,
    stepAt: number,
    batchAt: number,
    output: number,
    groups = this.groups,
  ): void {
    const pass = this.passFor();
    pass.setPipeline(this.kernels.pipelines[entry]);
    pass.setBindGroup(0, this.group, [stepAt, batchAt]);
    if (output >= 0) pass.setBindGroup(1, this.outputs[output] as GPUBindGroup);
    pass.dispatchWorkgroups(groups);
  }

  private passFor(): GPUComputePassEncoder {
    if (this.pass === null) {
      this.encoder = this.device.createCommandEncoder({ label: 'cloth' });
      this.pass = this.encoder.beginComputePass({ label: 'cloth' });
    }
    return this.pass;
  }

  /** Send what has been recorded: every slot it reads was written ahead of it on the queue. */
  private flush(): void {
    const { pass, encoder } = this;
    if (pass === null || encoder === null) return;
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.pass = null;
    this.encoder = null;
    this.slot = 0;
  }

  /**
   * A step's slot: its fraction, blend and alpha, the poses it reads, and — where `targets` is
   * given — the share of the character's motion the cloth is carried by, as `carryParticles` takes
   * it. Returns the slot's byte offset.
   */
  private takeSlot(
    fraction: number,
    blend: number,
    alpha: number,
    targets: { readonly modelBefore: Float32Array; readonly modelNow: Float32Array } | null,
  ): number {
    if (this.slot === STEP_SLOTS) this.flush();
    const f = this.stepFloats;
    const u = this.stepWords;
    f.fill(0);
    f[0] = fraction;
    f[1] = blend;
    f[2] = alpha;
    u[4] = this.fromAt;
    u[5] = this.toAt;
    f.set(this.wind, 28);
    if (targets !== null) this.writeCarry(targets.modelBefore, targets.modelNow);
    const at = this.slot * DYNAMIC_ALIGNMENT;
    this.device.queue.writeBuffer(this.stepSlots, at, this.stepStaging);
    this.slot++;
    return at;
  }

  /** `carryParticles`' rotation, origin and move, into the step's slot; carry 0 where none. */
  private writeCarry(previous: Float32Array, next: Float32Array): void {
    const { linearInertia, angularInertia } = this.control.parameters;
    const turn = 1 - angularInertia;
    const move = 1 - linearInertia;
    if (turn === 0 && move === 0) return;
    const f = this.stepFloats;
    this.stepWords[3] = 1;
    /* Column c of R = R_next × R_previousᵀ, at turn0 … turn2. */
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) {
          sum += (next[k * 4 + row] as number) * (previous[k * 4 + col] as number);
        }
        f[8 + col * 4 + row] = sum;
      }
    }
    for (let k = 0; k < 3; k++) {
      f[20 + k] = previous[12 + k] as number;
      f[24 + k] = ((next[12 + k] as number) - (previous[12 + k] as number)) * move;
    }
    f[23] = turn;
  }

  /** The pose's skin matrices — or the model, for a cloth with no rig — and its colliders. */
  private writeFrameData(): void {
    const targets = this.control.targets;
    const out = this.frameStaging;
    const joints = this.packed.joints;
    out.set(this.packed.rigged && targets.skin !== null ? targets.skin : targets.model, 0);
    const colliders = this.packed.colliders;
    out.set(targets.colliderEnds, joints * 16);
    out.set(targets.colliderRadii, joints * 16 + colliders * 6);
    if (out.byteLength > 0) this.device.queue.writeBuffer(this.frameData, 0, out);
  }

  private constants(): ArrayBuffer {
    const p = this.control.parameters;
    const packed = this.packed;
    const bytes = new ArrayBuffer(CONSTANT_BYTES);
    const u = new Uint32Array(bytes);
    const f = new Float32Array(bytes);
    const h = p.step / p.substeps;
    u[0] = packed.count;
    u[1] = packed.distances;
    u[2] = packed.bendings;
    u[3] = packed.joints;
    u[4] = packed.colliders;
    u[5] = packed.limits;
    u[6] = this.particles.width;
    f[8] = h;
    f[9] = 1 / h;
    f[10] = 1 / (h * h);
    f[11] = exactExp(p.damping * h);
    f[12] = exactExp(p.drag * h);
    f[13] = p.maxDistanceScale;
    f[14] = p.margin;
    f.set(p.gravity, 16);
    return bytes;
  }

  /** Each batch's range, twice — opening a substep's iterations and not — at a slot each. */
  private writeBatches(): Uint32Array<ArrayBuffer> {
    const { distanceBatches, bendingBatches, tetherBatches } = this.packed;
    const kinds = [distanceBatches, bendingBatches, tetherBatches];
    const slots = kinds.reduce((sum, batches) => sum + (batches.length - 1) * 2, 0);
    const words = new Uint32Array((Math.max(1, slots) * DYNAMIC_ALIGNMENT) / 4);
    let slot = 0;
    for (const batches of kinds) {
      for (let b = 0; b + 1 < batches.length; b++) {
        for (let first = 0; first < 2; first++) {
          const at = (slot * DYNAMIC_ALIGNMENT) / 4;
          words[at] = batches[b] as number;
          words[at + 1] = batches[b + 1] as number;
          words[at + 2] = first;
          slot++;
        }
      }
    }
    return words;
  }
}
