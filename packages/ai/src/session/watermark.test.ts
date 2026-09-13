/**
 * The watermark buys exactly as much lead as the provider needs.
 *
 * The continuation goes out when the current intent's remaining extent falls to the
 * provider's measured p90. A fast provider is asked late, against fresher context; a
 * slow one early, because it has to be. The constant that would be wrong on every
 * device — and wrong again the moment a consumer switched providers — does not exist.
 */
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { UNKNOWN_EXTENT } from '../policy/types.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';

const ANSWER: AiEvent[] = [
  { kind: 'toolCall', callId: 'c1', toolId: 'inspect@1', args: {} },
  { kind: 'done', reason: 'complete' },
];

function floor(extentMs: number): UtilityPolicy {
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

const MS_PER_TICK = 10;

/**
 * Run `count` complete ask-and-answer cycles, so the estimator fills.
 *
 * Each cycle starts an intent, lets the request go out, advances the fake clock by
 * the provider's latency, and ends the intent. The session records latency on the
 * tick that observes the landing, which is the latency a fixed-step consumer
 * actually experiences.
 */
async function cycles(
  session: AgentSession,
  provider: DeterministicProvider,
  count: number,
  latencyTicks: number,
  startTick = 0,
): Promise<number> {
  let tick = startTick;
  for (let i = 0; i < count; i++) {
    session.tick(tick, tick * MS_PER_TICK);
    tick += latencyTicks;
    provider.advance(tick);
    await flush();
    session.tick(tick, tick * MS_PER_TICK);
    session.complete(tick * MS_PER_TICK);
    tick += 1;
  }
  return tick;
}

describe('the continuation watermark', () => {
  it('reports no lead before it has measured anything', () => {
    const provider = new DeterministicProvider({ latencyTicks: 2, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: floor(1000), provider });

    expect(session.leadMs).toBe(-1);

    /* And issues immediately in that window, which is the waiting design's behaviour
       and is the only safe thing to do when the lead needed is unknown. */
    session.tick(0, 0);
    expect(session.usage.requests).toBe(1);
  });

  it('waits until the remaining extent falls to the measured lead', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 20, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: floor(100_000), provider });

    const after = await cycles(session, provider, 10, 20);
    const lead = session.leadMs;
    expect(lead).toBeGreaterThan(0);

    /*
     * End the model intent so the floor supplies its long one. Without this the
     * session is sitting on a model intent whose extent is unknown, which issues
     * immediately by design — so the test would pass while measuring the wrong path.
     */
    const startMs = after * MS_PER_TICK;
    session.complete(startMs);
    expect(session.current?.source).toBe('floor');

    /* The request must not go out while more than `lead` milliseconds remain. */
    const requestsBefore = session.usage.requests;
    session.tick(after, startMs);
    expect(session.usage.requests).toBe(requestsBefore);

    /* Still early. */
    session.tick(after + 1, startMs + (100_000 - lead - 1000));
    expect(session.usage.requests).toBe(requestsBefore);

    /* Now inside the lead. */
    session.tick(after + 2, startMs + (100_000 - lead + 1));
    expect(session.usage.requests).toBe(requestsBefore + 1);
  });

  it('follows the measurement when the provider gets slower', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 2, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: floor(100_000), provider });

    const afterFast = await cycles(session, provider, 12, 2);
    const fastLead = session.leadMs;

    provider.setLatencyTicks(30);
    await cycles(session, provider, 12, 30, afterFast);
    const slowLead = session.leadMs;

    /*
     * The assertion is the **change**, never either value. A test pinning a number
     * would pass against a constant, which is the exact thing this mechanism exists
     * to remove — and is what the perturbation below confirms.
     */
    expect(slowLead).toBeGreaterThan(fastLead);
  });

  it('issues immediately for an intent whose extent is unknown', () => {
    const provider = new DeterministicProvider({ latencyTicks: 5, events: ANSWER });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(UNKNOWN_EXTENT),
      provider,
    });

    session.tick(0, 0);

    /* Nothing can be computed about when a one-shot will finish, so waiting would be
       guessing. This is the behaviour a design that waited would have had. */
    expect(session.usage.requests).toBe(1);
  });

  it('issues immediately when the provider is slower than the whole intent', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 40, events: ANSWER });
    const session = new AgentSession({ agentId: 'A17', policy: floor(50), provider });

    const after = await cycles(session, provider, 10, 40);
    expect(session.leadMs).toBeGreaterThan(50);

    /* On the floor's 50ms intent, not on a model intent whose unknown extent would
       issue immediately for a different reason entirely. */
    const startMs = after * MS_PER_TICK;
    session.complete(startMs);
    expect(session.current?.expectedExtentMs).toBe(50);

    const before = session.usage.requests;
    session.tick(after, startMs);

    /* Asked anyway, rather than never. A provider slower than the behaviour still gets
       asked; it just always lands late, and the floor covers every time. Never asking
       would turn a slow provider into no provider. */
    expect(session.usage.requests).toBe(before + 1);
  });
});
