/**
 * What a script can see of a session, and the replicated scalars it can publish.
 *
 * **This exists because `drift/network` needs something to be a capability *of*.** The two session
 * drivers have different shapes — a lockstep peer has no authority and an authoritative client has
 * no confirmed-input watermark — and a script surface cannot be a union of two classes. So this is
 * the one thing a script holds, and a consumer points it at whichever driver they are running.
 *
 * ---
 *
 * ## Replicated scalars are numbered, not named
 *
 * `replicate(slot, value)` writes into a fixed table of floats and `replicated(participant, slot)`
 * reads another participant's. Numbered rather than named for the reason `drift/ui` addresses nodes
 * by name and this does the opposite: a *name* would need a string map on a per-tick path and a
 * miss would need an optional to answer with, which the language does not have. A slot is an index
 * into an array a consumer sized, and an index out of range answers zero — total, and allocating
 * nothing.
 *
 * **A handful of scalars, not a replication system.** This is for the values a script computes and
 * another peer wants: a health bar, a charge level, a lap count. A world's worth of state goes
 * through `Replicator`, which a consumer writes and which can pack whatever it likes. The line
 * between them is that this one is reachable from a `.drs` file.
 *
 * ## It is its own `Replicator`
 *
 * The slot table is exactly the thing an authority publishes and a client applies, so this
 * implements `encode` and `apply` rather than making a consumer write a third copy of the same
 * loop. A consumer replicating anything larger supplies their own and ignores this.
 */
import type { Replicator } from './authority.ts';

export interface ScriptSessionOptions {
  readonly self: number;
  readonly participants: number;
  /** Replicated scalars per participant. Eight by default. */
  readonly slots?: number;
  /** Whether this peer's world is the authority. Fixed for the session's life. */
  readonly authority?: boolean;
}

/** What a driver tells the façade about itself. Both session classes satisfy the parts they have. */
export interface SessionStatus {
  readonly confirmed?: number;
  readonly status?: string;
  readonly reason?: string;
}

export class ScriptSession implements Replicator {
  readonly self: number;
  readonly authority: boolean;

  private readonly slotCount: number;
  private readonly values: Float64Array;
  private participantCount: number;
  private driver: SessionStatus | null = null;
  private readonly view: DataView;

  constructor(options: ScriptSessionOptions) {
    this.self = Math.max(0, Math.trunc(options.self));
    this.participantCount = Math.max(1, Math.trunc(options.participants));
    this.slotCount = Math.max(1, Math.trunc(options.slots ?? 8));
    this.authority = options.authority ?? false;
    this.values = new Float64Array(this.participantCount * this.slotCount);
    this.view = new DataView(this.values.buffer);
  }

  /** Point this at the driver whose status a script reads. */
  follow(driver: SessionStatus): this {
    this.driver = driver;
    return this;
  }

  get participants(): number {
    return this.participantCount;
  }

  /** The highest tick every participant's input has arrived for, or -1 when nothing tracks it. */
  get confirmed(): number {
    return this.driver?.confirmed ?? -1;
  }

  get halted(): boolean {
    return this.driver?.status === 'halted';
  }

  get haltReason(): string {
    return this.driver?.reason ?? '';
  }

  /** Publish a value in one of this peer's slots. Out of range does nothing. */
  replicate(slot: number, value: number): void {
    const at = this.indexOf(this.self, slot);
    if (at < 0) return;
    this.values[at] = value;
  }

  /** Read a participant's slot. Out of range answers zero, which is total and allocates nothing. */
  replicated(participant: number, slot: number): number {
    const at = this.indexOf(participant, slot);
    return at < 0 ? 0 : (this.values[at] as number);
  }

  get slots(): number {
    return this.slotCount;
  }

  /**
   * Every slot, as bytes. See the header: this is its own `Replicator`.
   *
   * The tick is taken and ignored, and the parameter is written out rather than dropped: a shorter
   * signature still satisfies the interface, and then a reader has to open `authority.ts` to learn
   * that the second argument exists at all.
   */
  encode(into: Uint8Array, _tick = 0): number {
    const bytes = this.values.byteLength;
    if (into.length < bytes) return -1;
    into.set(new Uint8Array(this.values.buffer, 0, bytes));
    return bytes;
  }

  apply(from: Uint8Array, _tick = 0): void {
    const bytes = Math.min(from.length, this.values.byteLength);
    /*
     * Copied a byte at a time through the view rather than by `set` on a typed array, because the
     * incoming bytes are a subarray of the transport's buffer and their byte offset need not be a
     * multiple of eight — a `Float64Array` view over it would throw on an unaligned offset.
     */
    for (let i = 0; i < bytes; i++) this.view.setUint8(i, from[i] as number);
  }

  private indexOf(participant: number, slot: number): number {
    if (participant < 0 || participant >= this.participantCount) return -1;
    if (slot < 0 || slot >= this.slotCount) return -1;
    return participant * this.slotCount + slot;
  }
}
