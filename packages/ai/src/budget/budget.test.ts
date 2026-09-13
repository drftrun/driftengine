/**
 * Budgets are enforced in the runtime, not requested in a prompt.
 *
 * And exhaustion **degrades**. An agent over budget keeps producing intents from its
 * policy floor; it does not stop, throw or freeze. A throw here would become an
 * exception inside a fixed step, which is the failure this replaces rather than a
 * stricter version of it.
 */
import { describe, expect, it } from 'vitest';
import { Budget } from './budget.ts';
import { createUsage } from '../session/usage.ts';

describe('Budget', () => {
  it('is never exhausted when it has no limits', () => {
    const budget = new Budget({});
    const usage = createUsage();
    usage.inputTokens = 1_000_000;
    budget.charge(usage, 10_000_000);

    expect(budget.exhausted).toBe(false);
    expect(budget.reason).toBe('');
  });

  it('exhausts on input tokens, naming the limit and its value', () => {
    const budget = new Budget({ inputTokens: 100 });
    const usage = createUsage();
    usage.inputTokens = 101;
    budget.charge(usage, 0);

    expect(budget.exhausted).toBe(true);
    expect(budget.reason).toContain('inputTokens');
    expect(budget.reason).toContain('100');
  });

  it('exhausts on each limit independently', () => {
    const cases: [Record<string, number>, (u: ReturnType<typeof createUsage>) => void, string][] = [
      [{ outputTokens: 10 }, (u) => (u.outputTokens = 11), 'outputTokens'],
      [{ requests: 2 }, (u) => (u.requests = 3), 'requests'],
      [{ costMicros: 500 }, (u) => (u.costMicros = 501), 'costMicros'],
    ];

    for (const [limits, spend, name] of cases) {
      const budget = new Budget(limits);
      const usage = createUsage();
      spend(usage);
      budget.charge(usage, 0);
      expect(budget.exhausted, name).toBe(true);
      expect(budget.reason).toContain(name);
    }
  });

  it('exhausts on wall time, measured from the first charge', () => {
    const budget = new Budget({ wallMs: 1000 });
    const usage = createUsage();

    budget.charge(usage, 5000);
    expect(budget.exhausted).toBe(false);

    budget.charge(usage, 6001);
    expect(budget.exhausted).toBe(true);
    expect(budget.reason).toContain('wallMs');
  });

  it('reports an empty reason while not exhausted, so a caller can test the string', () => {
    const budget = new Budget({ inputTokens: 100 });
    budget.charge(createUsage(), 0);

    expect(budget.reason).toBe('');
  });

  it('latches: charging less afterwards does not un-exhaust it', () => {
    const budget = new Budget({ inputTokens: 100 });
    const usage = createUsage();
    usage.inputTokens = 200;
    budget.charge(usage, 0);
    expect(budget.exhausted).toBe(true);

    /* A budget recomputed from current usage would come back to life the moment a
       consumer reset a counter, and an agent would resume spending against a limit
       somebody had already hit. */
    usage.inputTokens = 1;
    budget.charge(usage, 0);
    expect(budget.exhausted).toBe(true);
  });

  it('throws nothing when charged past a limit', () => {
    const budget = new Budget({ inputTokens: 1 });
    const usage = createUsage();
    usage.inputTokens = 10_000;

    expect(() => budget.charge(usage, 0)).not.toThrow();
    expect(() => budget.charge(usage, 1)).not.toThrow();
  });
});
