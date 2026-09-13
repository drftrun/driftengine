/**
 * Rewind and replay: the one mechanism both networking models sit on.
 *
 * **Prediction and rollback are the same operation seen from two sides.** A lockstep peer that
 * guessed a remote input and then learned the real one has to unwind the ticks it computed from the
 * guess. A predicting client whose authority disagrees has to unwind the ticks it computed from a
 * world that was wrong. Both are: put the state back to tick *T*, correct what was wrong about *T*,
 * and step forward again to where we were. So there is one driver, and §7 of the design is why
 * there is not one per model.
 *
 * ---
 *
 * ## What this owns, and what it refuses to own
 *
 * It owns the ring of snapshots, the input log, and the replay. It owns **no** transport, no wire
 * format and no knowledge of what an input *is*: a payload is bytes a consumer encodes, because an
 * engine that knows a player presses a brake pedal has stopped being game-agnostic. `AGENTS.md`
 * states that rule and this is the place most netcode breaks it.
 *
 * ## Why a snapshot is taken before the step and not after
 *
 * `advance(dt, T)` saves, then steps. So slot *T* holds the world **as it was when tick T began**,
 * which is exactly what a rewind to *T* wants: the input for *T* is about to be applied, and
 * applying it to the state after *T* would double it. Saving after the step would make every rewind
 * land one tick late, which is the kind of error that produces a world that drifts slowly rather
 * than one that breaks.
 *
 * ## Late inputs are batched into one rewind
 *
 * `supply` records the earliest tick that became wrong and returns; the rewind happens on the next
 * `advance`. Three inputs arriving in one network drain, for ticks 40, 41 and 42, cost one replay
 * from 40 instead of three replays from 40, 41 and 42. It also means a consumer cannot forget to
 * ask for the rewind, since the thing they call every tick performs it.
 *
 * ## A tick can be stepped many times, and anything a step *emits* has to know that
 *
 * **This owns state, and an effect is not state.** A rewind restores the world and steps forward
 * again, so a step for tick *T* runs once when it is first predicted and again after every
 * correction that reaches back past it — and everything that step *emitted* the first time is
 * emitted again. Snapshots put the world back; they cannot un-play a sound, un-send a packet or
 * un-spawn a decal.
 *
 * The symptom is a doubled impact on a corrected frame, reported from outside and the reason this
 * section exists. It is not a defect in the rewind: replaying a tick is the whole mechanism, and a
 * step that is not re-runnable is a step that cannot be part of one.
 *
 * **What the engine will not do about it, and why.** Deduplicating an emission needs to know what
 * counts as the same emission — which sound, from which event, at which tick — and that is a
 * game's vocabulary rather than an engine's, the same line `AGENTS.md` draws about a payload being
 * bytes. A table of tick and event id already emitted, cleared behind the rewind window, is about
 * thirty lines in a consumer and knows exactly what an event is.
 *
 * **What to do instead**, in the order that costs least: keep effects out of the fixed step and
 * emit them from the frame instead, reading state the step left behind; or, where an effect really
 * belongs to a tick, gate it on that table. A session's `confirmed` — `LockstepSession` and
 * `ScriptSession` both expose it — is the tick past which nothing can be rewound, so it is the
 * watermark such a table can be cleared behind.
 */
import type { InputLog } from './inputLog.ts';

/**
 * Somewhere state can be put and taken back.
 *
 * Generic over its own slot type, so a rewind needs no serialization at all: a snapshot never
 * leaves the process. `@driftengine/entities` supplies one implementation through
 * `worldSnapshotter`, and a consumer whose simulation state is four typed arrays writes another in
 * thirty lines without touching anything here. That is the `AGENTS.md` rule about platform
 * capabilities applied to state.
 */
export interface Snapshotter<S> {
  /** A reusable slot. Called once per ring position, never on a tick. */
  create(): S;
  save(into: S): void;
  restore(from: S): void;
  /**
   * A hash of what a slot holds, for comparing this peer's world against another's.
   *
   * **On the snapshotter rather than beside it, because the thing that knows how to save state is
   * the thing that knows how to hash it.** A consumer with their own state writes one function and
   * both mechanisms work; two seams would mean writing it twice and keeping them in step.
   *
   * Optional: a session that never compares worlds needs none.
   */
  digest?(from: S): string;
}

/**
 * One fixed step. The signature `LoopHooks.simulate` has, so a consumer passes theirs straight in.
 *
 * **It may be called more than once for the same `tick`.** That is the mechanism rather than an
 * edge case: every correction reaching back past a tick replays it. A step that only reads and
 * writes simulation state is re-runnable by construction; one that plays a sound, sends a packet or
 * appends to a log is not, and will do that thing again. See this file's header.
 */
