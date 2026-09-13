export interface AiCommand {
  readonly kind: 'command';
  readonly toolId: string;
  readonly args: unknown;
  readonly agentId: string;
  /** The tick the model was asked. */
  readonly issuedAtTick: number;
  /** The tick the command crossed into the simulation. */
  readonly acceptedAtTick: number;
}

/**
 * An observation that ended the current intent early.
 *
 * Recorded for the same reason a command is: it cannot be recomputed. The floor is
 * deterministic and replays by rerunning, but an observation is *external input* —
 * the same class of thing as a keypress — and nothing in the simulation derives it.
 * Without this, a replay reruns the floor past the moment it was interrupted and
 * diverges from there on.
 */
export interface AiPreemption {
  readonly kind: 'preemption';
  readonly agentId: string;
  readonly acceptedAtTick: number;
}

export type LogEntry = AiCommand | AiPreemption;

/**
 * What was accepted, and when — beside `TickTrace` rather than inside it.
 *
 * `TickTrace` is `Float32Array` channels plus a `Uint8Array` of flags, sampled per
 * tick. A command carries a string id and structured arguments, and boxing those into
 * float channels is not a design, it is a defeat. This borrows the ring-buffer
 * discipline and the tick indexing and shares nothing else, which answers the question
 * §33 of the parent design left open for AI-2.
 *
 * *What it costs:* two ring buffers where a reader might expect one place to look.
 * *What would make it wrong:* if a consumer needed one ordered stream of both, this
 * would need a merge read rather than a merged store — the storage shapes have no
 * common representation worth finding.
 */
export class CommandLog {
  private readonly entries: (LogEntry | undefined)[];
  private cursor = 0;
  private filled = 0;

  constructor(capacity = 256) {
    this.entries = new Array<LogEntry | undefined>(Math.max(1, capacity | 0));
  }

  /** How many commands are still retained, not how many were ever recorded. */
  get length(): number {
    return this.filled;
  }

  record(entry: LogEntry): void {
    this.entries[this.cursor] = entry;
    this.cursor = (this.cursor + 1) % this.entries.length;
    if (this.filled < this.entries.length) this.filled++;
  }

  /**
   * Commands accepted at exactly this tick, in acceptance order, written into `out`.
   *
   * Returns the count written. Reading a tick allocates nothing, because a replay
   * reads every tick and a per-tick array would put an allocation on that path.
   */
  at(tick: number, out: LogEntry[]): number {
    let written = 0;
    const size = this.entries.length;
    const start = this.filled < size ? 0 : this.cursor;

    for (let i = 0; i < this.filled; i++) {
      const entry = this.entries[(start + i) % size];
      if (entry === undefined || entry.acceptedAtTick !== tick) continue;
      out[written++] = entry;
    }
    return written;
  }
}
