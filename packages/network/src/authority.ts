/**
 * One machine's state is the truth, and everybody else predicts and corrects.
 *
 * **The correction is a rewind**, which is why this file is short. A client that mispredicted has
 * computed some ticks from a world that was wrong; putting the authority's world back at that tick
 * and replaying the local inputs over it is exactly `reconcileSnapshot`. There is no second
 * mechanism here, only a different reason for reaching the same one.
 *
 * ---
 *
 * ## What crosses, and who decides
 *
 * A `Replicator` is supplied by the consumer. This package cannot know which of a game's fields are
 * authoritative, which are cosmetic, or how to pack them — and an engine that did would be a
 * particular game's engine. What it does own is *when*: the host publishes on a cadence, and the
 * client applies at the tick the message names.
 *
 * ## Prediction is for the local participant only
 *
 * A client predicts *its own* entity from its own inputs, immediately, because the whole point is
 * that a player's controls feel attached to their hands. It does **not** extrapolate other players
 * forward. Extrapolation is a choice between showing a stale position and showing a wrong one, and
 * which is worse depends on the game: a wrong position in a shooter decides a hit, and a stale one
 * in a racing game is a car in the wrong place on a corner. So remote bodies are *interpolated*
 * between two states the authority actually sent — `StateInterpolator` below — and anything more
 * aggressive is a consumer's to write.
 *
 * ## What is not here
 *
 * **Lag compensation.** An authority rewinding the world to a shooter's view of the past, so their
 * shot hits what was on their screen, is a real technique and a policy about who wins a disputed
 * shot. `RewindLoop.rewindTo` is public so it can be built; choosing it for every game is not this
 * package's business.
 *
 * **Interest management.** A world large enough that a client should not receive all of it needs
 * spatial partitioning of replication state. Reversed by a consumer measuring replication bandwidth
 * as their constraint.
 */
import type { InputLog } from './inputLog.ts';
import type { RewindLoop } from './rewind.ts';
import { BROADCAST, type PeerId, type Transport } from './transport.ts';
import {
  MESSAGE_INPUT,
  MESSAGE_STATE,
  createDecoded,
  decode,
  encodeInput,
  encodeState,
} from './wire.ts';

/**
 * What a consumer packs and unpacks.
 *
 * `encode` answers -1 when the state does not fit, for the reason the wire encoders do: the caller
 * is a frame loop and `AGENTS.md` forbids throwing in one.
 */
export interface Replicator {
  encode(into: Uint8Array, tick: number): number;
  apply(from: Uint8Array, tick: number): void;
}

export interface AuthorityOptions<S> {
  readonly transport: Transport;
  readonly loop: RewindLoop<S>;
  readonly inputs: InputLog;
  readonly replicator: Replicator;
  /**
   * How often the authoritative state is published, in ticks.
   *
   * **Three at 60 Hz is twenty a second**, which is what most shipped netcode settles near: often
   * enough that a correction is small, rare enough that the bandwidth is a fraction of what a
   * per-tick broadcast costs. A consumer whose state is tiny can publish every tick and one whose
   * world is large should publish less and send deltas.
   */
  readonly stateEvery?: number;
  /** Room for one encoded state. 8 KB by default; a state that does not fit is a state to delta. */
  readonly maxStateBytes?: number;
}

/** The machine whose world is the truth. */
export class AuthorityHost<S> {
  private readonly transport: Transport;
  private readonly loop: RewindLoop<S>;
  private readonly inputs: InputLog;
  private readonly replicator: Replicator;
  private readonly stateEvery: number;
  private readonly outgoing: Uint8Array;
  private readonly decoded = createDecoded();
  private published = 0;

  constructor(options: AuthorityOptions<S>) {
    this.transport = options.transport;
    this.loop = options.loop;
    this.inputs = options.inputs;
    this.replicator = options.replicator;
    this.stateEvery = Math.max(1, Math.trunc(options.stateEvery ?? 3));
    this.outgoing = new Uint8Array(16 + Math.max(64, options.maxStateBytes ?? 8192));
  }

  /** How many state messages have gone out. For a consumer measuring what replication costs. */
  get publishedStates(): number {
    return this.published;
  }

