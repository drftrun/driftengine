/**
 * Skinned cloth solved on the device, a set of garments at a time: `ClothControl`'s schedule for
 * each garment, over one set of buffers, in one compute pass and one submit a frame.
 *
 * **The CPU solver's steps, as dispatches.** A step is `clothBegin`, then per substep
 * `clothPredict`, every colour of every kind of constraint per iteration, `clothLimit` and
 * `clothFinish`; then `clothBlend` while a reset blends back in. The particles never leave the
 * device: a frame ends with `clothPublish` writing each garment's, at the frame's `alpha`, into the
 * particle texture its bound meshes' vertex stage reads — so a garment costs no upload a frame.
 *
 * **A round is one kind of work for every garment that has it next.** Each garment's control asks
 * for poses, resets and steps as it always did; they wait in its queue (`clothOps.ts`) until the
 * set records them a round at a time — the poses of every garment with a pose next, in one
 * dispatch, then the rests, then a step for every garment with a step next, each colour of each kind
 * one dispatch across the set (`clothSetPack.ts`). A garment with nothing of that kind sits the round
 * out. So a step costs one garment's dispatches whatever the set holds: fifteen garments of nine
 * colours at four iterations are about a hundred a step, where a pass a garment was some fourteen
 * hundred.
 *
 * **One submit a frame, everything it needs written before it.** `queue.writeBuffer` lands ahead of
 * the whole submit rather than between two dispatches, which is the trap `AGENTS.md` (2026-08-27)
 * records for draws and is no different here. So every round's records take a slot of their own, a
 * frame that runs out of slots submits what it has and goes on, and a garment posed while work
 * against its last pose is still unsent sends that work first, since its matrices are one region.
 *
 * **What it gives up**: single precision; a colour dispatched over the most records any garment has
 * in it; and garments of one set step together, so they share a step, substeps, iterations and most
 * steps a frame, refused by name otherwise. Self-collision is accepted and not simulated, as on the
 * CPU.
 */
import { ClothControl, exactExp, validateClothSetup } from '@driftengine/physics';
import type { ClothDevice, SkinnedClothSetup } from '@driftengine/physics';

import { clothKernelsFor } from './clothKernels.ts';
import type { ClothEntry, ClothKernels } from './clothKernels.ts';
import {
  CLOTH_OP_POSE,
  CLOTH_OP_REST,
  CLOTH_OP_STEP,
  ClothOps,
  PACE_HEAD_WORDS,
  PACE_WORDS,
} from './clothOps.ts';
import {
  CLOTH_CONSTANT_BYTES,
  clothBatchSlots,
  clothConstants,
  clothRoundOffsets,
  writeClothCarry,
} from './clothSetLayout.ts';
import { packClothSet } from './clothSetPack.ts';
import type { ClothGarmentRange, PackedClothSet } from './clothSetPack.ts';
import { packCloth } from './clothSolvePack.ts';
import { GpuClothParticles } from './clothTextures.ts';
import { CLOTH_WORKGROUP } from './shaders/clothSolve.wgsl.ts';
import { DYNAMIC_ALIGNMENT } from './uniformRing.ts';

const STORAGE = 0x80;
const UNIFORM = 0x40;
const COPY_DST = 0x8;
const COPY_SRC = 0x4;
const MAP_READ = 0x1;

/** Rounds a submit holds before it is sent and the slots start again. */
const ROUNDS = 64;
const KINDS = [CLOTH_OP_POSE, CLOTH_OP_REST, CLOTH_OP_STEP] as const;

/** One garment of a set: its schedule, its queue and where it sits. */
interface Garment {
  readonly range: ClothGarmentRange;
  readonly control: ClothControl;
  readonly particles: GpuClothParticles;
  readonly ops: ClothOps;
  /** The air its steps drag toward: the set-up's until `setWind`. */
  readonly wind: Float32Array;
  readonly outputs: readonly [GPUBindGroup, GPUBindGroup];
  /** Where the pose a step starts from and the one it moves toward sit in `pose`, in floats. */
  fromAt: number;
  toAt: number;
  /** Work recorded against its pose that has not been sent. */
  recorded: boolean;
}