export type SimStep = (dt: number, tick: number) => void;

export interface RewindOptions<S> {
  readonly step: SimStep;
  readonly snapshotter: Snapshotter<S>;
  readonly inputs: InputLog;
  /**
   * Seconds per fixed step, and it must be the loop's.
   *
   * Required rather than defaulted, because a replay that stepped a different delta from the run it
   * is replaying produces a different world while looking entirely healthy.
   */
  readonly fixedDt: number;
  /**
   * How many ticks back a rewind can reach. Eight at 60 Hz is 133 ms.
   *
   * The cost is one snapshot per tick of depth, held for the life of the session. §15 of the design
   * carries the measurement.
   */
  readonly depth?: number;
}

export class RewindLoop<S> {
  readonly depth: number;
  readonly fixedDt: number;
  readonly inputs: InputLog;

  private readonly step: SimStep;
  private readonly snapshotter: Snapshotter<S>;
  private readonly slots: S[] = [];
  /** Which tick each ring position holds, or -1. Guards against a modulo aliasing two ticks. */
  private readonly slotTick: Int32Array;

  /** The last tick handed to `step`, or -1 before the first. */
  private lastStepped = -1;
  /** The earliest tick a late arrival invalidated, or -1. Consumed by the next `advance`. */
  private dirtyFrom = -1;
  private replaying = false;
  private replays = 0;
  private replayedTicks = 0;

  constructor(options: RewindOptions<S>) {
    this.depth = Math.max(1, Math.trunc(options.depth ?? 8));
    this.fixedDt = options.fixedDt;
    this.step = options.step;
    this.snapshotter = options.snapshotter;
    this.inputs = options.inputs;
    this.slotTick = new Int32Array(this.depth).fill(-1);
    for (let i = 0; i < this.depth; i++) this.slots.push(this.snapshotter.create());
  }

  /** The last tick that was stepped. -1 before anything has run. */
  get tick(): number {
    return this.lastStepped;
  }

  /** Whether `step` is being called by a replay. See `isReplaying` for why a consumer may care. */
  get isReplaying(): boolean {
    return this.replaying;
  }

  /** How many rewinds have happened, and how many ticks they re-ran. For a consumer's diagnostics. */
  get stats(): { readonly replays: number; readonly replayedTicks: number } {
    return { replays: this.replays, replayedTicks: this.replayedTicks };
  }

  /** The oldest tick a rewind can still reach, or -1 when nothing is retained. */
  get earliest(): number {
    let oldest = -1;
    for (let i = 0; i < this.depth; i++) {
      const at = this.slotTick[i] as number;
      if (at >= 0 && (oldest < 0 || at < oldest)) oldest = at;
    }
    return oldest;
  }

  /**
   * Take one tick: settle any pending rewind, save the world as this tick begins, then step.
   *
   * The tick comes from the loop rather than being counted here, so there is one source of truth
   * for it. Handing back a tick already stepped is refused, because it would overwrite a snapshot
   * a rewind may still need and there is no reading of it that is not a caller's bug.
   */
  advance(dt: number, tick: number): void {
    if (tick <= this.lastStepped) {
      throw new Error(
        `tick ${tick} was already advanced (the last was ${this.lastStepped}). A rewind is ` +
          '`supply` or `reconcile` followed by the next `advance`, never an `advance` of a tick ' +
          'that has run.',
      );
    }
    this.settle();
    this.record(tick);
    this.run(dt, tick);
  }

  /**
   * An input arrived. `false` when it is for a tick this loop can no longer reach.
   *
   * A refusal rather than a silent drop, because an input outside the rewind window means the
   * session has diverged from this peer's world and nothing local can repair it — which is
   * information a consumer needs, and is the point at which a lockstep session should stall rather
   * than continue.
   */
  supply(participant: number, tick: number, payload: Uint8Array): boolean {
    /*
     * The log's window is asked before the log is written, because `InputLog.set` answers `false`
     * for a refusal and for an input that changed nothing, and those want telling apart here: one
     * is a session that has diverged beyond repair and the other is the ordinary case on a held
     * control. The two windows are also not the same length — the log holds the lookahead as well
     * as the rewind distance — so both are checked.
     */
    if (!this.inputs.holds(tick)) return false;

    const changed = this.inputs.set(participant, tick, payload);
    if (!changed) return true;

    /* Only a tick that has already been *stepped* invalidates anything. An input arriving early is
       simply an input, and needs no replay. */
    if (tick > this.lastStepped) return true;
    if (this.earliest < 0 || tick < this.earliest) return false;

    this.dirtyFrom = this.dirtyFrom < 0 ? tick : Math.min(this.dirtyFrom, tick);
    return true;
  }

