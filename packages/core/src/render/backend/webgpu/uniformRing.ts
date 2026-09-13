import type { BudgetCounter } from '../budget.ts';

/**
 * WebGPU's default minimum alignment for a dynamic uniform offset.
 *
 * Exported because the bloom chain lays out its stages by hand rather than through this class —
 * its blocks never change between frames, so it has nothing to reset and nothing to flush — and
 * an alignment restated somewhere else is an alignment that can disagree.
 */
export const DYNAMIC_ALIGNMENT = 256;

/**
 * The most staging one ring may hold, and therefore the most device memory it may take.
 *
 * **A ceiling on the growth, because a runaway consumer should degrade rather than crash.** Past
 * this the ring refuses to grow and goes on skipping work and reporting it, which is the right end
 * state for a frame asking for something no device should be asked for. What growth changes is
 * where that line sits: at a number chosen against a phone's memory rather than at whatever the
 * ring happened to be constructed with.
 *
 * Sixty-four mebibytes is far past any legitimate scene — the flat vertex ring's slot is 1,540
 * bytes, so this is forty-three thousand draws, and the fragment ring's is at most 13,312, which
 * is five thousand material changes in one frame. The device buffer matches the staging, so a ring
 * at this ceiling holds 128 MiB in total and only ever reaches it by being asked to.
 */
const MAX_RING_BYTES = 64 * 1024 * 1024;

/**
 * Per-draw uniforms, in slots, written once and bound by offset.
 *
 * **This exists because `queue.writeBuffer` does not interleave with draw commands.** Writes
 * are ordered on the queue timeline and the encoder's commands are submitted afterwards, so
 * writing one model matrix into one buffer between two `draw` calls gives *both* draws the
 * last matrix written. The picture is every object stacked at the position of whichever was
 * drawn last, which looks like a transform bug and is not one.
 *
 * So each draw takes its own slot, all the slots are uploaded in a single write at the end
 * of the frame, and the draw binds its slot with a dynamic offset. One upload per frame
 * rather than one per draw, and no allocation in the frame loop: the staging array is
 * allocated once and reused, which is what `AGENTS.md` requires of a per-frame path.
 */
export class UniformRing {
  /**
   * The device buffer every bind group over this ring holds.
   *
   * **Not `readonly`, because `growTo` replaces it**, and a bind group built against the old one
   * is invalid the moment it does. That is the whole reason `growTo` reports whether it happened.
   */
  buffer: GPUBuffer;
  /** Bytes per slot, rounded up to the alignment a dynamic offset requires. */
  readonly slotSize: number;

  private readonly device: GPUDevice;
  private readonly usage: number;
  private readonly label: string;
  private staging: ArrayBuffer;
  private floats: Float32Array;
  private ints: Int32Array;
  private capacity: number;
  private used = 0;

  /**
   * `label` names the buffer on the device, and it is not decoration.
   *
   * A validation failure arrives at `queue.submit` naming the resource it was about, and the
   * only reason that message is readable is that somebody labelled the resource — the shadow
   * peel's root cause read *"of [Texture "shadow.static"]"*. A dozen rings all called
   * `uniforms.ring` would name none of themselves. See `device.ts`.
   *
   * `budget` is the line this ring's ceiling is reported on, and most rings have none.
   * **Only one ring of a pair carries it**: several subsystems take a vertex slot and a fragment
   * slot together, from two rings of equal capacity, and refuse the work if either is null — so a
   * line on both would count every water body twice and report a ceiling of sixteen exceeded at
   * eight. The vertex ring carries it by convention and the fragment ring beside it carries none.
   */
  constructor(
    device: GPUDevice,
    bytesPerSlot: number,
    slots: number,
    usage: number,
    label = 'uniforms.ring',
    private readonly budget: BudgetCounter | null = null,
  ) {
    this.device = device;
    this.usage = usage;
    this.label = label;
    this.slotSize = Math.ceil(bytesPerSlot / DYNAMIC_ALIGNMENT) * DYNAMIC_ALIGNMENT;
    this.capacity = slots;
    this.staging = new ArrayBuffer(this.slotSize * slots);
    this.floats = new Float32Array(this.staging);
    this.ints = new Int32Array(this.staging);
    this.buffer = device.createBuffer({
      label,
      size: this.staging.byteLength,
      usage,
    });
  }

  /** How many slots this ring holds. What a frame may take before `allocate` starts refusing. */
  get slots(): number {
    return this.capacity;
  }

