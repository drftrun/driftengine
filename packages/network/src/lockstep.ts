/**
 * Every peer simulates every tick, and a wrong guess is unwound.
 *
 * **Classic lockstep stalls; this predicts.** The original design waits until every participant's
 * input for a tick has arrived and only then advances, which makes the whole session run at the
 * latency of its worst link and turns a single dropped packet into a visible freeze for everyone.
 * With a rewind loop underneath, a missing input can be guessed and corrected — so the session runs
 * at local speed and pays for a wrong guess only when the guess was wrong.
 *
 * ---
 *
 * ## The input delay, and why it is not just latency tolerance
 *
 * A local input for tick *T* is published for tick *T + delay*. That buys `delay` ticks for it to
 * reach everyone before anybody needs it, so on a link inside that budget **nobody predicts and
 * nobody rewinds** — the session is exact, not merely convergent.
 *
 * What it costs is that a player's own control is `delay` ticks late on their own screen. That is a
 * real cost and it is a game's to choose: two ticks is 33 ms and unnoticeable in a racing game,
 * and unacceptable in a fighting game where it is the whole argument for rollback.
 *
 * ## Halting is a feature
 *
 * Two things stop the session rather than degrade it, because both mean the local world can no
 * longer be made correct:
 *
 * - **An input arrives for a tick outside the rewind window.** It cannot be applied, so this peer's
 *   world is permanently different from the one that input describes.
 * - **A fingerprint disagrees at a confirmed tick.** Two peers computed different worlds from the
 *   same inputs, which is a determinism bug rather than a networking one, and continuing produces
 *   two games that both believe they are right.
 *
 * A session that carried on would be showing each player a plausible world with no relationship to
 * anyone else's. Halting names the tick, which is where the debugging starts.
 */
import { Fingerprint } from './fingerprint.ts';
import type { InputLog } from './inputLog.ts';
import type { RewindLoop } from './rewind.ts';
import { BROADCAST, type PeerId, type Transport } from './transport.ts';
import {
  MESSAGE_FINGERPRINT,
  MESSAGE_INPUT,
  createDecoded,
  decode,
  encodeFingerprint,
  encodeInput,
} from './wire.ts';

export type LockstepStatus = 'running' | 'halted';

export interface LockstepOptions<S> {
  readonly transport: Transport;
  readonly loop: RewindLoop<S>;
  readonly inputs: InputLog;
  /** This peer's id, and the index its inputs occupy in the log. */
  readonly self: PeerId;
  readonly participants: number;
  /**
   * How many ticks ahead a local input is published. Two is 33 ms at 60 Hz.
   *
   * See the header: inside this budget the session is exact rather than convergent.
   */
  readonly inputDelay?: number;
  /**
   * How often a fingerprint is published, in ticks. Every tick is wasteful and every hundred is
   * slow to notice; the default is every eight, which at 60 Hz is seven a second.
   */
  readonly fingerprintEvery?: number;
  /** Publish fingerprints at all. Off needs no digest from the snapshotter. */
  readonly compareStates?: boolean;
  /**
   * How many recent inputs ride along in every packet. Four by default.
   *
   * **This is what makes lockstep survive loss, and one is not enough.** An input is only useful
   * for the tick it names, so asking for a lost one and waiting a round trip delivers it after that
   * tick has gone — the peer's world is then permanently different and nothing local repairs it.
   * Sending the last few in every packet covers a run of drops before anybody notices, for a
   * handful of bytes on a message that already has a header.
   *
   * Four covers three consecutive losses. A link losing four in a row at 60 Hz has stopped being a
   * link.
   *
   * **It may reach further back than the rewind window without any arrangement between the two.**
   * The session forgets inputs below the oldest tick a rewind can reach, so past that depth every
   * packet's oldest words name ticks the log can no longer say anything about. Those are skipped on
   * the strength of what this world already applied, not on what the log still holds — see the
   * watermark in `receive`. Choose this number for the link and the rewind depth for the game.
   */
  readonly redundancy?: number;
}

export interface Desync {
  readonly tick: number;
  readonly peer: PeerId;
  readonly ours: string;
  readonly theirs: string;
}

export class LockstepSession<S> {
  readonly self: PeerId;
  readonly participants: number;
  readonly inputDelay: number;

  private readonly transport: Transport;
  private readonly loop: RewindLoop<S>;
  private readonly inputs: InputLog;
  private readonly fingerprintEvery: number;
  private readonly compareStates: boolean;