export class GpuClothSet {
  private readonly garments: Garment[] = [];
  private readonly packed: PackedClothSet;
  private readonly kernels: ClothKernels;
  private readonly buffers: GPUBuffer[] = [];
  private readonly state: GPUBuffer;
  private readonly frameData: GPUBuffer;
  private readonly paces: GPUBuffer;
  private readonly group: GPUBindGroup;
  /** One round's records, every garment's: the head an op's, the rest each garment's own. */
  private readonly staging: ArrayBuffer;
  private readonly stagingWords: Uint32Array;
  private readonly stagingFloats: Float32Array;
  /** Each kind's first batch slot, and the first garment's publishing slot. */
  private readonly batchSlot: {
    distance: number;
    bending: number;
    tether: number;
    publish: number;
  };
  private readonly groups: number;
  private readonly substeps: number;
  private readonly iterations: number;

  private encoder: GPUCommandEncoder | null = null;
  private pass: GPUComputePassEncoder | null = null;
  private round = 0;

  constructor(
    private readonly device: GPUDevice,
    setups: readonly SkinnedClothSetup[],
  ) {
    if (setups.length === 0) throw new Error('skinned cloth set: no garments');
    for (const setup of setups) validateClothSetup(setup);
    const packed = packClothSet(setups.map(packCloth));
    this.packed = packed;
    const n = packed.count;
    const count = setups.length;
    this.kernels = clothKernelsFor(device);
    this.groups = Math.ceil(n / CLOTH_WORKGROUP);

    const buffer = (label: string, bytes: number, usage: number): GPUBuffer => {
      const made = device.createBuffer({
        label: `cloth.${label}`,
        size: Math.max(16, bytes),
        usage,
      });
      this.buffers.push(made);
      return made;
    };
    this.staging = new ArrayBuffer(count * PACE_WORDS * 4);
    this.stagingWords = new Uint32Array(this.staging);
    this.stagingFloats = new Float32Array(this.staging);
    setups.forEach((setup, g) => this.garments.push(this.garment(setup, g)));
    const first = (this.garments[0] as Garment).control.parameters;
    this.substeps = first.substeps;
    this.iterations = first.iterations;
    this.refuseStrangers(first);

    const constants = buffer('constants', CLOTH_CONSTANT_BYTES, UNIFORM | COPY_DST);
    const rounds = buffer('rounds', ROUNDS * DYNAMIC_ALIGNMENT, UNIFORM | COPY_DST);
    this.paces = buffer('paces', ROUNDS * this.staging.byteLength, STORAGE | COPY_DST);
    const batchWords = clothBatchSlots(packed);
    const batches = buffer('batches', batchWords.byteLength, UNIFORM | COPY_DST);
    this.state = buffer('state', n * 12 * 4, STORAGE | COPY_DST | COPY_SRC);
    const pose = buffer('pose', n * 9 * 4, STORAGE);
    const statics = buffer('statics', packed.statics.byteLength, STORAGE | COPY_DST);
    const constraints = buffer('constraints', packed.constraints.byteLength, STORAGE | COPY_DST);
    const lambda = buffer('lambda', (packed.distances + packed.bendings) * 4, STORAGE);
    this.frameData = buffer(
      'frame',
      (packed.joints * 16 + packed.colliders * 8) * 4,
      STORAGE | COPY_DST,
    );

    const queue = device.queue;
    queue.writeBuffer(constants, 0, clothConstants(packed, first.step / first.substeps));
    queue.writeBuffer(rounds, 0, clothRoundOffsets(ROUNDS, count));
    queue.writeBuffer(batches, 0, batchWords);
    queue.writeBuffer(statics, 0, packed.statics as Float32Array<ArrayBuffer>);
    if (packed.constraints.byteLength > 0) {
      queue.writeBuffer(constraints, 0, packed.constraints as Uint32Array<ArrayBuffer>);
    }
    /* The rest pose until the first pose, which resets each garment to its own. */
    const state = new Float32Array(n * 12);
    setups.forEach((setup, g) => {
      const base = (this.garments[g] as Garment).range.particleBase * 3;
      state.set(setup.positions, base);
      state.set(setup.positions, n * 9 + base);
    });
    queue.writeBuffer(this.state, 0, state);

    const slot = (of: GPUBuffer): GPUBufferBinding => ({ buffer: of, size: DYNAMIC_ALIGNMENT });
    this.group = device.createBindGroup({
      label: 'cloth.solve',
      layout: this.kernels.layout,
      entries: [
        { binding: 0, resource: { buffer: constants } },
        { binding: 1, resource: slot(rounds) },
        { binding: 2, resource: slot(batches) },
        { binding: 3, resource: { buffer: this.state } },
        { binding: 4, resource: { buffer: pose } },
        { binding: 5, resource: { buffer: statics } },
        { binding: 6, resource: { buffer: constraints } },
        { binding: 7, resource: { buffer: lambda } },
        { binding: 8, resource: { buffer: this.frameData } },
        { binding: 9, resource: { buffer: this.paces } },
      ],
    });
    const colours = (batches: Uint32Array): number => (batches.length - 1) * 2;
    this.batchSlot = {
      distance: 0,
      bending: colours(packed.distanceBatches),
      tether: colours(packed.distanceBatches) + colours(packed.bendingBatches),
      publish:
        colours(packed.distanceBatches) +
        colours(packed.bendingBatches) +
        colours(packed.tetherBatches),
    };
  }