  /**
   * Make room for at least `slots`, and say whether the buffer was replaced.
   *
   * **Called at the start of a frame and nowhere else**, which is what keeps `allocate`'s refusal
   * to grow intact: there is no encoder open, everything from the last frame has been submitted,
   * and nothing has been written into the staging that discarding it would lose. Growing where
   * `allocate` runs out would stall the frame to make room, which is the thing this class exists
   * to avoid and still does.
   *
   * **A `true` means every bind group holding `buffer` is now invalid.** The old buffer is
   * destroyed rather than dropped: commands already submitted against it keep it alive until they
   * retire, which is the implementation's job, and nothing recorded for *this* frame exists yet.
   *
   * Refuses past `MAX_RING_BYTES` and says `false`, leaving the ring it has — a frame asking for
   * more than that goes back to skipping the work and reporting it.
   */
  growTo(slots: number): boolean {
    if (slots <= this.capacity) return false;
    const bytes = this.slotSize * slots;
    if (bytes > MAX_RING_BYTES) return false;

    this.buffer.destroy();
    this.capacity = slots;
    this.staging = new ArrayBuffer(bytes);
    this.floats = new Float32Array(this.staging);
    this.ints = new Int32Array(this.staging);
    this.buffer = this.device.createBuffer({
      label: this.label,
      size: bytes,
      usage: this.usage,
    });
    return true;
  }

  /** How many slots have been taken this frame. */
  get count(): number {
    return this.used;
  }

  /** Start a frame. Slots are reused; nothing is freed. */
  reset(): void {
    this.used = 0;
  }

  /**
   * Take the next slot and return its byte offset, or null when the ring is full.
   *
   * **Null rather than growing.** Growing means allocating a buffer mid-frame, which is the
   * thing this class exists to avoid; a caller that runs out should skip the draw and say so
   * once, not stall the frame to make room.
   *
   * **And say so in a number as well as in a line of text.** Every caller already wrote one
   * `console.warn` per renderer lifetime and nothing else, which is unobservable from a headless
   * check and gone by the time anybody looks — a consumer lost weeks to a ceiling whose
   * open lead was still *"ask the reporter for the console"*. The count is taken here rather than
   * at the callers because here is the only place that knows both halves: what was asked for, and
   * whether it fit.
   *
   * **What comes back is a byte offset, not an index**, and it is what `setBindGroup` wants.
   *
   * Said plainly because the name says "slot" and the value is already scaled: a caller that
   * multiplies it by `slotSize` on the way to a dynamic offset lands a whole ring away. That
   * happened — the second panel of a frame addressed 65,536 into a 16,384-byte ring — and the
   * only reason it took a minute rather than an afternoon is that `device.ts` now prints what
   * the device rejected, naming the buffer and both numbers.
   */
  allocate(): number | null {
    this.budget?.ask();
    if (this.used >= this.capacity) {
      this.budget?.drop();
      return null;
    }
    const offset = this.used * this.slotSize;
    this.used += 1;
    return offset;
  }

  /** Write floats into a slot, at a byte offset within it. */
  writeFloats(slot: number, byteOffset: number, values: ArrayLike<number>): void {
    this.floats.set(values, (slot + byteOffset) / 4);
  }

  /**
   * Write one float into a slot.
   *
   * Separate from `writeFloats` because the alternative at a call site with a dozen scalars in
   * it is a one-element array per field — either allocated in the frame loop, which
   * `AGENTS.md` forbids, or a shared scratch that reads as a value being passed when it is a
   * buffer being reused.
   */
  writeFloat(slot: number, byteOffset: number, value: number): void {
    this.floats[(slot + byteOffset) / 4] = value;
  }

  /** Write one integer into a slot. Separate because a `Float32Array` cannot hold an `i32`. */
  writeInt(slot: number, byteOffset: number, value: number): void {
    this.ints[(slot + byteOffset) / 4] = value;
  }

  /**
   * Copy a whole prepared block into a slot, bit for bit.
   *
   * **Through the integer view, and that is not a detail.** A block that mixes floats and
   * `i32`s copied through `Float32Array` is a numeric conversion, and `-1` as an `i32` is
   * `0xFFFFFFFF`, which read as a float is a NaN — free to be canonicalised to a different NaN
   * on the way through. `-1` is the *sentinel* for "this light has no shadow cubemap", so that
   * conversion would turn "no point shadows" into a number matching nothing or, worse,
   * something. Bug 9 on this branch was that sentinel being wrong in the other direction.
   *
   * `Int32Array.set` from an `Int32Array` is an exact copy of every bit, whatever the bits mean.
   */
  writeBlock(slot: number, block: Int32Array): void {
    this.ints.set(block, slot / 4);
  }

  /** Upload every slot taken this frame, in one write. */
  flush(): void {
    if (this.used === 0) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.staging, 0, this.used * this.slotSize);
  }

  dispose(): void {
    this.buffer.destroy();
  }
}
