import type { BudgetCounter } from '../budget.ts';
import { DYNAMIC_ALIGNMENT, MAX_RING_BYTES } from './uniformRing.ts';

/**
 * The lit stage's material blocks, each kept in its slot for as long as later draws ask for the
 * same numbers, so a material that has not changed since the last frame costs no upload at all.
 *
 * **Keyed by content, because nothing else names a material.** A material here is whatever the
 * setters left in the block when a draw took it — a consumer never hands over an object that could
 * carry an identity — so the block's own words are the key: hashed to find a bucket, compared word
 * for word to accept a match, and bound by the slot's offset. What it gives up is a hash and a
 * compare of a few hundred bytes per material change, against copying and uploading the whole
 * block every frame, which a stage of four hundred materials measured at megabytes a frame.
 *
 * **A slot the frame has asked for is never given away within it**, for the reason `UniformRing`
 * exists: a queue write does not interleave with recorded draws, so rewriting a slot a recorded draw
 * reads would hand that draw the new numbers. A frame asking for more distinct blocks than there are
 * slots is refused, counted and skipped, as the ring was. Across frames rewriting is safe, because a
 * write issued after a submit is ordered after the commands in it.
 *
 * **What a new block displaces is a slot nobody asked for this frame or the last**, found by a hand
 * that sweeps the slots in turn; only when every slot was asked for recently does it take one the
 * last frame used. What would make that wrong is a scene whose distinct materials a frame approach
 * the store's size: it then rewrites some of its steady materials every frame, which costs their
 * upload and nothing else.
 */
export class MaterialStore {
  /** Replaced by `growTo`, so every bind group over it is rebuilt when that says so. */
  buffer: GPUBuffer;
  /** Bytes per slot, rounded up to the alignment a dynamic offset requires. */
  readonly slotSize: number;

  private readonly words: number;
  private readonly stride: number;
  private capacity: number;
  private staging: ArrayBuffer;
  private ints: Int32Array;
  /** Per slot: its block's hash, the next slot in its bucket or -1, and whether it holds one. */
  private hashes: Int32Array;
  private next: Int32Array;
  private held: Uint8Array;
  /** Per slot: the frame that last asked for it, and whether it was written since the last flush. */
  private askedIn: Int32Array;
  private pending: Uint8Array;
  /** Per slot: how many holders pinned it. A pinned slot is never displaced. */
  private pins: Int32Array;
  /**
   * How many times the store has forgotten everything it held, which growth does: a holder of an
   * offset compares this, because an offset from before is a slot of a buffer that is gone.
   */
  epoch = 0;
  /** Per bucket: its first slot, or -1. A power of two at least twice the slots. */
  private heads: Int32Array;
  private mask: number;
  private lowPending: number;
  private highPending = -1;
  private hand = 0;
  /** Starts past zero, so a slot never asked for reads as long unasked. */
  private frame = 2;

  constructor(
    private readonly device: GPUDevice,
    bytesPerBlock: number,
    slots: number,
    private readonly usage: number,
    private readonly label = 'materials.store',
    private readonly budget: BudgetCounter | null = null,
  ) {
    this.words = Math.ceil(bytesPerBlock / 4);
    this.slotSize = Math.ceil(bytesPerBlock / DYNAMIC_ALIGNMENT) * DYNAMIC_ALIGNMENT;
    this.stride = this.slotSize / 4;
    this.capacity = slots;
    this.lowPending = slots;
    this.staging = new ArrayBuffer(this.slotSize * slots);
    this.ints = new Int32Array(this.staging);
    this.hashes = new Int32Array(slots);
    this.next = new Int32Array(slots);
    this.held = new Uint8Array(slots);
    this.askedIn = new Int32Array(slots);
    this.pending = new Uint8Array(slots);
    this.pins = new Int32Array(slots);
    this.heads = new Int32Array(bucketsFor(slots)).fill(-1);
    this.mask = this.heads.length - 1;
    this.buffer = device.createBuffer({ label, size: this.staging.byteLength, usage });
  }

  /** How many distinct blocks a frame may hold. */
  get slots(): number {
    return this.capacity;
  }

  /** Start a frame: every slot the last one asked for may be displaced from here on, last. */
  beginFrame(): void {
    this.frame += 1;
  }

  /**
   * The byte offset of a slot holding exactly `block`, written there if no slot did, or null when
   * every slot is one this frame has asked for. `block` is the whole block, word for word.
   */
  place(block: Int32Array): number | null {
    this.budget?.ask();
    const hash = hashWords(block, this.words);
    const bucket = hash & this.mask;
    for (let slot = this.heads[bucket] as number; slot >= 0; slot = this.next[slot] as number) {
      if (this.hashes[slot] === hash && this.holds(slot, block)) {
        this.askedIn[slot] = this.frame;
        return slot * this.slotSize;
      }
    }
    const slot = this.displace();
    if (slot < 0) {
      this.budget?.drop();
      return null;
    }
    if (this.held[slot] === 1) this.unlink(slot);
    this.ints.set(block, slot * this.stride);
    this.hashes[slot] = hash;
    this.next[slot] = this.heads[bucket] as number;
    this.heads[bucket] = slot;
    this.held[slot] = 1;
    this.askedIn[slot] = this.frame;
    this.pending[slot] = 1;
    if (slot < this.lowPending) this.lowPending = slot;
    if (slot > this.highPending) this.highPending = slot;
    return slot * this.slotSize;
  }

