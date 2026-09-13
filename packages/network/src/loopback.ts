/**
 * A transport with no network, and a link you can make as bad as you like on purpose.
 *
 * **This is the load-bearing piece of the whole track's testing.** A rollback test run against a
 * real network is not a test: it cannot be run twice, a failure cannot be reproduced, and a green
 * result says only that this minute's conditions did not happen to trigger anything. Every
 * interesting property here — that a late input replays to the same world, that a lockstep pair
 * converges, that a desync is caught at the right tick — needs a link whose every delay, drop and
 * reordering is decided by a seed.
 *
 * Track O's `packages/ai/src/provider/latency.ts` is the precedent, and for the same reason: a
 * deterministic provider with programmable latency is what made an agent loop testable without a
 * model behind it.
 *
 * ---
 *
 * ## Time is supplied, not read
 *
 * `advance(ms)` moves this transport's clock. It never reads one. A transport that called
 * `performance.now()` would make every test depend on how fast the machine running it happened to
 * be, which is the property that makes a suite flaky on a loaded CI box and green on a laptop.
 *
 * ## The generator here is not the engine's
 *
 * A small xorshift, deliberately **not** `mulberry32`. The engine's seeded sequence is a frozen
 * promise about stored replays and ghosts; this is a test instrument's schedule. Sharing the
 * algorithm would invite somebody to assume the two are related, and the day one of them has to
 * change, the other would be dragged along.
 */
import {
  BROADCAST,
  type MessageSink,
  type PeerId,
  type Transport,
  type TransportState,
} from './transport.ts';

export interface Impairment {
  /** One-way delay in milliseconds, before jitter. */
  readonly latencyMs?: number;
  /** Delay varies uniformly by ± this many milliseconds. */
  readonly jitterMs?: number;
  /** Fraction of messages dropped, 0 to 1. */
  readonly loss?: number;
  /** Fraction of messages delivered a further `reorderMs` late, which is what reorders them. */
  readonly reorder?: number;
  readonly reorderMs?: number;
  /** Fraction of messages delivered twice. */
  readonly duplicate?: number;
}

export interface LoopbackOptions {
  readonly self: PeerId;
  readonly impairment?: Impairment;
  /** Anything reproducible. The same seed gives the same delivery schedule, exactly. */
  readonly seed?: number;
}

interface Pending {
  from: PeerId;
  to: PeerId;
  at: number;
  bytes: Uint8Array;
  live: boolean;
}

/**
 * A set of endpoints that can reach each other, holding the clock they share.
 *
 * The network owns the clock rather than each endpoint owning one, because two endpoints whose
 * clocks advanced separately would let a test deliver a message before it was sent.
 */
export class LoopbackNetwork {
  private readonly endpoints = new Map<PeerId, LoopbackTransport>();
  private nowMs = 0;

  get now(): number {
    return this.nowMs;
  }

  /** Make an endpoint. Its impairment is its own, so a link can be bad in one direction only. */
  open(options: LoopbackOptions): LoopbackTransport {
    const transport = new LoopbackTransport(this, options);
    this.endpoints.set(options.self, transport);
    return transport;
  }

  /**
   * Move the shared clock, delivering everything whose time has come.
   *
   * Delivery happens in **send order among messages due at the same instant**, which is what makes
   * a schedule reproducible: two messages with identical arrival times would otherwise be delivered
   * in whatever order a queue happened to hold them.
   */
  advance(ms: number): void {
    this.nowMs += ms;
    for (const endpoint of this.endpoints.values()) endpoint.deliverDue(this.nowMs);
  }

  /** Every endpoint, for a caller draining them all. */
  reach(to: PeerId): LoopbackTransport[] {
    if (to !== BROADCAST) {
      const one = this.endpoints.get(to);
      return one === undefined ? [] : [one];
    }
    return [...this.endpoints.values()];
  }
}

export class LoopbackTransport implements Transport {
  readonly self: PeerId;