  poll(): void {
    this.transport.drain((_from, message) => {
      if (!decode(message, this.decoded)) return;
      if (this.decoded.kind !== MESSAGE_INPUT) return;

      const stride = this.decoded.payloadBytes;
      for (let i = 0; i < this.decoded.count; i++) {
        const tick = this.decoded.tick + i;
        const at = this.decoded.payloadAt + i * stride;
        if (this.inputs.isConfirmed(this.decoded.participant, tick)) continue;
        this.loop.supply(this.decoded.participant, tick, message.subarray(at, at + stride));
      }
    });
  }

  /**
   * Take a tick, then publish if this is a publishing tick.
   *
   * **The state is encoded *after* the step**, so it describes the world at the end of `tick`, and
   * a client applying it reconciles at `tick + 1`. Publishing before the step would send the world
   * as it was when the tick began, which is the state the client already had.
   */
  advance(dt: number, tick: number): void {
    this.loop.advance(dt, tick);
    const earliest = this.loop.earliest;
    if (earliest > 0) this.inputs.retain(earliest);

    if (tick % this.stateEvery !== 0) return;
    const bytes = this.replicator.encode(this.outgoing.subarray(16), tick);
    if (bytes < 0) return;
    const length = encodeState(this.outgoing, tick + 1, this.outgoing.subarray(16, 16 + bytes));
    if (length < 0) return;
    this.published += 1;
    this.transport.send(BROADCAST, this.outgoing.subarray(0, length));
  }
}

export interface ClientOptions<S> {
  readonly transport: Transport;
  readonly loop: RewindLoop<S>;
  readonly inputs: InputLog;
  readonly replicator: Replicator;
  readonly self: PeerId;
  /** Predict the local participant. Off means wait for the authority, which is the control. */
  readonly predict?: boolean;
  /** Recent inputs carried in every packet, for the reason `LockstepSession` documents. */
  readonly redundancy?: number;
}

/** A machine that predicts its own player and corrects toward the authority. */
export class PredictingClient<S> {
  readonly self: PeerId;

  private readonly transport: Transport;
  private readonly loop: RewindLoop<S>;
  private readonly inputs: InputLog;
  private readonly replicator: Replicator;
  private readonly predict: boolean;
  private readonly redundancy: number;
  private readonly recent: Uint8Array;
  private readonly outgoing: Uint8Array;
  private readonly decoded = createDecoded();

  private recentFrom = -1;
  private recentCount = 0;
  private correctionsValue = 0;
  private lastAppliedState = -1;

  constructor(options: ClientOptions<S>) {
    this.transport = options.transport;
    this.loop = options.loop;
    this.inputs = options.inputs;
    this.replicator = options.replicator;
    this.self = options.self;
    this.predict = options.predict ?? true;
    this.redundancy = Math.max(1, Math.trunc(options.redundancy ?? 4));
    this.recent = new Uint8Array(this.redundancy * this.inputs.inputBytes);
    this.outgoing = new Uint8Array(64 + this.redundancy * this.inputs.inputBytes);
  }

  /** How many authoritative states have been applied. Each one is a rewind. */
  get corrections(): number {
    return this.correctionsValue;
  }

  /**
   * Send this input and, when predicting, apply it locally on the same tick.
   *
   * **No input delay**, unlike lockstep. A delay there buys exactness for everybody; here the
   * authority is the source of truth anyway, so delaying the local input would add latency to the
   * player's own controls and buy nothing.
   */
  submit(tick: number, payload: Uint8Array): void {
    if (this.predict) this.inputs.set(this.self, tick, payload);
    this.remember(tick, payload);

    const length = encodeInput(
      this.outgoing,
      this.self,
      this.recentFrom,
      this.recent,
      this.inputs.inputBytes,
      this.recentCount,
    );
    if (length < 0) return;
    this.transport.send(BROADCAST, this.outgoing.subarray(0, length));
  }

  poll(): void {
    this.transport.drain((_from, message) => {
      if (!decode(message, this.decoded)) return;
      if (this.decoded.kind !== MESSAGE_STATE) return;

      const tick = this.decoded.tick;
      /* An older state than one already applied is a reordered packet, not news. */
      if (tick <= this.lastAppliedState) return;

      const payload = message.subarray(
        this.decoded.payloadAt,
        this.decoded.payloadAt + this.decoded.payloadBytes,
      );

      /*
       * **A state for a tick the ring no longer holds is applied whole rather than reconciled.**
       * There is nothing left to replay over it — the local history that far back is gone — so the
       * honest response is to accept the authority's world and carry on from there. That is a
       * visible jump, and it is what a client that has been away should see.
       */
      const applied = this.loop.reconcileSnapshot(tick, () => this.replicator.apply(payload, tick));
      if (!applied) this.replicator.apply(payload, tick);

      this.lastAppliedState = tick;
      this.correctionsValue += 1;
    });
  }

