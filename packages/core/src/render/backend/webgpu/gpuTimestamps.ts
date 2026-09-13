/**
 * What a WebGPU frame cost, from the GPU rather than from a clock.
 *
 * **This backend shipped without one, and that is why a phone was slow for a release without
 * anybody being able to say by how much.** `WebGpuRenderer.gpuTimer` was a stub reporting
 * `available: false` and `null` forever, so every GPU figure this project has ever quoted came
 * from WebGL2 — the backend phones do not use. The consumer's own rule is that a
 * GPU verdict needs `gpuSamples > 0`, which on the shipping backend could never be satisfied,
 * so the frame meter, the FPS report and the diagnostics bundle all had a hole exactly where
 * the answer was.
 *
 * **Nothing here is new API.** It implements `FrameTimer`, the same interface `GpuTimer`
 * implements over `EXT_disjoint_timer_query_webgl2`, so the game that already calls
 * `beginFrame`, `begin('rest')`, `end`, `endFrame` and `poll` starts getting numbers without
 * one line changing over there.
 *
 * **The one shape difference, and it is forced by the API.** WebGL2 brackets an arbitrary run
 * of commands with `TIME_ELAPSED_EXT`. WebGPU cannot: a timestamp is written at the start and
 * the end of a *render pass*, declared on the pass descriptor. So the bracket becomes an
 * attribution rather than a measurement — `begin(slot)` records which slot is open,
 * `writesFor` hands the next query pair to each pass the renderer opens and remembers where it
 * belonged, and the readback sums the pass deltas per slot. A pass drawn without calling
 * `writesFor` is GPU time the total silently omits, which is the one way to get a wrong number
 * out of this rather than no number.
 *
 * **Never blocks.** A frame resolves its queries into a staging buffer and asks for the
 * mapping; the answer lands a frame or two later and is reported then. A timer that waited for
 * its own frame would be a stall, which is the one thing a profiler must not add.
 */
import type { FrameTimer } from '../timer.ts';
import { GPU_SLOTS, type GpuSample, type GpuSlot } from '../../gpuTimer.ts';

/**
 * Passes one frame may time.
 *
 * The heaviest frame measured on this engine is twenty — the game's courtyard, with three shadow
 * layers, six cubemap faces, two mirrors and the occlusion chain. Thirty-two leaves room for a
 * scene heavier than any that exists without allocating a query set nobody fills.
 */
const MAX_TIMED_PASSES = 32;
const QUERIES_PER_PASS = 2;
const BYTES_PER_QUERY = 8;
const NS_PER_MS = 1e6;

/** Resolved frames waiting for `poll`. Past this a frame is skipped rather than queued. */
const POOL_DEPTH = 4;

/*
 * Numeric rather than `GPUBufferUsage.*`, matching the rest of this directory. Those globals
 * do not exist under vitest, and a timer that cannot be constructed in a test is a timer whose
 * arithmetic nobody checks.
 */
const USAGE_QUERY_RESOLVE = 0x0200;
const USAGE_COPY_SRC = 0x0004;
const USAGE_COPY_DST = 0x0008;
const USAGE_MAP_READ = 0x0001;
const MAP_MODE_READ = 0x0001;

/** Slot to index, so a frame's attribution is a `Uint8Array` and costs no allocation. */
const SLOT_INDEX: Readonly<Record<GpuSlot, number>> = { shadows: 0, reflection: 1, rest: 2 };

export class GpuTimestamps implements FrameTimer {
  /** False where the adapter withheld `timestamp-query`, which is a normal state. */
  readonly available: boolean;

  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuffer: GPUBuffer | null = null;
  private readonly readBuffer: GPUBuffer | null = null;
  private readonly sampleEvery: number;

  /** Which slot each timed pass of the frame being recorded belongs to. */
  private readonly passSlots = new Uint8Array(MAX_TIMED_PASSES);
  /** The same, for the frame whose readback is in flight; the recorder reuses the other. */
  private readonly inFlightSlots = new Uint8Array(MAX_TIMED_PASSES);
  private passCount = 0;
  private inFlightCount = 0;

  private openSlot: GpuSlot | null = null;
  private frame = 0;
  private measuring = false;
  /** Whether this frame's queries have already been copied out; a second copy is a no-op. */
  private resolved = false;
  private readbackBusy = false;

  private readonly pending: GpuSample[] = [];
  private lastSample: GpuSample | null = null;

  get sampling(): boolean {
    return this.measuring;
  }

  constructor(device: GPUDevice, enabled = false, sampleEvery = 8) {
    this.sampleEvery = Math.max(1, Math.floor(sampleEvery));
    /*
     * Both halves, and `enabled` is the one that matters. A timer costs two queries a pass and
     * attaches a block to every pass descriptor in the frame, so an implementation that
     * disagrees about any of it invalidates the command buffer and the frame draws nothing.
     * That risk belongs to whoever asked to measure, never to every consumer by default.
     */
    this.available = enabled && (device.features?.has('timestamp-query') ?? false);
    if (!this.available) return;

    const count = MAX_TIMED_PASSES * QUERIES_PER_PASS;
    const bytes = count * BYTES_PER_QUERY;
    this.querySet = device.createQuerySet({ label: 'gpu.timestamps', type: 'timestamp', count });
    /*
     * Two buffers, because one cannot be both. `QUERY_RESOLVE` is where the driver writes and
     * `MAP_READ` is what this side may look at, and the flags are mutually exclusive.
     */
    this.resolveBuffer = device.createBuffer({
      label: 'gpu.timestamps.resolve',
      size: bytes,
      usage: USAGE_QUERY_RESOLVE | USAGE_COPY_SRC,
    });
    this.readBuffer = device.createBuffer({
      label: 'gpu.timestamps.read',
      size: bytes,
      usage: USAGE_COPY_DST | USAGE_MAP_READ,
    });
  }