  /** Upload every slot written since the last flush, one write per run of neighbouring slots. */
  flush(): void {
    let slot = this.lowPending;
    while (slot <= this.highPending) {
      if (this.pending[slot] !== 1) {
        slot += 1;
        continue;
      }
      const from = slot;
      while (slot <= this.highPending && this.pending[slot] === 1) {
        this.pending[slot] = 0;
        slot += 1;
      }
      const at = from * this.slotSize;
      this.device.queue.writeBuffer(
        this.buffer,
        at,
        this.staging,
        at,
        (slot - from) * this.slotSize,
      );
    }
    this.lowPending = this.capacity;
    this.highPending = -1;
  }

  /**
   * Make room for at least `slots`, forgetting every block held, and say whether the buffer was
   * replaced. Called where `UniformRing.growTo` is, at a frame's start, for the reasons it gives,
   * and refused past the same ceiling.
   */
  growTo(slots: number): boolean {
    if (slots <= this.capacity) return false;
    if (this.slotSize * slots > MAX_RING_BYTES) return false;
    this.buffer.destroy();
    this.capacity = slots;
    this.staging = new ArrayBuffer(this.slotSize * slots);
    this.ints = new Int32Array(this.staging);
    this.hashes = new Int32Array(slots);
    this.next = new Int32Array(slots);
    this.held = new Uint8Array(slots);
    this.askedIn = new Int32Array(slots);
    this.pending = new Uint8Array(slots);
    this.pins = new Int32Array(slots);
    this.heads = new Int32Array(bucketsFor(slots)).fill(-1);
    this.mask = this.heads.length - 1;
    this.lowPending = slots;
    this.epoch += 1;
    this.highPending = -1;
    this.hand = 0;
    this.buffer = this.device.createBuffer({
      label: this.label,
      size: this.staging.byteLength,
      usage: this.usage,
    });
    return true;
  }

  /**
   * Keep the block at `offset` where it is until `unpin`: a holder binding it by offset frame after
   * frame — a list recorded once — whether or not anything asks for it. Counted, so two holders of
   * one block each let go of their own pin.
   */
  pin(offset: number): void {
    const slot = offset / this.slotSize;
    this.pins[slot] = (this.pins[slot] as number) + 1;
  }

  unpin(offset: number): void {
    const slot = offset / this.slotSize;
    if ((this.pins[slot] as number) > 0) this.pins[slot] = (this.pins[slot] as number) - 1;
  }

  dispose(): void {
    this.buffer.destroy();
  }

  private holds(slot: number, block: Int32Array): boolean {
    const base = slot * this.stride;
    for (let word = 0; word < this.words; word++) {
      if (this.ints[base + word] !== block[word]) return false;
    }
    return true;
  }

  /**
   * The slot a new block goes in: the first from the hand nobody asked for this frame or the last,
   * else the first this frame has not asked for, else none. One sweep at most.
   */
  private displace(): number {
    let fallback = -1;
    for (let step = 0; step < this.capacity; step++) {
      const slot = this.hand;
      this.hand = slot + 1 === this.capacity ? 0 : slot + 1;
      if ((this.pins[slot] as number) > 0) continue;
      const asked = this.askedIn[slot] as number;
      if (asked < this.frame - 1) return slot;
      if (fallback < 0 && asked !== this.frame) fallback = slot;
    }
    return fallback;
  }

  private unlink(slot: number): void {
    const bucket = (this.hashes[slot] as number) & this.mask;
    let at = this.heads[bucket] as number;
    if (at === slot) {
      this.heads[bucket] = this.next[slot] as number;
      return;
    }
    while (at >= 0) {
      const after = this.next[at] as number;
      if (after === slot) {
        this.next[at] = this.next[slot] as number;
        return;
      }
      at = after;
    }
  }
}

function bucketsFor(slots: number): number {
  let buckets = 16;
  while (buckets < slots * 2) buckets *= 2;
  return buckets;
}

/**
 * MurmurHash3's 32-bit mix over the block's words. Not FNV, whose multiply carries a difference only
 * upward: the bucket is the hash's low bits, and a material's words are mostly floats, whose low
 * mantissa bits are zero for every value a person types — 0.5, 1, 2 — so blocks differing only in
 * those would all have shared one bucket. The compare that follows a match is what decides.
 */
export function hashWords(block: Int32Array, words: number): number {
  let hash = 0x9747b28c;
  for (let word = 0; word < words; word++) {
    let k = Math.imul(block[word] as number, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    hash ^= Math.imul(k, 0x1b873593);
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }
  hash ^= words * 4;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return hash ^ (hash >>> 16);
}
