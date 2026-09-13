/**
 * A session whose current slot is never empty.
 *
 * The first test here is the whole of Track O written as an assertion. Everything
 * else in the package exists so that it can be true cheaply.
 */
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';

function floorOption(id: string, extentMs: number): PolicyOption {
  return {
    intent: {
      id,
      priority: 10,
      toolIds: [],
      args: [],
      expectedExtentMs: extentMs,
      source: 'floor',
    } satisfies Intent,
    score: () => 1,
  };
}

function policy(extentMs = 100): UtilityPolicy {
  return new UtilityPolicy([floorOption('idle', extentMs)]);
}

const ANSWER: AiEvent[] = [
  { kind: 'toolCall', callId: 'c1', toolId: 'inspect@1', args: { target: 'D4' } },
  { kind: 'done', reason: 'complete' },
];

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('AgentSession', () => {
  it('is never without a current intent, against a provider that never answers', () => {
    const provider = new DeterministicProvider({ latencyTicks: 'never', events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: policy(), provider });

    let empties = 0;
    let nulls = 0;
    for (let tick = 0; tick < 10_000; tick++) {
      const intent = session.tick(tick, tick * 16);
      provider.advance(tick);
      if (intent === null || intent === undefined) nulls++;
      if (session.current === null) empties++;
    }

    expect(nulls).toBe(0);
    expect(empties).toBe(0);
  });

  it('behaves with no provider at all, and asks for nothing', () => {
    const session = new AgentSession({ agentId: 'A17', policy: policy() });

    for (let tick = 0; tick < 10_000; tick++) {
      const intent = session.tick(tick, tick * 16);
      expect(intent.source).toBe('floor');
    }

    /* Not "degraded but working". A consumer that never configures a provider is
       using this package as designed, and nothing about that path is a fallback. */
    expect(session.usage.requests).toBe(0);
  });

  it('drains the buffer into the current slot when the intent completes', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: policy(1000), provider });

    session.tick(0, 0);
    expect(session.current?.source).toBe('floor');

    provider.advance(1);
    await flush();
    expect(session.buffered?.source).toBe('model');

    session.complete(10);
    expect(session.current?.source).toBe('model');
    expect(session.buffered).toBeNull();
  });

  it('carries the model tool call through into the intent', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: policy(1000), provider });

    session.tick(0, 0);
    provider.advance(1);
    await flush();
    session.complete(10);

    expect(session.current?.toolIds).toEqual(['inspect@1']);
    expect(session.current?.args).toEqual([{ target: 'D4' }]);
  });

  it('falls back to the floor when the buffer is empty at completion', () => {
    const provider = new DeterministicProvider({ latencyTicks: 'never', events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: policy(100), provider });

    session.tick(0, 0);
    session.tick(1, 200);

    expect(session.current?.source).toBe('floor');
  });

  it('aborts the in-flight request on disposal, and refuses to tick afterwards', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 50, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: policy(1000), provider });

    session.tick(0, 0);
    expect(provider.peakConcurrency).toBe(1);

    session.dispose('scene replaced');
    await flush();

    expect(provider.abortedCount).toBe(1);
    /* A session used after disposal is a leak that has already happened. Throwing is
       how a consumer finds out at the call site rather than through a stream that
       quietly never delivers. */
    expect(() => session.tick(1, 16)).toThrow(/scene replaced/);
  });

  it('drops a response that arrives for a question the agent has moved past', async () => {
    /*
     * The first request answers `stale@1` and every later one answers `fresh@1`, so a
     * stale answer landing is distinguishable from a new request legitimately landing.
     * Asserting only that the buffer is empty could not tell those apart, and passed
     * for the wrong reason on the first draft.
     */
    const provider = new DeterministicProvider((index) => ({
      latencyTicks: 100,
      events: [
        {
          kind: 'toolCall',
          callId: 'c',
          toolId: index === 0 ? 'stale@1' : 'fresh@1',
          args: {},
        },
        { kind: 'done', reason: 'complete' },
      ],
    }));
    const session = new AgentSession({ agentId: 'A17', policy: policy(50), provider });

    session.tick(0, 0);
    /* The floor intent is over long before the answer is due, so the session takes
       `ahead -> intentCompleted -> idle` and abandons the question. */
    session.tick(1, 60);

    for (let tick = 100; tick <= 300; tick += 10) {
      provider.advance(tick);
      await flush();
      expect(session.buffered?.toolIds ?? []).not.toContain('stale@1');
    }
  });

  it('aborts the abandoned request rather than leaving two outstanding', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 100, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: policy(50), provider });

    /*
     * Six intents, each abandoning the request the last one issued. The first draft
     * abandoned without aborting, so every completed intent left a request open and
     * concurrency climbed with the tick count — invisible to the state machine, which
     * cannot see the provider.
     */
    for (let tick = 0; tick < 6; tick++) session.tick(tick, tick * 60);
    await flush();

    expect(provider.peakConcurrency).toBe(1);
    expect(provider.abortedCount).toBeGreaterThan(0);
  });
});
