/**
 * An exhausted budget makes an agent less clever, not less alive.
 *
 * No continuation goes out, the buffer drains once and is never refilled, and the
 * floor keeps producing an intent every tick. Nothing throws — a throw here would land
 * inside a fixed step, which is the failure this replaces rather than a stricter
 * version of it.
 */
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent.ts';
import { Budget } from '../budget/budget.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';

const ANSWER: AiEvent[] = [
  { kind: 'toolCall', callId: 'c1', toolId: 'inspect@1', args: {} },
  { kind: 'done', reason: 'complete' },
];

function floor(extentMs = 100): UtilityPolicy {
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

describe('budget exhaustion', () => {
  it('stops asking, and keeps moving, for ten thousand ticks', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider,
      budget: new Budget({ requests: 3 }),
    });

    let empties = 0;
    for (let tick = 0; tick < 10_000; tick++) {
      const intent = session.tick(tick, tick * 16);
      provider.advance(tick);
      /* Flushed periodically rather than every tick: ten thousand real macrotasks is
         ten seconds of wall clock for a loop that is not testing wall clock. */
      if (tick % 100 === 0) await flush();
      if (intent === null || session.current === null) empties++;
      if (tick % 5 === 4) session.complete(tick * 16);
    }

    expect(empties).toBe(0);
    expect(session.degraded).toBe(true);
    /* Four rather than three: the limit is exceeded by the request that crosses it,
       and the budget latches on the tick that observes the overage. What matters is
       that it stopped, not the exact boundary. */
    expect(session.usage.requests).toBeLessThan(10);
  });

  it('runs entirely on the floor once exhausted', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider,
      budget: new Budget({ requests: 2 }),
    });

    /* A consumer completes the intent it executed. A model intent has an unknown
       extent by design — the consumer is the thing that knows whether the walk
       finished — so nothing else can end it. */
    for (let tick = 0; tick < 200; tick++) {
      session.tick(tick, tick * 16);
      provider.advance(tick);
      await flush();
      if (tick % 5 === 4) session.complete(tick * 16);
    }

    const sources = new Set<string>();
    for (let tick = 200; tick < 400; tick++) {
      sources.add(session.tick(tick, tick * 16).source);
      provider.advance(tick);
      await flush();
      if (tick % 5 === 4) session.complete(tick * 16);
    }

    expect([...sources]).toEqual(['floor']);
    expect(session.buffered).toBeNull();
  });

  it('reports the budget own sentence, naming the limit that was hit', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider,
      budget: new Budget({ requests: 1 }),
    });

    expect(session.degradedReason).toBe('');

    for (let tick = 0; tick < 50; tick++) {
      session.tick(tick, tick * 16);
      provider.advance(tick);
      await flush();
    }

    expect(session.degradedReason).toContain('requests');
    expect(session.degradedReason).toContain('A17');
    expect(session.degradedReason).toContain('0 requests in flight');
  });

  it('reclaims an intent a consumer forgot, when a ceiling is set', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider,
      maxIntentMs: 500,
    });

    session.tick(0, 0);
    provider.advance(1);
    await flush();
    session.complete(16);
    expect(session.current?.source).toBe('model');

    /*
     * Nobody calls `complete` again. Without a ceiling the agent sits on this intent
     * for the rest of the run — the blocked agent arriving through the back door, past
     * every guarantee the floor gives. The ceiling is off by default because a default
     * would be a guess about behaviours this package cannot see.
     */
    const intent = session.tick(1, 16 + 501);
    expect(intent.source).toBe('floor');
  });

  it('holds an unknown-extent intent indefinitely when no ceiling is set', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: floor(), provider });

    session.tick(0, 0);
    provider.advance(1);
    await flush();
    session.complete(16);
    expect(session.current?.source).toBe('model');

    /* The contract, stated as a test: the consumer owns completion of an intent whose
       duration only the consumer knows. */
    const intent = session.tick(1, 10_000_000);
    expect(intent.source).toBe('model');
  });

  it('throws nothing, at any point', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider,
      budget: new Budget({ requests: 1, inputTokens: 1, wallMs: 1 }),
    });

    for (let tick = 0; tick < 500; tick++) {
      expect(() => session.tick(tick, tick * 16)).not.toThrow();
      provider.advance(tick);
      await flush();
    }
  });
});
