import { describe, expect, it } from 'vitest';

import { FrameBudget } from './budget.ts';

/**
 * What a frame asked for against what the backend allows.
 *
 * **The number that matters is what was *asked for*, not what fit.** A budget reporting 1,024 of
 * 1,024 says a frame is exactly full; a budget reporting 1,267 of 1,024 says 243 pieces of the
 * world were not drawn and roughly how much bigger the scene got. The first is the number a ring
 * naturally has and the second is the one a consumer can act on, which is why `ask` is counted
 * separately from `drop` rather than derived from a fill level.
 *
 * The reason this exists at all is that the only signal for a ceiling firing was `console.warn`,
 * once per renderer lifetime, into a browser console. A consumer spent weeks on missing
 * ground whose open lead was still *"ask the reporter for the console"*, and wrote its own draw
 * counter to guess at a worst case this renderer already knew exactly.
 */
describe('FrameBudget', () => {
  it('counts what was asked for, not what fit', () => {
    const budget = new FrameBudget();
    const draws = budget.line('draws', 4);

    for (let i = 0; i < 7; i += 1) draws.ask();
    for (let i = 0; i < 3; i += 1) draws.drop();

    expect(draws.used).toBe(7);
    expect(draws.ceiling).toBe(4);
    expect(draws.dropped).toBe(3);
  });

  it('says nothing was dropped when a frame fits, and says so once anything is not', () => {
    const budget = new FrameBudget();
    const draws = budget.line('draws', 4);
    const water = budget.line('water bodies', 2);

    draws.ask();
    water.ask();
    expect(budget.dropped).toBe(false);

    water.ask();
    water.ask();
    water.drop();
    expect(budget.dropped).toBe(true);
  });

  /**
   * **A backend with no ceiling reports the count and `null`, rather than being left out.**
   *
   * WebGL2 imposes none of these limits — it sets uniforms per draw and has no ring to run out
   * of — so a scene over WebGPU's ceiling draws in full there and loses geometry here, with
   * nothing failing on either side. A developer working on WebGL2 can only see that coming if
   * the same line is reported with the same name and an honest `null`.
   */
  it('reports a count with no ceiling, for a backend that imposes none', () => {
    const budget = new FrameBudget();
    const draws = budget.line('draws', null);

    for (let i = 0; i < 9000; i += 1) draws.ask();

    expect(draws.ceiling).toBeNull();
    expect(draws.used).toBe(9000);
    expect(draws.dropped).toBe(0);
    expect(budget.dropped).toBe(false);
  });

  it('clears the counts each frame but keeps the lines, so reading one allocates nothing', () => {
    const budget = new FrameBudget();
    const draws = budget.line('draws', 4);
    const before = budget.lines;

    draws.ask();
    draws.ask();
    budget.reset();

    expect(draws.used).toBe(0);
    expect(draws.dropped).toBe(0);
    expect(budget.dropped).toBe(false);
    /* The same array and the same line objects, which is what lets a consumer hold a reference. */
    expect(budget.lines).toBe(before);
    expect(budget.lines[0]).toBe(draws);
  });

  it('keeps its lines in the order they were declared, so a report reads the same every frame', () => {
    const budget = new FrameBudget();
    budget.line('draws', 4096);
    budget.line('materials', 1024);
    budget.line('water bodies', 16);

    expect(budget.lines.map((line) => line.name)).toEqual(['draws', 'materials', 'water bodies']);
  });

  /**
   * **A line names the thing a consumer would count, not the ring that holds it.**
   *
   * Refused rather than allowed to collide, because two subsystems sharing a ceiling constant —
   * wind streaks, flocks and bolts all sit at `MAX_BATCHES_PER_FRAME` — would otherwise be
   * tempting to report under one line, and a consumer told "batches: 9 of 8" cannot tell which
   * of the three to cut.
   */
  it('refuses two lines of one name, because a report has to say which thing ran out', () => {
    const budget = new FrameBudget();
    budget.line('batches', 8);
    expect(() => budget.line('batches', 8)).toThrow(/batches/);
  });
});
