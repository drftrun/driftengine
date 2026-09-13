/**
 * What every participant did on every retained tick, and what was guessed for them.
 *
 * **An input is a fixed number of bytes a consumer declares.** That is a constraint and it buys the
 * whole allocation story: one `Uint8Array` for the session, indexed by participant and tick, so
 * neither recording an input nor reading one back during a replay allocates anything. It costs a
 * consumer having to fit an input into a known size, which for a simulation input is what they
 * already are — a bitfield of buttons and a couple of axes — and it refuses the one shape that
 * would break it, which is an input carrying a variable-length payload like a chat message. Those
 * are not simulation inputs and do not belong on this path.
 *
 * **A predicted input is stored, not computed on read.** A replay has to see the same guess the
 * first run saw, or the ticks it re-runs differ from the ticks it is replaying for a reason that has
 * nothing to do with the correction being applied. So a missing input is guessed *once*, written
 * into its slot and marked unconfirmed; a later real input overwrites it and says whether it
 * differed.
 *
 * ---
 *
 * ## The window is explicit, because a ring that evicts silently is the bug here
 *
 * The obvious shape is a ring indexed by `tick % depth`, and it is wrong in a way that only shows
 * up on a real link. Inputs arrive **ahead** of the local simulation — a peer three ticks in front
 * sends tick 45 while this one is simulating 42 — and with a depth of eight, tick 45 lands in the
 * slot tick 37 occupies. Tick 37 is inside the rewind window and its confirmed input has just been
 * thrown away, so a rewind to 37 re-predicts an input it already knew, and the world quietly
 * changes under a correction that was supposed to be about something else.
 *
 * So the window is a range this log is told about. `retain(oldest)` moves it, dropping what falls
 * off the back; a tick outside it is **refused** rather than stored somewhere convenient. A depth
 * therefore has to cover the rewind distance behind the current tick *and* the lookahead in front
 * of it, which is why the session that owns one sizes it as the sum and not as the rewind depth.
 *
 * ## Repeat-the-last, and why the default is stated rather than hidden
 *
 * A missing input is guessed by repeating that participant's last known one. That is right for a
 * held control and wrong for a tap, and nothing in an engine can know which a given game has: a
 * racing game's throttle is held, a fighting game's punch is not. So the default is documented and
 * `predict` is replaceable.
 */

/** How a missing input is guessed. `previous` is that participant's last confirmed input. */
export type InputPredictor = (
  participant: number,
  tick: number,
  previous: Uint8Array,
  out: Uint8Array,
) => void;

/** Repeat the last input seen from that participant. See the header for when this is wrong. */
export const repeatLastInput: InputPredictor = (_participant, _tick, previous, out) => {
  out.set(previous);
};

export interface InputLogOptions {
  readonly participants: number;
  /**
   * Retained ticks, covering the rewind window behind the current tick **and** the inputs that
   * arrive ahead of it. See the header: this is not the rewind depth.
   */
  readonly depth: number;
  readonly inputBytes: number;
  readonly predict?: InputPredictor;
}

export class InputLog {
  readonly participants: number;
  readonly depth: number;
  readonly inputBytes: number;

  private readonly bytes: Uint8Array;
  /** Which tick each (participant, slot) holds, or -1. */
  private readonly slotTick: Int32Array;
  /** 1 when the value in the slot came from that participant, 0 when it was guessed. */
  private readonly confirmed: Uint8Array;
  /** The last confirmed input per participant, for the predictor. */
  private readonly previous: Uint8Array;
  private readonly scratch: Uint8Array;
  private readonly predict: InputPredictor;

  /** The oldest tick this log will accept. The window is `[oldest, oldest + depth)`. */
  private oldest = 0;

  constructor(options: InputLogOptions) {
    this.participants = Math.max(1, Math.trunc(options.participants));
    this.depth = Math.max(1, Math.trunc(options.depth));
    this.inputBytes = Math.max(1, Math.trunc(options.inputBytes));
    this.predict = options.predict ?? repeatLastInput;

    const slots = this.participants * this.depth;
    this.bytes = new Uint8Array(slots * this.inputBytes);
    this.slotTick = new Int32Array(slots).fill(-1);
    this.confirmed = new Uint8Array(slots);
    this.previous = new Uint8Array(this.participants * this.inputBytes);
    this.scratch = new Uint8Array(this.inputBytes);
  }

  /** The oldest tick this log holds. Everything below it has been dropped. */
  get windowStart(): number {
    return this.oldest;
  }

  /** One past the newest tick this log will accept. */
  get windowEnd(): number {
    return this.oldest + this.depth;
  }

  /** Whether a tick is inside the window at all. */
  holds(tick: number): boolean {
    return tick >= this.oldest && tick < this.oldest + this.depth;
  }

  /**
   * Move the window so `oldest` is the earliest tick kept, forgetting what falls off.
   *
   * The slots that leave are cleared rather than left, because their `slotTick` would otherwise
   * match a tick a whole window later and answer a stale input as a confirmed one.
   */
  retain(oldest: number): void {
    const next = Math.max(0, Math.trunc(oldest));
    if (next <= this.oldest) return;

    for (let p = 0; p < this.participants; p++) {
      for (let slot = 0; slot < this.depth; slot++) {
        const index = p * this.depth + slot;
        const at = this.slotTick[index] as number;
        if (at >= 0 && at < next) {
          this.slotTick[index] = -1;
          this.confirmed[index] = 0;
        }
      }
    }
    this.oldest = next;
  }

