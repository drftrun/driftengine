/**
 * Preemption that leaves no hole, and reports what it cost.
 *
 * Three things can be live at once: the executing intent, the buffered intent, and the
 * request. A high-priority observation invalidates all three — and the floor supplies
 * on the same tick, which is what makes preempting cheap enough to do when it matters.
 */
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';
import { mulberry32 } from '@driftengine/core';

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

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('preemption', () => {
  it('invalidates all three and yields a floor intent on the same tick', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(100_000),
      provider,
      whileBusy: 'preempt',
    });

    session.tick(0, 0);
    provider.advance(1);
    await flush();

    /* All three are live: a floor intent running, a model intent buffered behind it,
       and — once the next tick issues one — a request. The intent's extent is long, so
       it has not drained; that is the state a preemption has to clear. */
    expect(session.buffered).not.toBeNull();
    expect(session.current?.source).toBe('floor');

    session.tick(1, 16);
    const requestsBefore = session.usage.requests;

    session.observe({ id: 'impact', priority: 90, text: 'loud impact' });
    const intent = session.tick(2, 32);

    /* No hole. The floor is synchronous, so the replacement is available on the tick
       the preemption happens rather than whenever a provider gets round to it. */
    expect(intent.source).toBe('floor');
    expect(session.current).not.toBeNull();
    expect(session.buffered).toBeNull();
    expect(session.usage.requests).toBeGreaterThan(requestsBefore);
  });

  it('changes nothing when the observation does not outrank the current intent', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(100_000, 50),
      provider,
      whileBusy: 'preempt',
    });

    session.tick(0, 0);
    provider.advance(1);
    await flush();
    session.tick(1, 16);
    const before = session.current;

    /* Equal, not greater. A tie is not an interruption — otherwise every routine
       observation of the same importance would restart the behaviour it belongs to. */
    session.observe({ id: 'noise', priority: 50, text: 'a noise' });
    session.tick(2, 32);

    expect(session.current).toBe(before);
    expect(session.usage.preemptedRequests).toBe(0);
  });

  it('counts a preemption as both a preemption and an abort', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 500, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(100_000),
      provider,
      whileBusy: 'preempt',
    });

    session.tick(0, 0);
    expect(session.state).toBe('ahead');

    session.observe({ id: 'impact', priority: 90, text: 'loud impact' });
    session.tick(1, 16);
    await flush();

    expect(session.usage.preemptedRequests).toBe(1);
    expect(session.usage.abortedRequests).toBe(1);
  });

  it('counts nothing when there was no request to throw away', () => {
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(100_000),
      whileBusy: 'preempt',
    });

    session.tick(0, 0);
    session.observe({ id: 'impact', priority: 90, text: 'loud impact' });
    session.tick(1, 16);

    /* No provider, so nothing was in flight and nothing was wasted. A counter that
       moved here would report a cost that was never paid. */
    expect(session.usage.preemptedRequests).toBe(0);
  });

  it('returns exactly one intent from a tick that preempts', () => {
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(100_000),
      whileBusy: 'preempt',
    });

    session.tick(0, 0);
    session.observe({ id: 'impact', priority: 90, text: 'loud impact' });

    /* The abort takes effect at the boundary. A consumer executing what `tick` returns
       is never handed a second intent for the same step, which is what "never
       mid-tick" means in practice. */
    const intent = session.tick(1, 16);
    expect(intent).toBe(session.current);
  });

  it('never has more than one request in flight, under randomised traffic', async () => {
    /*
     * Seed 20260826 with core's own `mulberry32`, recorded here so a failure is
     * reproducible. A randomised test whose seed cannot be recovered reports a bug
     * nobody can rerun.
     */
    const random = mulberry32(20260826);
    const provider = new DeterministicProvider({ latencyTicks: 3, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(200),
      provider,
      whileBusy: 'preempt',
    });

    for (let tick = 0; tick < 1000; tick++) {
      if (random() < 0.15) {
        session.observe({ id: 'event', priority: Math.floor(random() * 100), text: 'x' });
      }
      session.tick(tick, tick * 16);
      provider.advance(tick);
      await flush();
      expect(session.current).not.toBeNull();
    }

    expect(provider.peakConcurrency).toBe(1);
  });
});