  /**
   * An authoritative state for `tick` arrived: put the world back there, let `apply` overwrite what
   * the authority owns, and replay the local ticks since.
   *
   * **This is the operation a late input is not.** A late input means the ticks since were computed
   * from a wrong *input*; an authoritative state means they were computed from a wrong *world*. So
   * the snapshot for that tick is corrected and re-saved before the replay, and the local inputs are
   * kept, which is what makes a correction converge instead of erasing what the player did.
   *
   * `false` when the tick is outside the window, which for a client means the correction is older
   * than its own history and the honest response is to accept the authority's state whole.
   */
  reconcileSnapshot(tick: number, apply: () => void): boolean {
    const slot = this.slotFor(tick);
    if (slot < 0) return false;

    const target = this.lastStepped;
    this.snapshotter.restore(this.slots[slot] as S);
    apply();
    /* Re-saved, so a *second* correction for this tick starts from the corrected world rather than
       from the prediction that has already been overruled once. */
    this.snapshotter.save(this.slots[slot] as S);

    this.replayFrom(tick, target);
    this.dirtyFrom = -1;
    return true;
  }

  /**
   * Put the world back to the beginning of `tick` and replay to where it was.
   *
   * Public because lag compensation needs it — an authority rewinding to a shooter's view of the
   * past is a real technique and a fairness policy an engine should not choose. The design refuses
   * to implement that policy and exposes the machinery for it, with the reason in §16.
   */
  rewindTo(tick: number): boolean {
    const slot = this.slotFor(tick);
    if (slot < 0) return false;
    const target = this.lastStepped;
    this.snapshotter.restore(this.slots[slot] as S);
    this.replayFrom(tick, target);
    this.dirtyFrom = -1;
    return true;
  }

  /** Perform a pending rewind, if a late arrival left one. Called by `advance`. */
  private settle(): void {
    if (this.dirtyFrom < 0) return;
    const from = this.dirtyFrom;
    this.dirtyFrom = -1;
    const slot = this.slotFor(from);
    if (slot < 0) return;
    const target = this.lastStepped;
    this.snapshotter.restore(this.slots[slot] as S);
    this.replayFrom(from, target);
  }

  /**
   * Re-run `from` through `to` inclusive, saving each tick's opening state as it goes.
   *
   * The snapshots are rewritten during a replay and that is required, not incidental: a second
   * rewind to a tick inside this range has to find the state that tick began with *this* time, not
   * the state it began with under the inputs that have since been corrected.
   */
  private replayFrom(from: number, to: number): void {
    this.replaying = true;
    this.replays += 1;
    try {
      for (let at = from; at <= to; at++) {
        this.record(at);
        this.replayedTicks += 1;
        this.run(this.fixedDt, at);
      }
    } finally {
      this.replaying = false;
    }
    this.lastStepped = to;
  }

  private run(dt: number, tick: number): void {
    this.step(dt, tick);
    if (tick > this.lastStepped) this.lastStepped = tick;
  }

  /** Save the world as `tick` begins into that tick's ring position. */
  private record(tick: number): void {
    const slot = tick % this.depth;
    this.snapshotter.save(this.slots[slot] as S);
    this.slotTick[slot] = tick;
  }

  /**
   * A hash of the state as `tick` began, or null when that tick is not retained or the snapshotter
   * offers no digest.
   *
   * **A slot rather than the live world, and that distinction is the whole of it.** The live world
   * is at the newest tick and is *speculative*: it was computed from predictions for inputs that
   * have not arrived. Two peers comparing their live worlds disagree constantly and correctly,
   * because each has predicted what the other already knows. A slot at a confirmed tick was
   * computed from inputs both of them have, which is the only state worth comparing — and getting
   * this wrong halted a healthy session at tick 32 during development.
   */
  digestOf(tick: number): string | null {
    const digest = this.snapshotter.digest;
    if (digest === undefined) return null;
    const slot = this.slotFor(tick);
    if (slot < 0) return null;
    return digest.call(this.snapshotter, this.slots[slot] as S);
  }

  /** The ring position holding `tick`, or -1 if it holds a different one. */
  private slotFor(tick: number): number {
    if (tick < 0) return -1;
    const slot = ((tick % this.depth) + this.depth) % this.depth;
    return this.slotTick[slot] === tick ? slot : -1;
  }
}
