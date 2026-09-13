import { describe, expect, it } from 'vitest';

import { StepBudget } from './stepBudget.ts';

/**
 * A clock the test moves by hand.
 *
 * Every assertion here is a whole number of milliseconds and a whole number of stops, which is
 * the point: a budget tested against a real clock is tested against the machine it ran on, and
 * the properties this class exists for are exact.
 */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A job of `units` indivisible stops, each costing `costMs`. */
function job(units: number, costMs: number, tick: (ms: number) => void): () => string | null {
  let left = units;
  return () => {
    if (left === 0) return null;
    left -= 1;
    tick(costMs);
    return 'unit';
  };
}

describe('spending a budget on resumable work', () => {
  /*
   * **The counting assertion, and it is the one that cannot rot.**
   *
   * A consumer report named the failure this guards: a check whose host did no work called an
   * unbudgeted upload free, and stayed green through the whole defect. A stub cannot pass this
   * one — five units that each cost the whole budget need five calls, and a driver that ran them
   * all in one call would report one. No clock, no calibration, no device.
   */
  it('cannot finish five units in fewer than five calls when each costs a whole budget', () => {
    const c = clock();
    const budget = new StepBudget({ now: c.now });
    const next = job(5, 4, c.advance);

    let calls = 0;
    while (budget.spend(4, next) > 0) calls += 1;

    expect(calls).toBe(5);
  });

  /*
   * **Do not start what you cannot finish.** Steps of three against a budget of ten: a driver
   * that kept going while any budget remained would start a fourth at nine and end at twelve.
   */
  it('leaves a stop unstarted when there is no room for it', () => {
    const c = clock();
    const budget = new StepBudget({ now: c.now });

    const stops = budget.spend(10, job(9, 3, c.advance));

    expect(stops).toBe(3);
    expect(c.now()).toBe(9);
  });

  /*
   * **But always do one.** A stop longer than the whole budget otherwise means nothing ever
   * advances, and a world that never loads is worse than a frame that runs long.
   */
  it('takes one stop however far over the budget it goes', () => {
    const c = clock();
    const budget = new StepBudget({ now: c.now });

    expect(budget.spend(4, job(3, 40, c.advance))).toBe(1);
    expect(c.now()).toBe(40);
  });

  /** The guarantee, in the words worth stating: the larger of the budget and one stop. */
  it('costs the larger of the budget and a single stop', () => {
    const c = clock();
    const budget = new StepBudget({ now: c.now });
    const next = job(20, 7, c.advance);

    for (let call = 0; call < 6; call++) {
      const began = c.now();
      budget.spend(10, next);
      expect(c.now() - began).toBeLessThanOrEqual(Math.max(10, 7));
    }
  });

  it('takes no stop and reports none when there is nothing to do', () => {
    const c = clock();
    const budget = new StepBudget({ now: c.now });

    expect(budget.spend(10, () => null)).toBe(0);
    expect(c.now()).toBe(0);
  });

  it('names the worst stop and the work it was in', () => {
    const c = clock();
    const budget = new StepBudget<'build' | 'upload'>({ now: c.now });
    const costs: [number, 'build' | 'upload'][] = [
      [2, 'build'],
      [31, 'upload'],
      [3, 'build'],
    ];
    let at = 0;
    const next = (): 'build' | 'upload' | null => {
      const one = costs[at];
      if (one === undefined) return null;
      at += 1;
      c.advance(one[0]);
      return one[1];
    };

    while (budget.spend(4, next) > 0);

    expect(budget.worst).toBe(31);
    expect(budget.worstIn).toBe('upload');
  });

  /*
   * **The estimate has to forget.** One pathological stop otherwise sets the price of every
   * stop for ever, and a streamer does one square a frame across a whole plain.
   *
   * A per-call decay of 1% is a half-life of sixty-nine calls, a little over a second at 60 Hz.
   * The number is asserted rather than described because the alternative that was tried and is
   * wrong — 5% — differs only in this number: it falls below the real cost inside one crossing,
   * the guard stops guarding, and the frame becomes the budget plus a stop.
   */
  it('halves the estimate every sixty-nine calls', () => {
    const c = clock();
    const budget = new StepBudget({ now: c.now });

    budget.spend(4, job(1, 100, c.advance));
    expect(budget.estimate).toBeCloseTo(99, 0);

    for (let call = 0; call < 68; call++) budget.spend(4, () => null);

    expect(budget.estimate / 100).toBeCloseTo(0.5, 1);
  });

  /** What decays is the guard. The report keeps the number a reader is looking for. */
  it('forgets the guard but not the report', () => {
    const c = clock();
    const budget = new StepBudget({ now: c.now });

    budget.spend(4, job(1, 100, c.advance));
    for (let call = 0; call < 200; call++) budget.spend(4, () => null);

    expect(budget.estimate).toBeLessThan(20);
    expect(budget.worst).toBe(100);
  });

  /*
   * A poisoned estimate must not wedge the queue: once it has forgotten, a call that has room
   * for several cheap stops takes several again.
   */
  it('admits several cheap stops again once it has forgotten a costly one', () => {
    const c = clock();
    const budget = new StepBudget({ now: c.now });

    budget.spend(10, job(1, 100, c.advance));
    expect(budget.spend(10, job(9, 1, c.advance))).toBe(1);

    for (let call = 0; call < 300; call++) budget.spend(10, () => null);

    expect(budget.spend(10, job(9, 1, c.advance))).toBeGreaterThan(5);
  });
});
