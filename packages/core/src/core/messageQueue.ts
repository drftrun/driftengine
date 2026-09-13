/**
 * One transient message at a time, in priority order.
 *
 * Games fire events in bursts — finishing a run can produce three at once — and
 * three notifications stacked on top of each other is worse than one, because
 * the player reads none of them. This holds the backlog and hands back a single
 * current message, so the presentation layer never has to decide what to drop.
 *
 * Pure state and no DOM: what a notification *looks* like is the game's, and
 * the part with rules worth pinning down is which one is on screen.
 */
export interface QueuedMessage {
  /** Identity, used to collapse a repeat of the same event. */
  readonly id: string;
  /** Higher wins, both for ordering and for interrupting. */
  readonly priority: number;
  /** How long it holds the screen once current. */
  readonly durationMs: number;
}

export interface MessageQueueOptions {
  /**
   * How long the same id is ignored after being shown.
   *
   * The realistic source of duplicates is a caller pushing from a per-frame
   * check rather than an edge — sixty identical toasts a second, a bug that
   * presents as the interface freezing on one message.
   */
  readonly dedupeWindowMs?: number;
  /**
   * Backlog ceiling. Without one, a caller pushing in a loop grows the queue
   * forever and the player spends the next minute watching notifications from
   * something that happened once.
   */
  readonly maxPending?: number;
}

export class MessageQueue<T extends QueuedMessage = QueuedMessage> {
  private readonly pending: T[] = [];
  private readonly lastShown = new Map<string, number>();
  private readonly dedupeWindowMs: number;
  private readonly maxPending: number;

  private showing: T | null = null;
  private showingUntil = 0;

  constructor(options: MessageQueueOptions = {}) {
    this.dedupeWindowMs = options.dedupeWindowMs ?? 900;
    this.maxPending = options.maxPending ?? 6;
  }

  get current(): T | null {
    return this.showing;
  }

  push(message: T): void {
    this.pending.push(message);
    if (this.pending.length <= this.maxPending) return;
    // Drop the least important rather than the oldest: a backlog that has
    // overflowed is exactly when the one thing that mattered must survive.
    let worst = 0;
    for (let i = 1; i < this.pending.length; i++) {
      const candidate = this.pending[i];
      const incumbent = this.pending[worst];
      if (candidate === undefined || incumbent === undefined) continue;
      if (candidate.priority < incumbent.priority) worst = i;
    }
    this.pending.splice(worst, 1);
  }

  /**
   * Advance. Returns a message only on the frame it becomes current, so the
   * caller can render it once rather than diffing against what it drew last.
   */
  update(nowMs: number): T | null {
    if (this.showing !== null) {
      /*
       * Peeked, not taken. Removing the challenger and pushing it back when it
       * loses reordered the backlog on every single frame, so two equally
       * important messages arrived in whichever order the frame boundary
       * happened to fall — which is not an order at all.
       */
      const challenger = this.pending[this.bestIndex(nowMs)];
      // Something more important interrupts; anything else waits its turn. A
      // personal best arriving during a minor toast is the moment of the run,
      // and making it queue behind one buries it.
      if (challenger !== undefined && challenger.priority > this.showing.priority) {
        const taken = this.takeBest(nowMs);
        if (taken !== null) {
          this.pending.push(this.showing);
          return this.show(taken, nowMs);
        }
      }
      if (nowMs < this.showingUntil) return null;
      this.showing = null;
    }

    const next = this.takeBest(nowMs);
    return next === null ? null : this.show(next, nowMs);
  }

  /** Drop everything, including what is on screen — as a restart must. */
  clear(): void {
    this.pending.length = 0;
    this.lastShown.clear();
    this.showing = null;
    this.showingUntil = 0;
  }

  private show(message: T, nowMs: number): T {
    this.showing = message;
    this.showingUntil = nowMs + message.durationMs;
    this.lastShown.set(message.id, nowMs);
    return message;
  }

  private takeBest(nowMs: number): T | null {
    const index = this.bestIndex(nowMs);
    if (index < 0) return null;
    return this.pending.splice(index, 1)[0] ?? null;
  }

  /**
   * Index of the highest-priority pending message, dropping recent repeats on
   * the way past. Ties go to the earliest, so equally important events arrive
   * in the order they actually happened.
   */
  private bestIndex(nowMs: number): number {
    let best = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const candidate = this.pending[i];
      if (candidate === undefined) continue;

      const shownAt = this.lastShown.get(candidate.id);
      if (shownAt !== undefined && nowMs - shownAt < this.dedupeWindowMs) {
        this.pending.splice(i, 1);
        i--;
        continue;
      }
      const incumbent = this.pending[best];
      if (incumbent === undefined || candidate.priority > incumbent.priority) best = i;
    }
    return best;
  }
}