  private readonly network: LoopbackNetwork;
  private readonly impairment: Required<Impairment>;
  private readonly inflight: Pending[] = [];
  private readonly arrived: { from: PeerId; bytes: Uint8Array }[] = [];
  private stateValue: TransportState = 'open';
  private randomState: number;
  /** Sends made, and how many the impairment threw away. For a test asserting the link was bad. */
  private sentCount = 0;
  private droppedCount = 0;

  constructor(network: LoopbackNetwork, options: LoopbackOptions) {
    this.network = network;
    this.self = options.self;
    this.randomState = (options.seed ?? 1) | 0 || 1;
    const given = options.impairment ?? {};
    this.impairment = {
      latencyMs: given.latencyMs ?? 0,
      jitterMs: given.jitterMs ?? 0,
      loss: given.loss ?? 0,
      reorder: given.reorder ?? 0,
      reorderMs: given.reorderMs ?? 0,
      duplicate: given.duplicate ?? 0,
    };
  }

  get state(): TransportState {
    return this.stateValue;
  }

  get sent(): number {
    return this.sentCount;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Queue a message for everyone it is addressed to, impaired.
   *
   * **The bytes are copied here and nowhere else.** A caller sending from a reusable buffer — which
   * every caller in this package does — would otherwise have the buffer overwritten before delivery,
   * and the message that arrived would be whatever was sent most recently. That bug looks exactly
   * like a reordering bug and is not one.
   */
  send(to: PeerId, message: Uint8Array): void {
    if (this.stateValue !== 'open') return;
    this.sentCount += 1;

    if (this.random() < this.impairment.loss) {
      this.droppedCount += 1;
      return;
    }

    const copy = message.slice();
    let delay = this.impairment.latencyMs;
    if (this.impairment.jitterMs > 0) {
      delay += (this.random() * 2 - 1) * this.impairment.jitterMs;
    }
    if (this.random() < this.impairment.reorder) delay += this.impairment.reorderMs;
    if (delay < 0) delay = 0;

    for (const endpoint of this.network.reach(to)) {
      if (endpoint === this) continue;
      endpoint.accept({
        from: this.self,
        to,
        at: this.network.now + delay,
        bytes: copy,
        live: true,
      });
      if (this.random() < this.impairment.duplicate) {
        endpoint.accept({
          from: this.self,
          to,
          at: this.network.now + delay,
          bytes: copy,
          live: true,
        });
      }
    }
  }

  drain(into: MessageSink): void {
    for (const message of this.arrived) into(message.from, message.bytes);
    this.arrived.length = 0;
  }

  close(): void {
    this.stateValue = 'closed';
    this.inflight.length = 0;
    this.arrived.length = 0;
  }

  /** Called by the network. Not for a consumer. */
  accept(pending: Pending): void {
    if (this.stateValue !== 'open') return;
    this.inflight.push(pending);
  }

  /** Called by the network when the clock moves. Not for a consumer. */
  deliverDue(nowMs: number): void {
    if (this.inflight.length === 0) return;

    /*
     * Stable by arrival time, then by the order they were queued. Sorting by time alone leaves two
     * messages due at the same instant in an order the engine's sort happens to choose, and a
     * schedule that depends on a sort's stability is a schedule that is not reproducible.
     */
    let due = 0;
    for (const pending of this.inflight) if (pending.at <= nowMs) due += 1;
    if (due === 0) return;

    const ready: Pending[] = [];
    const keep: Pending[] = [];
    for (const pending of this.inflight) {
      if (pending.at <= nowMs) ready.push(pending);
      else keep.push(pending);
    }
    ready.sort((a, b) => a.at - b.at);

    this.inflight.length = 0;
    for (const pending of keep) this.inflight.push(pending);
    for (const pending of ready) this.arrived.push({ from: pending.from, bytes: pending.bytes });
  }

  /**
   * A xorshift32 in [0, 1). Deliberately not the engine's generator; see the header.
   */
  private random(): number {
    let x = this.randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x | 0;
    return ((x >>> 0) % 0x1000000) / 0x1000000;
  }
}
