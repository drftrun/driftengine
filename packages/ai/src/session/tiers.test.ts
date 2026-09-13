/**
 * A fast tier for interrupts, additive and absent by default.
 */
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';

function answering(toolId: string): AiEvent[] {
  return [
    { kind: 'toolCall', callId: 'c1', toolId, args: {} },
    { kind: 'done', reason: 'complete' },
  ];
}

function floor(extentMs = 100_000): UtilityPolicy {
  const option: PolicyOption = {
    intent: {
      id: 'idle',
      priority: 10,
      toolIds: [],
      args: [],
      expectedExtentMs: extentMs,
      source: 'floor',
    } satisfies Intent,
    score: () => 1,
  };
  return new UtilityPolicy([option]);
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('the interrupt tier', () => {
  it('asks the fast provider on a preemption, and aborts the slow one', async () => {
    const strong = new DeterministicProvider({ latencyTicks: 500, events: answering('plan@1') });
    const fast = new DeterministicProvider({ latencyTicks: 1, events: answering('cover@1') });

    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider: strong,
      interruptProvider: fast,
      whileBusy: 'preempt',
    });

    session.tick(0, 0);
    expect(strong.requestCount).toBe(1);

    session.observe({ id: 'impact', priority: 90, text: 'loud impact' });
    session.tick(1, 16);
    await flush();

    expect(strong.abortedCount).toBe(1);
    expect(fast.requestCount).toBe(1);
  });

  it('puts the interrupt answer in the current slot, not the buffer', async () => {
    const strong = new DeterministicProvider({ latencyTicks: 500, events: answering('plan@1') });
    const fast = new DeterministicProvider({ latencyTicks: 1, events: answering('cover@1') });

    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider: strong,
      interruptProvider: fast,
      whileBusy: 'preempt',
    });

    session.tick(0, 0);
    session.observe({ id: 'impact', priority: 90, text: 'loud impact' });
    session.tick(1, 16);

    /* The floor is already running by the time the answer lands, which is what makes a
       slow interrupt harmless rather than a hole. */
    expect(session.current?.source).toBe('floor');

    fast.advance(1);
    await flush();

    /* An interrupt is about *now*. Buffering it would answer a question about the
       present at whatever moment the current behaviour happened to end. */
    expect(session.current?.toolIds).toEqual(['cover@1']);
    expect(session.buffered).toBeNull();
  });

  it('changes nothing about preemption when no fast provider is configured', async () => {
    const strong = new DeterministicProvider({ latencyTicks: 500, events: answering('plan@1') });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider: strong,
      whileBusy: 'preempt',
    });

    session.tick(0, 0);
    session.observe({ id: 'impact', priority: 90, text: 'loud impact' });
    const intent = session.tick(1, 16);
    await flush();

    expect(intent.source).toBe('floor');
    expect(session.current).not.toBeNull();
    expect(session.buffered).toBeNull();
    expect(session.usage.preemptedRequests).toBe(1);
    expect(session.usage.abortedRequests).toBe(1);
  });

  it('keeps one request in flight across both providers', async () => {
    const strong = new DeterministicProvider({ latencyTicks: 20, events: answering('plan@1') });
    const fast = new DeterministicProvider({ latencyTicks: 2, events: answering('cover@1') });

    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(400),
      provider: strong,
      interruptProvider: fast,
      whileBusy: 'preempt',
      dedupeWindowMs: 0,
    });

    for (let tick = 0; tick < 300; tick++) {
      if (tick % 11 === 0) {
        session.observe({ id: `impact-${tick}`, priority: 99, text: 'x' });
      }
      session.tick(tick, tick * 16);
      strong.advance(tick);
      fast.advance(tick);
      await flush();
    }

    /* One in flight is per session, not per provider: the continuation is aborted
       before the interrupt is asked, so the two are never outstanding together. */
    expect(strong.peakConcurrency).toBe(1);
    expect(fast.peakConcurrency).toBe(1);
  });
});
