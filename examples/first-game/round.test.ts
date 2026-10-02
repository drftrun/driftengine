/**
 * The first game's rules, tested in Node. A script that holds no engine object is a set of
 * functions over a record, so a test can call them without a page to run in.
 */
// #region test
import { describe, expect, it } from 'vitest';
import { loadModule } from 'driftscript';
import * as roundScript from './round.drs';

interface Round {
  remaining: number;
  gathered: number;
  total: number;
  phase: string;
}
const rules = loadModule(roundScript as Record<string, unknown>).exports as unknown as {
  createRound(): Round;
  start(round: Round, total: number): void;
  reaches(dx: number, dy: number, dz: number): boolean;
  gather(round: Round): void;
  tick(round: Round, dt: number): void;
};

describe('a round', () => {
  it('is won when the last orb is gathered before the clock runs out', () => {
    const round = rules.createRound();
    rules.start(round, 2);
    rules.gather(round);
    rules.gather(round);
    rules.tick(round, 1 / 60);
    expect(round.phase).toBe('won');
  });

  it('is lost when the clock runs out first, with the clock stopped at zero', () => {
    const round = rules.createRound();
    rules.start(round, 2);
    rules.gather(round);
    for (let step = 0; step < 61 * 60; step += 1) rules.tick(round, 1 / 60);
    expect(round.phase).toBe('lost');
    expect(round.remaining).toBe(0);
  });

  it('reaches an orb within a metre and not beyond', () => {
    expect(rules.reaches(0.6, 0, 0.6)).toBe(true);
    expect(rules.reaches(0.8, 0, 0.8)).toBe(false);
  });
});
// #endregion
