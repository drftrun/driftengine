/** Aggregating everything an app is waiting on into one honest number. */

/**
 * One thing being waited for.
 *
 * `weight` is what makes the total mean anything. A progress bar that treats "decode 58 audio
 * tracks" and "read a settings file" as half each spends most of its life at 50%, which is worse
 * than no bar: it teaches a viewer that the bar is decoration. Weights are in whatever unit the
 * caller likes as long as they are the same unit — bytes are the obvious one because they are
 * usually known in advance, and a rough guess in "seconds this normally takes" also works.
 */
export interface LoadTask {
  /** Stable, and not for showing: a caller maps it to whatever words its audience needs. */
  readonly id: string;
  readonly weight: number;
  /** 0 to 1. */
  fraction: number;
  done: boolean;
}

export interface LoadSummary {
  /** 0 to 1 across everything registered, weighted. */
  readonly fraction: number;
  /**
   * The id of the task the caller should be talking about: the heaviest one still unfinished.
   *
   * Heaviest rather than first-registered, because that is the one a viewer is actually waiting
   * for. Empty when nothing is outstanding.
   */
  readonly activeId: string;
  readonly done: boolean;
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

/**
 * What an app is waiting on, as one weighted number.
 *
 * **Why this is in the engine.** Every consumer builds this, and every one of them builds it
 * slightly wrong in the same way: a bar driven by whichever load happens to report last, or a
 * fraction over a task count that jumps in sevenths, or a spinner that says nothing at all. None
 * of that is a game's decision — it is arithmetic over a set of things with sizes — so it belongs
 * here beside the things that produce the sizes. What stays with the consumer is every word: this
 * hands back ids and numbers, because what to *call* a stage depends entirely on who is reading.
 *
 * **It holds no clock and no DOM.** A caller polls `summary` in its own frame, so a tracker works
 * the same in a browser, a test and a headless bake.
 *
 * Deliberately small. It does not start work, own promises, retry, or time out: a task is
 * something the caller is already doing, and all this knows is how big it is and how far along.
 * Anything more would be a scheduler, which is a different thing with different failure modes.
 */
export class LoadTracker {
  private readonly tasks = new Map<string, LoadTask>();

  /**
   * Declare something to wait for, or re-declare it with a new weight.
   *
   * Registering the same id twice is deliberately allowed and is not a reset: a caller frequently
   * learns the real size of a thing after starting it — a fetch that finally reports its
   * `Content-Length`, a model whose manifest says how many parts are coming — and having to choose
   * between a wrong weight and a lost fraction would be a bad choice to force.
   */
  add(id: string, weight: number): void {
    const existing = this.tasks.get(id);
    const safeWeight = Number.isFinite(weight) && weight > 0 ? weight : 1;
    if (existing === undefined) {
      this.tasks.set(id, { id, weight: safeWeight, fraction: 0, done: false });
      return;
    }
    this.tasks.set(id, {
      id,
      weight: safeWeight,
      fraction: existing.fraction,
      done: existing.done,
    });
  }

  /** How far along one task is, 0 to 1. Unknown ids are ignored rather than thrown at. */
  report(id: string, fraction: number): void {
    const task = this.tasks.get(id);
    if (task === undefined) return;
    /*
     * Clamped and guarded, because this is fed by arithmetic a caller did — a division by a total
     * that has not arrived yet is one edit away, and a NaN here would spread to the whole bar and
     * then to whatever the bar drives.
     */
    const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    task.fraction = task.done ? 1 : safe;
  }

  /** Mark one finished, whatever it last reported. */
  finish(id: string): void {
    const task = this.tasks.get(id);
    if (task === undefined) return;
    task.fraction = 1;
    task.done = true;
  }

  /**
   * A task that turned out not to be needed: dropped from the total rather than completed.
   *
   * The distinction matters for the number. An optional asset that is absent — no model baked, a
   * track with no audio — is not 100% loaded, it is not part of this load at all, and counting it
   * as finished makes the bar say a thing arrived that never did.
   */
  drop(id: string): void {
    this.tasks.delete(id);
  }

  /** Nothing to wait for. A tracker with no tasks is done, which is the useful answer. */
  get summary(): LoadSummary {
    let weighted = 0;
    let total = 0;
    let doneCount = 0;
    let activeId = '';
    let activeWeight = -1;
    for (const task of this.tasks.values()) {
      total += task.weight;
      weighted += task.weight * (task.done ? 1 : task.fraction);
      if (task.done) doneCount++;
      else if (task.weight > activeWeight) {
        activeWeight = task.weight;
        activeId = task.id;
      }
    }
    return {
      fraction: total > 0 ? Math.min(1, weighted / total) : 1,
      activeId,
      done: activeId === '',
      tasksDone: doneCount,
      tasksTotal: this.tasks.size,
    };
  }

  /** Every task, for a caller that wants to show a line each rather than one bar. */
  get entries(): readonly LoadTask[] {
    return [...this.tasks.values()];
  }

  clear(): void {
    this.tasks.clear();
  }
}
