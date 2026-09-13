/**
 * Usage, and the one number that makes preemption visible.
 *
 * A preemption throws away a request that was paid for. That is the token price of
 * responsiveness and it is bounded by the preemption rate, which a consumer sets
 * through priorities — so it has to be reported, because a number nobody reports is
 * a number nobody tunes.
 */
import { describe, expect, it } from 'vitest';
import { chargeUsage, createUsage, noteAbort, notePreemption } from './usage.ts';

describe('usage', () => {
  it('starts every field at zero', () => {
    const usage = createUsage();
    for (const value of Object.values(usage)) expect(value).toBe(0);
  });

  it('adds input and output tokens from a usage event', () => {
    const usage = createUsage();
    chargeUsage(usage, { kind: 'usage', inputTokens: 120, outputTokens: 30 });
    chargeUsage(usage, { kind: 'usage', inputTokens: 5, outputTokens: 2 });

    expect(usage.inputTokens).toBe(125);
    expect(usage.outputTokens).toBe(32);
  });

  it('ignores events that are not usage, including an aborted done', () => {
    const usage = createUsage();
    chargeUsage(usage, { kind: 'text', text: 'hello' });
    chargeUsage(usage, { kind: 'done', reason: 'complete' });
    chargeUsage(usage, { kind: 'done', reason: 'aborted' });

    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    /*
     * An abort is counted where the session aborts, not where the `done` arrives.
     * Both places fired on the first draft, so every preemption reported two aborts —
     * one from the decision and one from its own consequence.
     */
    expect(usage.abortedRequests).toBe(0);
  });

  it('counts an abort once, and a preemption as an abort with a narrower name', () => {
    const usage = createUsage();
    noteAbort(usage);
    expect(usage.abortedRequests).toBe(1);
    expect(usage.preemptedRequests).toBe(0);

    /* A preemption goes through both, so each function counts exactly what it knows
       and neither has to know what the other did. */
    notePreemption(usage);
    noteAbort(usage);

    expect(usage.preemptedRequests).toBe(1);
    expect(usage.abortedRequests).toBe(2);
  });

  it('mutates in place, so charging per event needs no per-request object', () => {
    const usage = createUsage();
    const before = usage;
    chargeUsage(usage, { kind: 'usage', inputTokens: 1, outputTokens: 1 });

    expect(usage).toBe(before);
  });
});
