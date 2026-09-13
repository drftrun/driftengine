/**
 * Backpressure is `MessageQueue` — R7 — and two of its five modes stopped existing.
 *
 * `queue` and `replace pending` both described what to do with a *second* request, and
 * the state machine has no edge on which one could be issued. They are not deprecated;
 * they name nothing.
 */
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';

const ANSWER: AiEvent[] = [
  { kind: 'toolCall', callId: 'c1', toolId: 'inspect@1', args: {} },
  { kind: 'done', reason: 'complete' },
];

function floor(extentMs: number, priority = 10): UtilityPolicy {
  const option: PolicyOption = {
    intent: {
      id: 'idle',
      priority,
      toolIds: [],
      args: [],
      expectedExtentMs: extentMs,
      source: 'floor',
    } satisfies Intent,
    score: () => 1,
  };
  return new UtilityPolicy([option]);
}

describe('backpressure', () => {
  it('accepts exactly three values for whileBusy', () => {
    for (const mode of ['coalesce', 'preempt', 'drop'] as const) {
      expect(
        () => new AgentSession({ agentId: 'A', policy: floor(100), whileBusy: mode }),
      ).not.toThrow();
    }

    for (const gone of ['queue', 'replace pending']) {
      expect(
        () =>
          new AgentSession({
            agentId: 'A',
            policy: floor(100),
            whileBusy: gone as 'coalesce',
          }),
        gone,
      ).toThrow(/only ever one request in flight/);
    }
  });

  it('collapses a repeat of the same observation within the dedupe window', () => {
    const provider = new DeterministicProvider({ latencyTicks: 100, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(100_000),
      provider,
      whileBusy: 'preempt',
      dedupeWindowMs: 900,
    });

    session.tick(0, 0);
    const before = session.usage.preemptedRequests;

    /* The realistic source of a repeat is a caller pushing from a per-frame check
       rather than an edge. Sixty identical observations a second is sixty preemptions
       and sixty thrown-away requests. */
    for (let i = 0; i < 10; i++) {
      session.observe({ id: 'impact', priority: 90, text: 'loud impact' });
      session.tick(i + 1, (i + 1) * 16);
    }

    expect(session.usage.preemptedRequests).toBe(before + 1);
  });

  it('ignores observations while a request is out, under drop', () => {
    const provider = new DeterministicProvider({ latencyTicks: 100, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(100_000),
      provider,
      whileBusy: 'drop',
    });

    session.tick(0, 0);
    expect(session.state).toBe('ahead');
    const requests = session.usage.requests;

    for (let i = 0; i < 5; i++) {
      session.observe({ id: `e${i}`, priority: 99, text: 'x' });
      session.tick(i + 1, (i + 1) * 16);
    }

    expect(session.usage.requests).toBe(requests);
    expect(session.usage.preemptedRequests).toBe(0);
  });

  it('does nothing on an observation under coalesce, which is the default', () => {
    const provider = new DeterministicProvider({ latencyTicks: 100, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: floor(100_000), provider });

    session.tick(0, 0);
    const requests = session.usage.requests;

    session.observe({ id: 'impact', priority: 99, text: 'loud impact' });
    session.tick(1, 16);

    /* The default does not interrupt. An observation merges into what the next
       request will carry, which is the cheap option and therefore the right default —
       preempting costs a request every time it happens. */
    expect(session.usage.requests).toBe(requests);
    expect(session.usage.preemptedRequests).toBe(0);
  });

  it('drops the least important when the backlog overflows, not the oldest', () => {
    const provider = new DeterministicProvider({ latencyTicks: 100, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(100_000),
      provider,
      whileBusy: 'preempt',
      maxPendingObservations: 4,
      dedupeWindowMs: 0,
    });

    session.tick(0, 0);

    /* Eight observations, a ceiling of four. The important one arrives first, so a
       queue dropping the oldest would lose exactly the one that mattered. */
    session.observe({ id: 'critical', priority: 100, text: 'the one that matters' });
    for (let i = 0; i < 7; i++) {
      session.observe({ id: `minor${i}`, priority: 1, text: 'noise' });
    }

    session.tick(1, 16);
    expect(session.usage.preemptedRequests).toBe(1);
  });
});