  /** How many garments the set holds. */
  get size(): number {
    return this.garments.length;
  }

  /** Garment `g`'s particles, what `setCloth` draws its bound meshes by. */
  particles(g: number): GpuClothParticles {
    return this.at(g).particles;
  }

  /** Garment `g`'s rig for the steps to come; see `ClothControl.setPose`. */
  setPose(g: number, globals: Float32Array, model: Float32Array): void {
    this.at(g).control.setPose(globals, model);
  }

  /** The frame's sample of the scene's wind for garment `g`. See `SkinnedCloth.setWind`. */
  setWind(g: number, x: number, y: number, z: number): void {
    const wind = this.at(g).wind;
    wind[0] = x;
    wind[1] = y;
    wind[2] = z;
  }

  /** Garment `g` back to its skinned pose, settled; the next `step` publishes it. */
  reset(g: number): void {
    this.at(g).control.reset();
  }

  /**
   * `dt` of the caller's time in whole fixed steps for every garment, and each garment's particles
   * at its `alpha` published for the draws that follow, as the particles of `frame`.
   */
  step(dt: number, frame: number): void {
    const garments = this.garments;
    for (let g = 0; g < garments.length; g++) (garments[g] as Garment).control.advance(dt);
    this.run();
    const at = this.takeRound();
    for (let g = 0; g < garments.length; g++) {
      const base = g * PACE_WORDS;
      const garment = garments[g] as Garment;
      this.stagingWords.fill(0, base, base + PACE_HEAD_WORDS);
      this.stagingFloats[base + 2] = garment.control.alpha;
      this.stagingFloats.set(garment.wind, base + 28);
    }
    this.device.queue.writeBuffer(this.paces, this.paceOffset(at), this.staging);
    for (let g = 0; g < garments.length; g++) {
      const garment = garments[g] as Garment;
      const view = garment.particles.publish(frame);
      const slot = (this.batchSlot.publish + g) * DYNAMIC_ALIGNMENT;
      const groups = Math.ceil(garment.range.count / CLOTH_WORKGROUP);
      this.dispatch('clothPublish', at, slot, garment.outputs[view] as GPUBindGroup, groups);
    }
    this.flush();
  }

