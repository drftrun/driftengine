/**
 * Spending a slice of a frame on work that can stop, without spending more than the slice.
 *
 * A **budgeted step pump**: the caller has some job — building a square of world, uploading a
 * mesh, decoding a model — that can be broken into indivisible units, and wants to advance it
 * a little every frame without the frame noticing. This holds the clock and the arithmetic;
 * the caller holds the work and decides what to do next.
 *
 * **What it guarantees, in the honest words:** a call costs the larger of the budget and one
 * uninterrupted stop. Not the budget. A stop cannot be interrupted from outside, so the only
 * way to bound a call by the budget alone would be to bound every stop, which is the caller's
 * job and not this one's — see `worstIn`, which exists to say which of the caller's units is
 * the one over the line.
 *
 * **Why this rather than a count of units.** A count bounds the cheap term and leaves the
 * expensive one free. `assets/uploadBudget.ts` records the measurement that established it:
 * the parts of a model cost between 6 and 254 ms each, so three per frame was three of
 * whatever they happened to be. The clock is exact, needs no per-asset tuning, and is as
 * right on a phone as on a workstation.
 *
 * Nothing here touches a renderer or a device, on purpose: the property worth testing is a
 * whole number of stops, and a test that needed a GPU could not assert it.
 */

/** A per-call decay of the guard: a half-life of sixty-nine calls, a little over a second at 60 Hz. */
const DEFAULT_FORGET = 0.99;

export interface StepBudgetOptions {
  /**
   * The clock, in milliseconds.
   *
   * Injected so a test can move time by hand. Every property this class has is a whole number
   * of milliseconds and a whole number of stops; measuring them against a real clock would be
   * measuring the machine the suite ran on.
   */
  readonly now?: () => number;
  /**
   * How fast the worst-stop estimate forgets, as a factor applied once per call.
   *
   * One per cent by default, and the number is load-bearing. Five per cent was tried by a
   * consumer and is wrong: the estimate falls below the real cost inside a single crossing of
   * a town, the guard lets a second stop start with no room for it, and a call costs the
   * budget *plus* a stop rather than the larger of the two — which is the whole thing the
   * guard exists to prevent.
   */
  readonly forget?: number;
}

export class StepBudget<Label = string> {
  private readonly clock: () => number;
  private readonly forget: number;

  /**
   * What one more stop is assumed to cost, and therefore whether there is room for it.
   *
   * The largest stop seen so far, decayed a little each call. It starts at zero, which means
   * the first call of a program's life overshoots by one stop and learns from it — the price
   * of not asking a caller to declare a number it cannot know.
   */
  private guard = 0;

  private worstEver = 0;
  private worstEverIn: Label | null = null;

  constructor(options: StepBudgetOptions = {}) {
    this.clock = options.now ?? ((): number => performance.now());
    this.forget = options.forget ?? DEFAULT_FORGET;
  }

  /** What one more stop is currently assumed to cost. Decays; see `StepBudgetOptions.forget`. */
  get estimate(): number {
    return this.guard;
  }

  /** The longest single stop ever taken. Does not decay: this is the report, not the guard. */
  get worst(): number {
    return this.worstEver;
  }

  /**
   * The label the caller gave the longest stop.
   *
   * **A budget being blown is useless information without the name of the unit that blew it.**
   * That is the whole reason `next` returns a label rather than a boolean: "the worst stop was
   * 57 ms" sends a reader nowhere, and "the worst stop was 57 ms, in upload" sends them to one
   * file.
   */
  get worstIn(): Label | null {
    return this.worstEverIn;
  }

  /**
   * Advance the caller's work for up to `budgetMs`, and say how many stops that took.
   *
   * `next` performs exactly one indivisible unit and returns a label naming what it did, or
   * `null` when there is nothing left to do — which ends the call without counting a stop.
   *
   * **Return the label of the work just done, not of the work about to be done.** The two are
   * easy to confuse where a job names its own next phase, and the report that results sends a
   * reader to the wrong builder every time the phase changes.
   *
   * The two rules the loop is made of, both arrived at by getting them wrong first:
   *
   * - *Do not start what you cannot finish.* A driver that keeps going while any budget
   *   remains overshoots by a whole stop. Measured by a consumer at 30 Hz: 8.3 ms of budget
   *   plus an 8.6 ms stop against a frame of 16.7.
   * - *But always do one.* Without the unconditional first stop, a unit costing more than the
   *   whole budget means nothing ever advances at all, and a world that never loads is worse
   *   than a frame that runs long.
   */
  spend(budgetMs: number, next: () => Label | null): number {
    const started = this.clock();
    let stops = 0;

    for (;;) {
      const elapsed = this.clock() - started;
      if (stops > 0 && elapsed + this.guard > budgetMs) break;

      const began = this.clock();
      const did = next();
      if (did === null) break;
      const took = this.clock() - began;

      if (took > this.guard) this.guard = took;
      if (took > this.worstEver) {
        this.worstEver = took;
        this.worstEverIn = did;
      }
      stops += 1;
    }

    /* And the estimate forgets, or one bad stop holds the queue for ever. */
    this.guard *= this.forget;
    return stops;
  }
}