  /**
   * Whether this frame is measured. Called once per frame, before any `begin`.
   *
   * Declines while a readback is still in flight, and that is not politeness: the read buffer
   * belongs to the driver until the mapping lands, and copying into a mapped buffer is a
   * validation error rather than a slow frame.
   */
  beginFrame(): boolean {
    if (this.querySet === null) return false;
    const measured = this.frame % this.sampleEvery === 0;
    this.frame++;
    this.measuring = measured && !this.readbackBusy && this.pending.length < POOL_DEPTH;
    if (this.measuring) {
      this.passCount = 0;
      this.resolved = false;
      this.openSlot = null;
    }
    return this.measuring;
  }

  /** Open a bracket. Every pass opened until `end` is attributed to this slot. */
  begin(slot: GpuSlot): void {
    if (!this.measuring || this.openSlot !== null) return;
    this.openSlot = slot;
  }

  end(): void {
    this.openSlot = null;
  }

  /**
   * The query pair for the pass about to be opened, or undefined where there is nothing to
   * measure with.
   *
   * Undefined is a legal value for `timestampWrites`, so a caller passes this straight into
   * the descriptor without branching, and an unmeasured frame costs one property write.
   */
  writesFor(): GPURenderPassTimestampWrites | undefined {
    if (!this.measuring || this.resolved || this.querySet === null) return undefined;
    if (this.passCount >= MAX_TIMED_PASSES) return undefined;
    const index = this.passCount;
    this.passSlots[index] = SLOT_INDEX[this.openSlot ?? 'rest'];
    this.passCount++;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: index * QUERIES_PER_PASS,
      endOfPassWriteIndex: index * QUERIES_PER_PASS + 1,
    };
  }

  /**
   * Copy the frame's queries out, on the frame's own encoder, before it is submitted.
   *
   * The renderer calls this rather than `endFrame`, because by the time the consumer ends the
   * frame the encoder it would have to ride on has already been finished and submitted.
   */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.measuring || this.resolved || this.readbackBusy) return;
    if (this.querySet === null || this.resolveBuffer === null || this.readBuffer === null) return;
    if (this.passCount === 0) return;
    const count = this.passCount * QUERIES_PER_PASS;
    encoder.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, count * BYTES_PER_QUERY);
    this.resolved = true;
  }

  /** Close the frame and ask for the mapping. Nothing waits for it. */
  endFrame(): void {
    if (!this.measuring) return;
    this.measuring = false;
    this.openSlot = null;
    if (!this.resolved || this.readbackBusy) return;

    this.inFlightSlots.set(this.passSlots);
    this.inFlightCount = this.passCount;
    this.readbackBusy = true;
    this.readBack();
  }

  private readBack(): void {
    const buffer = this.readBuffer;
    if (buffer === null) return;
    void buffer.mapAsync(MAP_MODE_READ).then(
      () => {
        const stamps = new BigUint64Array(buffer.getMappedRange());
        const parts = { shadows: 0, reflection: 0, rest: 0 };
        for (let i = 0; i < this.inFlightCount; i++) {
          const started = stamps[i * QUERIES_PER_PASS] ?? 0n;
          const finished = stamps[i * QUERIES_PER_PASS + 1] ?? 0n;
          /*
           * A pair the driver never wrote reads as two zeros, and a disjoint one can read
           * backwards. Both mean "no measurement", and neither is worth reporting as a
           * confident 0.0 — see `FrameTimer` on why an invented zero is the worst answer here.
           */
          if (finished <= started) continue;
          const slot = GPU_SLOTS[this.inFlightSlots[i] ?? 2] ?? 'rest';
          parts[slot] += Number(finished - started) / NS_PER_MS;
        }
        buffer.unmap();
        this.lastSample = parts;
        if (this.pending.length < POOL_DEPTH) this.pending.push(parts);
        this.readbackBusy = false;
      },
      () => {
        /* A lost device or a cancelled mapping is not a reason to stop drawing. */
        this.readbackBusy = false;
      },
    );
  }

  /** The oldest finished sample, or null. Never blocks. */
  poll(): GpuSample | null {
    return this.pending.shift() ?? null;
  }

  /**
   * The whole of the last resolved frame in milliseconds, or null where nothing measured.
   *
   * Summed because the three brackets partition the frame rather than overlapping, which is
   * the same arithmetic `GpuTimer.lastFrameMs` does over the same three names.
   */
  lastFrameMs(): number | null {
    if (this.lastSample === null) return null;
    return this.lastSample.shadows + this.lastSample.reflection + this.lastSample.rest;
  }

  dispose(): void {
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    this.readBuffer?.destroy();
    this.pending.length = 0;
    this.lastSample = null;
  }
}