  advance(dt: number, tick: number): void {
    this.loop.advance(dt, tick);
    const earliest = this.loop.earliest;
    if (earliest > 0) this.inputs.retain(earliest);
  }

  private remember(tick: number, payload: Uint8Array): void {
    const stride = this.inputs.inputBytes;
    if (this.recentFrom < 0 || tick !== this.recentFrom + this.recentCount) {
      this.recentFrom = tick;
      this.recentCount = 0;
    }
    if (this.recentCount === this.redundancy) {
      this.recent.copyWithin(0, stride);
      this.recentFrom += 1;
      this.recentCount -= 1;
    }
    const at = this.recentCount * stride;
    for (let i = 0; i < stride; i++) this.recent[at + i] = payload[i] ?? 0;
    this.recentCount += 1;
  }
}

/**
 * Two authoritative states and where between them to draw.
 *
 * **Rendering at a delay is what stops a remote body teleporting.** States arrive every few ticks
 * and unevenly; drawing the newest one puts a body wherever the last packet said, which on a jittery
 * link is a stutter. Drawing *between* the two most recent, a fixed distance behind the newest, costs
 * that distance in latency and buys smooth motion — and the latency is honest, because the position
 * shown is one the authority actually published rather than one guessed forward.
 *
 * This owns the timing and none of the content: `sample` answers which two payloads and how far
 * between, and the consumer decodes and blends. It cannot do otherwise, since the payload's shape is
 * the consumer's.
 */
export class StateInterpolator {
  readonly delayTicks: number;

  private readonly ticks: Int32Array;
  private readonly payloads: Uint8Array[];
  private readonly lengths: Int32Array;
  private count = 0;
  private cursor = 0;

  constructor(capacity = 8, maxBytes = 8192, delayTicks = 4) {
    const slots = Math.max(2, Math.trunc(capacity));
    this.ticks = new Int32Array(slots).fill(-1);
    this.lengths = new Int32Array(slots);
    this.payloads = Array.from({ length: slots }, () => new Uint8Array(maxBytes));
    this.delayTicks = Math.max(0, Math.trunc(delayTicks));
  }

  /** Keep a state. The bytes are copied, because the transport reuses its buffer. */
  push(tick: number, payload: Uint8Array): void {
    const slot = this.cursor;
    const room = this.payloads[slot] as Uint8Array;
    const length = Math.min(payload.length, room.length);
    room.set(payload.subarray(0, length));
    this.lengths[slot] = length;
    this.ticks[slot] = tick;
    this.cursor = (this.cursor + 1) % this.ticks.length;
    if (this.count < this.ticks.length) this.count += 1;
  }

  /**
   * The two states to blend at `renderTick`, and how far between them, or null.
   *
   * `alpha` is clamped to [0, 1]: past the newest state it holds there rather than extrapolating,
   * which is the same choice `TickTrace.sample` makes at the end of a recording and for the same
   * reason — a character who has finished should look like they finished.
   */
  sample(renderTick: number): { from: Uint8Array; to: Uint8Array; alpha: number } | null {
    if (this.count === 0) return null;
    const target = renderTick - this.delayTicks;

    let before = -1;
    let after = -1;
    for (let i = 0; i < this.ticks.length; i++) {
      const at = this.ticks[i] as number;
      if (at < 0) continue;
      if (at <= target && (before < 0 || at > (this.ticks[before] as number))) before = i;
      if (at > target && (after < 0 || at < (this.ticks[after] as number))) after = i;
    }

    if (before < 0 && after < 0) return null;
    if (before < 0) return { from: this.slice(after), to: this.slice(after), alpha: 0 };
    if (after < 0) return { from: this.slice(before), to: this.slice(before), alpha: 1 };

    const fromTick = this.ticks[before] as number;
    const toTick = this.ticks[after] as number;
    const span = toTick - fromTick;
    const alpha = span <= 0 ? 1 : Math.min(1, Math.max(0, (target - fromTick) / span));
    return { from: this.slice(before), to: this.slice(after), alpha };
  }

  private slice(slot: number): Uint8Array {
    return (this.payloads[slot] as Uint8Array).subarray(0, this.lengths[slot] as number);
  }
}
