import { describe, expect, it } from 'vitest';
import { UtilityPolicy } from './utility.ts';
import type { Intent, PolicyContext, PolicyOption } from './types.ts';

function option(id: string, score: number): PolicyOption {
  return {
    intent: {
      id,
      priority: 10,
      toolIds: [],
      args: [],
      expectedExtentMs: 500,
      source: 'floor',
    } satisfies Intent,
    score: () => score,
  };
}

const CONTEXT: PolicyContext = { tick: 0, agentId: 'A17', elapsedMs: 0 };

describe('UtilityPolicy', () => {
  it('returns the highest-scoring option', () => {
    const policy = new UtilityPolicy([option('low', 1), option('high', 9), option('mid', 5)]);

    expect(policy.select(CONTEXT).id).toBe('high');
  });

  it('breaks a tie by declaration order, not alphabetically', () => {
    /*
     * `zebra` is declared first and `apple` second, so the two orders disagree. The
     * last session shipped a tie-break test whose options were named a, b, c — where
     * declaration order and alphabetical order agree, and the test could not fail.
     */
    const policy = new UtilityPolicy([option('zebra', 5), option('apple', 5)]);

    expect(policy.select(CONTEXT).id).toBe('zebra');
  });

  it('refuses to be constructed with no options', () => {
    expect(() => new UtilityPolicy([])).toThrow(/at least one option/);
  });

  it('returns the same object identity when the same option wins twice', () => {
    const policy = new UtilityPolicy([option('only', 1)]);

    /* This is what the allocation claim rests on. A policy building a fresh intent
       each call would pass every test above and fail the one below. */
    expect(policy.select(CONTEXT)).toBe(policy.select(CONTEXT));
  });

  it('scores against the context it is given', () => {
    const policy = new UtilityPolicy([
      { ...option('early', 0), score: (c) => (c.elapsedMs < 100 ? 10 : 0) },
      { ...option('late', 0), score: (c) => (c.elapsedMs >= 100 ? 10 : 0) },
    ]);

    expect(policy.select({ ...CONTEXT, elapsedMs: 0 }).id).toBe('early');
    expect(policy.select({ ...CONTEXT, elapsedMs: 500 }).id).toBe('late');
  });
});