  /**
   * Record a real input. **`true` when this changed what the slot held**, which is what tells a
   * rewind whether it has anything to do. `false` also means refused, for a tick outside the
   * window — see `holds` to tell the two apart when it matters.
   *
   * A confirmed input matching the guess is the common case on a held control, and replaying for
   * it would burn a rewind to produce the identical world.
   */
  set(participant: number, tick: number, payload: Uint8Array): boolean {
    const slot = this.slotOf(participant, tick);
    if (slot < 0) return false;
    const at = slot * this.inputBytes;

    /*
     * **Changed means the bytes changed, and deliberately not "was unconfirmed and now is".**
     * A guess that turns out byte-identical to the real input costs a replay nothing, because the
     * replay would re-run the same ticks with the same values and arrive at the same world. On any
     * held control that is the common case, so treating confirmation as a change would burn a
     * rewind per packet to reproduce what is already on screen. What confirmation changes is
     * `confirmedThrough`, which is a different question from whether the world is wrong.
     */
    const held = this.slotTick[slot] === tick;
    let changed = !held;
    if (held) {
      for (let i = 0; i < this.inputBytes; i++) {
        if (this.bytes[at + i] !== (payload[i] ?? 0)) {
          changed = true;
          break;
        }
      }
    }

    for (let i = 0; i < this.inputBytes; i++) this.bytes[at + i] = payload[i] ?? 0;
    this.slotTick[slot] = tick;
    this.confirmed[slot] = 1;

    /* The newest confirmed input is what the predictor repeats, so an input arriving out of order
       must not overwrite a newer one. */
    if (this.newestConfirmed(participant) <= tick) {
      const previousAt = participant * this.inputBytes;
      for (let i = 0; i < this.inputBytes; i++) this.previous[previousAt + i] = payload[i] ?? 0;
    }

    return changed;
  }

  /**
   * The input to simulate with, guessing and storing one if none has arrived.
   *
   * **`false` means it was guessed**, or that the tick is outside the window, in which case `out` is
   * zeroed. A caller deciding whether a tick can be confirmed reads that; a caller simulating does
   * not care, because either way `out` holds the bytes this tick ran with, now and on every replay.
   */
  into(participant: number, tick: number, out: Uint8Array): boolean {
    const slot = this.slotOf(participant, tick);
    if (slot < 0) {
      out.fill(0);
      return false;
    }
    const at = slot * this.inputBytes;

    if (this.slotTick[slot] !== tick) {
      const previousAt = participant * this.inputBytes;
      for (let i = 0; i < this.inputBytes; i++) {
        this.scratch[i] = this.previous[previousAt + i] as number;
      }
      this.predict(participant, tick, this.scratch, out);
      for (let i = 0; i < this.inputBytes; i++) this.bytes[at + i] = out[i] ?? 0;
      this.slotTick[slot] = tick;
      this.confirmed[slot] = 0;
      return false;
    }

    for (let i = 0; i < this.inputBytes; i++) out[i] = this.bytes[at + i] as number;
    return this.confirmed[slot] === 1;
  }

  /** Whether a real input for this participant and tick has arrived. */
  isConfirmed(participant: number, tick: number): boolean {
    const slot = this.slotOf(participant, tick);
    if (slot < 0) return false;
    return this.slotTick[slot] === tick && this.confirmed[slot] === 1;
  }

  /** Whether every participant's input for this tick has arrived. What lockstep advances on. */
  isComplete(tick: number): boolean {
    for (let p = 0; p < this.participants; p++) {
      if (!this.isConfirmed(p, tick)) return false;
    }
    return true;
  }

  /**
   * The highest tick at or below `upTo` such that **every** tick from the window's start up to it is
   * complete, or -1.
   *
   * Walked upward from the start of the window and stopped at the first gap, which is the property
   * that matters: ticks 40 and 42 confirmed with 41 missing is not a session confirmed to 42, and
   * answering 42 would let a peer discard the snapshot it still needs to correct 41.
   */
  confirmedThrough(upTo: number): number {
    let answer = -1;
    for (let at = this.oldest; at <= upTo && at < this.oldest + this.depth; at++) {
      if (!this.isComplete(at)) break;
      answer = at;
    }
    return answer;
  }

  /** The newest tick this participant has a confirmed input for, or -1. */
  private newestConfirmed(participant: number): number {
    let newest = -1;
    for (let slot = 0; slot < this.depth; slot++) {
      const index = participant * this.depth + slot;
      if (this.confirmed[index] !== 1) continue;
      const at = this.slotTick[index] as number;
      if (at > newest) newest = at;
    }
    return newest;
  }

  private slotOf(participant: number, tick: number): number {
    if (participant < 0 || participant >= this.participants) return -1;
    if (!this.holds(tick)) return -1;
    return participant * this.depth + (tick % this.depth);
  }
}
