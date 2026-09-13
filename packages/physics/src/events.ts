/**
 * What touched what, drained after the tick rather than raised during it.
 *
 * **Not callbacks during the solve.** A callback that mutates the world mid-tick is the classic
 * footgun — a body removed inside one invalidates every index the solver is holding — and it is
 * also what would break the executor, since a worker solving one island cannot safely call into a
 * consumer's code that touches another. Events accumulate into a caller-owned buffer and the caller
 * drains them when the tick is over and the world is coherent again.
 *
 * **Ordered by pair key**, so a replay sees them in the same order it recorded them.
 *
 * Physics may not use core's `MessageQueue`: §2 of the design forbids importing an engine package,
 * and that constraint gives the right answer here anyway. A queue with backpressure is the wrong
 * shape for per-tick events a caller drains completely, and completely is the only way to drain
 * these — a dropped `exit` leaves a consumer believing something is still inside a trigger.
 */

export const EVENT_ENTER = 0;
export const EVENT_STAY = 1;
export const EVENT_EXIT = 2;
export type EventKind = 0 | 1 | 2;

export class ContactEvents {
  /** `kind`, `bodyA`, `bodyB` per event, in that order. Read `count` triples. */
  data: Int32Array;
  count = 0;

  /** Pair keys touching at the end of the last tick, sorted. */
  private current: Uint32Array;
  private currentCount = 0;
  private previous: Uint32Array;
  private previousCount = 0;

  constructor(capacity = 64) {
    this.data = new Int32Array(capacity * 3);
    this.current = new Uint32Array(capacity);
    this.previous = new Uint32Array(capacity);
  }

  /** Start a tick's collection. The previous tick's set becomes what this one is compared against. */
  begin(): void {
    const swap = this.previous;
    this.previous = this.current;
    this.previousCount = this.currentCount;
    this.current = swap;
    this.currentCount = 0;
    this.count = 0;
  }

  /**
   * Record a touching pair. **Keys must arrive ascending**, which the sorted pair list guarantees,
   * because the enter and exit diff below is a merge of two sorted runs.
   */
  touching(key: number): void {
    if (this.currentCount === this.current.length) {
      const wider = new Uint32Array(this.current.length * 2);
      wider.set(this.current);
      this.current = wider;
    }
    this.current[this.currentCount++] = key;
  }

  /** Diff this tick's set against the last and write enter, stay and exit. */
  end(pairA: (key: number) => number, pairB: (key: number) => number): void {
    let i = 0;
    let j = 0;
    while (i < this.currentCount || j < this.previousCount) {
      const now = i < this.currentCount ? (this.current[i] ?? 0) : Infinity;
      const was = j < this.previousCount ? (this.previous[j] ?? 0) : Infinity;
      if (now === was) {
        this.push(EVENT_STAY, now, pairA, pairB);
        i++;
        j++;
      } else if (now < was) {
        this.push(EVENT_ENTER, now, pairA, pairB);
        i++;
      } else {
        this.push(EVENT_EXIT, was, pairA, pairB);
        j++;
      }
    }
  }

  /** Forget everything, for a world whose indices have moved under it. */
  clear(): void {
    this.count = 0;
    this.currentCount = 0;
    this.previousCount = 0;
  }

  private push(
    kind: EventKind,
    key: number,
    pairA: (key: number) => number,
    pairB: (key: number) => number,
  ): void {
    if ((this.count + 1) * 3 > this.data.length) {
      const wider = new Int32Array(this.data.length * 2);
      wider.set(this.data);
      this.data = wider;
    }
    const at = this.count * 3;
    this.data[at] = kind;
    this.data[at + 1] = pairA(key);
    this.data[at + 2] = pairB(key);
    this.count++;
  }
}