  /** One buffer for the process. Sized for the largest message this session sends. */
  private readonly outgoing: Uint8Array;
  /** The last `redundancy` inputs this peer submitted, oldest first, flat. */
  private readonly recent: Uint8Array;
  private readonly redundancy: number;
  /** The tick the first payload in `recent` belongs to, or -1 before anything is submitted. */
  private recentFrom = -1;
  private recentCount = 0;
  private readonly decoded = createDecoded();
  private readonly scratchDigest = new Fingerprint();

  /** Digests we published, by tick, so a peer's claim has something to be compared against. */
  private readonly ourDigests = new Map<number, string>();

  private statusValue: LockstepStatus = 'running';
  private desyncValue: Desync | null = null;
  private haltReason = '';
  private confirmedValue = -1;
  /**
   * The highest tick this world has ever had every participant's real input for.
   *
   * **Separate from `confirmedValue`, and monotonic where that one is not.** `confirmedThrough`
   * answers for the window the log currently holds, and the session moves that window forward every
   * tick — so the moment retention passes a tick, the log stops being able to say anything about it
   * and the live watermark can drop. What was applied stays applied, which is the fact a redundant
   * copy has to be judged against, so it is kept here rather than asked of the log.
   */
  private appliedThrough = -1;

  constructor(options: LockstepOptions<S>) {
    this.transport = options.transport;
    this.loop = options.loop;
    this.inputs = options.inputs;
    this.self = options.self;
    this.participants = Math.max(1, options.participants);
    this.inputDelay = Math.max(0, Math.trunc(options.inputDelay ?? 2));
    this.fingerprintEvery = Math.max(1, Math.trunc(options.fingerprintEvery ?? 8));
    this.compareStates = options.compareStates ?? true;
    this.redundancy = Math.max(1, Math.trunc(options.redundancy ?? 4));
    this.recent = new Uint8Array(this.redundancy * this.inputs.inputBytes);
    this.outgoing = new Uint8Array(64 + this.redundancy * this.inputs.inputBytes);
  }

  get status(): LockstepStatus {
    return this.statusValue;
  }

  /** Why the session halted, or an empty string. */
  get reason(): string {
    return this.haltReason;
  }

  /** The disagreement that halted it, naming the tick it began at. */
  get desync(): Desync | null {
    return this.desyncValue;
  }

  /** The highest tick every participant's real input has arrived for. */
  get confirmed(): number {
    return this.confirmedValue;
  }

  /**
   * Publish this peer's input for `tick + inputDelay`, and record it locally at the same tick.
   *
   * **Recorded locally as well as sent, and that is not redundancy.** A peer's own input is not
   * echoed back to it, so without this the local simulation would predict its own controls — and a
   * player would feel their own input arrive late and get corrected, which is the one thing
   * prediction is supposed to prevent.
   */
  submit(tick: number, payload: Uint8Array): void {
    if (this.statusValue !== 'running') return;
    const at = tick + this.inputDelay;

    if (!this.inputs.holds(at)) {
      this.halt(`an input for tick ${at} is outside the log's window`);
      return;
    }
    this.inputs.set(this.self, at, payload);
    this.remember(at, payload);

    const length = encodeInput(
      this.outgoing,
      this.self,
      this.recentFrom,
      this.recent,
      this.inputs.inputBytes,
      this.recentCount,
    );
    if (length < 0) {
      this.halt(`an input of ${payload.length} bytes does not fit this session's buffer`);
      return;
    }
    this.transport.send(BROADCAST, this.outgoing.subarray(0, length));
  }