  /**
   * Garment `g`'s particles where its last step left them, three floats each: for the parity check,
   * which compares them with the CPU solver's positions. Not for a frame — it waits on the device.
   */
  async read(g: number): Promise<Float32Array> {
    this.run();
    this.flush();
    const { particleBase, count } = this.at(g).range;
    const bytes = count * 12;
    const readback = this.device.createBuffer({
      label: 'cloth.readback',
      size: bytes,
      usage: MAP_READ | COPY_DST,
    });
    const encoder = this.device.createCommandEncoder({ label: 'cloth.read' });
    encoder.copyBufferToBuffer(this.state, particleBase * 12, readback, 0, bytes);
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

  private at(g: number): Garment {
    const garment = this.garments[g];
    if (garment === undefined) throw new Error(`skinned cloth set: no garment ${g}`);
    return garment;
  }

  /** Garment `g`: its schedule over a device that queues, its particles and its own numbers. */
  private garment(setup: SkinnedClothSetup, g: number): Garment {
    const range = this.packed.garments[g] as ClothGarmentRange;
    const particles = new GpuClothParticles(this.device, range.count, true);
    const ops = new ClothOps();
    const solver: ClothDevice = {
      targetsChanged: (change) => this.targetsChanged(garment, change),
      rest: () => this.queueOp(garment, CLOTH_OP_REST),
      step: (fraction, blend) => this.queueStep(garment, fraction, blend),
    };
    const control = new ClothControl(setup, solver, false);
    const output = (k: number): GPUBindGroup =>
      this.device.createBindGroup({
        label: 'cloth.publish',
        layout: this.kernels.outputLayout,
        entries: [{ binding: 0, resource: particles.viewOf(k) }],
      });
    const garment: Garment = {
      range,
      control,
      particles,
      ops,
      wind: new Float32Array(control.parameters.wind),
      outputs: [output(0), output(1)],
      fromAt: 0,
      toAt: 0,
      recorded: false,
    };
    this.writeOwn(garment, g);
    return garment;
  }

  /**
   * A garment's own words of its record, which every round carries: its colliders, its texture's
   * width and its constants. Its limits ride in the head beside `live`, written as it joins a round.
   */
  private writeOwn(garment: Garment, g: number): void {
    const p = garment.control.parameters;
    const h = p.step / p.substeps;
    const base = g * PACE_WORDS;
    const u = this.stagingWords;
    const f = this.stagingFloats;
    u[base + 32] = garment.range.colliderBase;
    u[base + 33] = garment.range.colliders;
    u[base + 34] = garment.particles.width;
    f[base + 36] = exactExp(p.damping * h);
    f[base + 37] = exactExp(p.drag * h);
    f[base + 38] = p.maxDistanceScale;
    f[base + 39] = p.margin;
    f.set(p.gravity, base + 40);
  }

  /** Garments that cannot step together, refused by the first number they disagree on. */
  private refuseStrangers(first: ClothControl['parameters']): void {
    this.garments.forEach((garment, g) => {
      const p = garment.control.parameters;
      for (const name of ['step', 'substeps', 'iterations', 'maxSteps'] as const) {
        if (p[name] !== first[name]) {
          throw new Error(
            `skinned cloth set: garment ${g} has ${name} ${p[name]} where garment 0 has ` +
              `${first[name]}; a set steps its garments together, so they must agree`,
          );
        }
      }
    });
  }

  private targetsChanged(garment: Garment, change: 'posed' | 'settled' | 'consumed'): void {
    if (change !== 'posed') {
      garment.fromAt = garment.toAt;
      return;
    }
    /*
     * The pose's matrices and colliders are written ahead of the next submit, so any work of this
     * garment's still waiting or recorded — a reset's settle steps, which read the colliders — is
     * sent first, or it would run against this pose rather than its own.
     */
    if (garment.ops.pending > 0 || garment.recorded) {
      this.run();
      this.flush();
    }
    this.writeFrameData(garment);
    garment.fromAt = garment.toAt;
    garment.toAt = garment.toAt === 0 ? this.packed.count * 3 : 0;
    this.queueOp(garment, CLOTH_OP_POSE);
  }

  private queueOp(garment: Garment, kind: number): number {
    const at = garment.ops.push(kind);
    const words = garment.ops.headWords;
    words[at + 4] = garment.fromAt;
    words[at + 5] = garment.toAt;
    garment.ops.headFloats.set(garment.wind, at + 28);
    return at;
  }

  private queueStep(garment: Garment, fraction: number, blend: number): void {
    const at = this.queueOp(garment, CLOTH_OP_STEP);
    const f = garment.ops.headFloats;
    f[at] = fraction;
    f[at + 1] = blend;
    const { parameters, targets } = garment.control;
    writeClothCarry(
      parameters,
      targets.modelBefore,
      targets.modelNow,
      garment.ops.headWords,
      f,
      at,
    );
  }

  /** Every op every garment is waiting on, a round of one kind at a time, in each garment's order. */
  private run(): void {
    for (;;) {
      let ran = false;
      for (let k = 0; k < KINDS.length; k++) {
        const kind = KINDS[k] as number;
        if (this.waiting(kind)) {
          this.runRound(kind);
          ran = true;
        }
      }
      if (!ran) return;
    }
  }

  /** Whether any garment has `kind` next. */
  private waiting(kind: number): boolean {
    for (let g = 0; g < this.garments.length; g++) {
      if ((this.garments[g] as Garment).ops.next === kind) return true;
    }
    return false;
  }

  /** One round: every garment with `kind` next takes part, and the rest sit it out. */
  private runRound(kind: number): void {
    const at = this.takeRound();
    const words = this.stagingWords;
    let blends = false;
    for (let g = 0; g < this.garments.length; g++) {
      const garment = this.garments[g] as Garment;
      const base = g * PACE_WORDS;
      words.fill(0, base, base + PACE_HEAD_WORDS);
      if (garment.ops.next !== kind) continue;
      garment.ops.take(words, base);
      words[base + 6] = 1;
      words[base + 7] = garment.range.limits;
      garment.recorded = true;
      if ((this.stagingFloats[base + 1] as number) > 0) blends = true;
    }
    this.device.queue.writeBuffer(this.paces, this.paceOffset(at), this.staging);
    if (kind === CLOTH_OP_POSE) this.dispatch('clothPose', at, 0, null);
    else if (kind === CLOTH_OP_REST) this.dispatch('clothRest', at, 0, null);
    else this.stepRound(at, blends);
  }

  private stepRound(at: number, blends: boolean): void {
    this.dispatch('clothBegin', at, 0, null);
    const { distanceBatches, bendingBatches, tetherBatches } = this.packed;
    for (let s = 0; s < this.substeps; s++) {
      this.dispatch('clothPredict', at, 0, null);
      for (let pass = 0; pass < this.iterations; pass++) {
        const first = pass === 0 ? 1 : 0;
        this.batches('clothDistance', distanceBatches, this.batchSlot.distance, first, at);
        this.batches('clothBending', bendingBatches, this.batchSlot.bending, first, at);
        this.batches('clothTether', tetherBatches, this.batchSlot.tether, first, at);
      }
      this.dispatch('clothLimit', at, 0, null);
      this.dispatch('clothFinish', at, 0, null);
    }
    if (blends) this.dispatch('clothBlend', at, 0, null);
  }

  /** Every colour of one kind across the set, in colour order, each a dispatch over its range. */
  private batches(
    entry: ClothEntry,
    batches: Uint32Array,
    firstSlot: number,
    first: number,
    roundAt: number,
  ): void {
    for (let b = 0; b + 1 < batches.length; b++) {
      const size = (batches[b + 1] as number) - (batches[b] as number);
      if (size === 0) continue;
      const slot = firstSlot + b * 2 + first;
      this.dispatch(
        entry,
        roundAt,
        slot * DYNAMIC_ALIGNMENT,
        null,
        Math.ceil(size / CLOTH_WORKGROUP),
      );
    }
  }

  private dispatch(
    entry: ClothEntry,
    roundAt: number,
    batchAt: number,
    output: GPUBindGroup | null,
    groups = this.groups,
  ): void {
    const pass = this.passFor();
    pass.setPipeline(this.kernels.pipelines[entry]);
    pass.setBindGroup(0, this.group, [roundAt, batchAt]);
    if (output !== null) pass.setBindGroup(1, output);
    pass.dispatchWorkgroups(groups);
  }

  private passFor(): GPUComputePassEncoder {
    if (this.pass === null) {
      this.encoder = this.device.createCommandEncoder({ label: 'cloth' });
      this.pass = this.encoder.beginComputePass({ label: 'cloth' });
    }
    return this.pass;
  }

  /** A round's slot, sending what is recorded first where the slots are spent: its byte offset. */
  private takeRound(): number {
    if (this.round === ROUNDS) this.flush();
    return this.round++ * DYNAMIC_ALIGNMENT;
  }

  /** Where the records of the round at `roundAt` sit in `paces`. */
  private paceOffset(roundAt: number): number {
    return (roundAt / DYNAMIC_ALIGNMENT) * this.staging.byteLength;
  }

  /** Send what has been recorded: every slot it reads was written ahead of it on the queue. */
  private flush(): void {
    const { pass, encoder } = this;
    if (pass === null || encoder === null) return;
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.pass = null;
    this.encoder = null;
    this.round = 0;
    for (let g = 0; g < this.garments.length; g++) (this.garments[g] as Garment).recorded = false;
  }

  /** A garment's skin matrices — or its model, with no rig — and its colliders, into the set's. */
  private writeFrameData(garment: Garment): void {
    const targets = garment.control.targets;
    const { jointBase, joints, colliderBase, colliders, rigged } = garment.range;
    const queue = this.device.queue;
    const matrices = (
      rigged && targets.skin !== null ? targets.skin : targets.model
    ) as Float32Array<ArrayBuffer>;
    queue.writeBuffer(this.frameData, jointBase * 64, matrices, 0, joints * 16);
    if (colliders === 0) return;
    const ends = this.packed.joints * 16;
    const radii = ends + this.packed.colliders * 6;
    queue.writeBuffer(
      this.frameData,
      (ends + colliderBase * 6) * 4,
      targets.colliderEnds as Float32Array<ArrayBuffer>,
      0,
      colliders * 6,
    );
    queue.writeBuffer(
      this.frameData,
      (radii + colliderBase * 2) * 4,
      targets.colliderRadii as Float32Array<ArrayBuffer>,
      0,
      colliders * 2,
    );
  }
}