  /**
   * Keep this input, and the few before it, for the next packet to carry.
   *
   * Shifted rather than kept in a ring, because the run has to be **contiguous and in order** on
   * the wire: a receiver reads it as "these are the inputs for ticks `firstTick` onward", and a ring
   * would have to be unwrapped before sending anyway. `redundancy` is four, so the shift is three
   * copies of a handful of bytes.
   */
  private remember(tick: number, payload: Uint8Array): void {
    const stride = this.inputs.inputBytes;

    /* A gap — a tick submitted out of order, or the first one — restarts the run. */
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

  /**
   * Take everything the transport has and apply it.
   *
   * Called once per tick, before advancing. Never from a transport callback — see `transport.ts`
   * for why a message must not arrive in the middle of a step.
   */
  poll(): void {
    if (this.statusValue !== 'running') return;
    this.transport.drain((from, message) => this.receive(from, message));
  }

  /**
   * Advance one tick, then publish a fingerprint if this is a tick to publish one at.
   *
   * The rewind loop performs any pending correction first, so a late input that arrived during
   * `poll` is applied before this tick runs rather than after it.
   */
  advance(dt: number, tick: number): void {
    if (this.statusValue !== 'running') return;
    this.loop.advance(dt, tick);

    this.confirmedValue = this.inputs.confirmedThrough(tick);
    if (this.confirmedValue > this.appliedThrough) this.appliedThrough = this.confirmedValue;

    /* Everything below the oldest tick a rewind can reach is never needed again. */
    const earliest = this.loop.earliest;
    if (earliest > 0) this.inputs.retain(earliest);

    this.publishDigest();
  }

  /**
   * Publish a hash of the state at a **confirmed** tick, which is the only state worth comparing.
   *
   * **Not the live world, and this cost a healthy session at tick 32 during development.** The
   * newest tick is speculative: each peer has predicted inputs the other already knows, so their
   * live worlds differ constantly and correctly. A snapshot at a tick every participant's input has
   * arrived for was computed from the same inputs on both ends, and a disagreement there is a real
   * one.
   *
   * The slot for tick *T* holds the state as *T* began, so it is final once every input below *T*
   * is confirmed — which is what `confirmedThrough` answers.
   */
  private publishDigest(): void {
    if (!this.compareStates) return;
    const at = this.confirmedValue;
    if (at < 0 || at % this.fingerprintEvery !== 0) return;
    if (this.ourDigests.has(at)) return;

    const digest = this.loop.digestOf(at);
    if (digest === null) return;

    this.ourDigests.set(at, digest);
    this.forgetDigestsBefore(this.loop.earliest);
    const length = encodeFingerprint(this.outgoing, this.self, at, digest);
    if (length > 0) this.transport.send(BROADCAST, this.outgoing.subarray(0, length));
  }

  /** Stop the session with a reason. Public so a consumer can halt on their own condition. */
  halt(reason: string): void {
    if (this.statusValue === 'halted') return;
    this.statusValue = 'halted';
    this.haltReason = reason;
  }

  private receive(from: PeerId, message: Uint8Array): void {
    if (!decode(message, this.decoded)) return;

    if (this.decoded.kind === MESSAGE_INPUT) {
      const participant = this.decoded.participant;
      if (participant === this.self) return;

      const stride = this.decoded.payloadBytes;
      for (let i = 0; i < this.decoded.count; i++) {
        const tick = this.decoded.tick + i;
        const at = this.decoded.payloadAt + i * stride;
        const payload = message.subarray(at, at + stride);

        /*
         * **A tick already past the window is skipped rather than fatal, when the rest of the run
         * is still usable.** Redundancy means most of what arrives is a repeat, and the oldest entry
         * of a run naturally falls out of the window first — halting on that would end every
         * session the moment the redundancy window outran the rewind window. What is fatal is an
         * input this peer never had and can no longer apply, which is the case below.
         */
        if (this.inputs.isConfirmed(participant, tick)) continue;
        /*
         * **And the same skip for a tick the log can no longer answer for, which is the common
         * case rather than the edge one.** `isConfirmed` speaks for the window the log holds, and
         * retention drops everything below the oldest tick a rewind can reach — so on any session
         * whose redundancy reaches further back than that, the oldest word of a run arrives after
         * the slot that would have recognised it is gone, and a link that lost nothing halts.
         * A tick at or below this watermark had every participant's real input and was stepped
         * with it: a second copy cannot change this world and so cannot be evidence of a
         * divergence. Above the watermark nothing changes, halt included, and there it is right —
         * an input this peer never had and can no longer apply really is fatal.
         */
        if (tick <= this.appliedThrough) continue;
        if (this.loop.supply(participant, tick, payload)) continue;
        if (!this.inputs.holds(tick)) {
          this.halt(
            `an input from peer ${participant} for tick ${tick} arrived after the rewind window ` +
              'had passed it, so this world can no longer be made to match theirs',
          );
          return;
        }
      }
      return;
    }

    if (this.decoded.kind === MESSAGE_FINGERPRINT) {
      const ours = this.ourDigests.get(this.decoded.tick);
      /* A tick we never published a digest for, or have already forgotten. Not a disagreement. */
      if (ours === undefined) return;
      if (ours === this.decoded.digest) return;

      this.desyncValue = {
        tick: this.decoded.tick,
        peer: from === BROADCAST ? this.decoded.participant : from,
        ours,
        theirs: this.decoded.digest,
      };
      this.halt(
        `state diverged at tick ${this.decoded.tick}: this peer has ${ours}, peer ` +
          `${this.decoded.participant} has ${this.decoded.digest}`,
      );
    }
  }

  private forgetDigestsBefore(tick: number): void {
    if (tick <= 0) return;
    for (const at of this.ourDigests.keys()) {
      if (at < tick) this.ourDigests.delete(at);
    }
  }

  /** The shared digest builder, for a consumer whose `digestAt` wants one without allocating. */
  get digestBuilder(): Fingerprint {
    return this.scratchDigest;
  }
}
