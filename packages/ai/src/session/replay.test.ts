/**
 * A buffered agent replays exactly, because the floor recomputes.
 *
 * The design that waited could not promise this: there the *timing* of a response was
 * itself part of the behaviour, and timing is the one thing a live provider will not
 * reproduce.
 */
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent.ts';
import { ReplaySession } from './replay.ts';
import { CommandLog } from '../command/log.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';

const ANSWER: AiEvent[] = [
  { kind: 'toolCall', callId: 'c1', toolId: 'inspect@1', args: { target: 'D4' } },
  { kind: 'done', reason: 'complete' },
];

/** Two options whose scores alternate, so the floor's choice is not constant. */
function floor(): UtilityPolicy {
  const make = (id: string, phase: number): PolicyOption => ({
    intent: {
      id,
      priority: 10,
      toolIds: [],
      args: [],
      expectedExtentMs: 120,
      source: 'floor',
    } satisfies Intent,
    score: (context) => ((Math.floor(context.tick / 7) + phase) % 2 === 0 ? 2 : 1),
  });
  return new UtilityPolicy([make('watch', 0), make('patrol', 1)]);
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function record(ticks: number): Promise<{ log: CommandLog; intents: string[] }> {
  const provider = new DeterministicProvider({ latencyTicks: 4, events: ANSWER });
  const log = new CommandLog(1024);
  const session = new AgentSession({ agentId: 'A17', policy: floor(), provider, log });

  const intents: string[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    intents.push(session.tick(tick, tick * 16).id);
    provider.advance(tick);
    await flush();
  }
  return { log, intents };
}

describe('ReplaySession', () => {
  it('reproduces the intent sequence element by element', async () => {
    const { log, intents } = await record(1000);

    const replay = new ReplaySession(log, floor(), 'A17');
    const replayed: string[] = [];
    for (let tick = 0; tick < 1000; tick++) replayed.push(replay.tick(tick, tick * 16).id);

    /* Element by element, not merely the same length. Two sequences of a thousand
       floor decisions have the same length whatever either one chose. */
    expect(replayed).toEqual(intents);
  });

  it('calls no provider', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 4, events: ANSWER });
    const log = new CommandLog(1024);
    const session = new AgentSession({ agentId: 'A17', policy: floor(), provider, log });

    for (let tick = 0; tick < 200; tick++) {
      session.tick(tick, tick * 16);
      provider.advance(tick);
      await flush();
    }
    const after = provider.requestCount;

    const replay = new ReplaySession(log, floor(), 'A17');
    for (let tick = 0; tick < 200; tick++) replay.tick(tick, tick * 16);

    expect(provider.requestCount).toBe(after);
  });

  it('diverges when the policy differs, so agreement means something', async () => {
    const { log, intents } = await record(300);

    const different = new UtilityPolicy([
      {
        intent: {
          id: 'always-flee',
          priority: 10,
          toolIds: [],
          args: [],
          expectedExtentMs: 120,
          source: 'floor',
        },
        score: () => 1,
      },
    ]);

    const replay = new ReplaySession(log, different, 'A17');
    const replayed: string[] = [];
    for (let tick = 0; tick < 300; tick++) replayed.push(replay.tick(tick, tick * 16).id);

    /* A replay that agreed regardless would be proving nothing about the floor — it
       would only be proving that the log was read. */
    expect(replayed).not.toEqual(intents);
  });

  it('records only what cannot be recomputed', async () => {
    const { log } = await record(1000);

    /* The floor is deterministic, so its decisions are derived rather than stored. A
       log as long as the recording would mean the floor was being stored too. */
    expect(log.length).toBeGreaterThan(0);
    expect(log.length).toBeLessThan(1000);
  });

  it('replays exactly across a preemption', async () => {
    /* Slow enough that an observation usually arrives while a request is still out,
       which is the case a preemption actually has to handle. */
    const provider = new DeterministicProvider({ latencyTicks: 50, events: ANSWER });
    const log = new CommandLog(1024);
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(),
      provider,
      log,
      whileBusy: 'preempt',
      dedupeWindowMs: 0,
    });

    const intents: string[] = [];
    for (let tick = 0; tick < 400; tick++) {
      if (tick % 37 === 0) {
        session.observe({ id: `impact-${tick}`, priority: 99, text: 'loud impact' });
      }
      intents.push(session.tick(tick, tick * 16).id);
      provider.advance(tick);
      await flush();
    }

    expect(session.usage.preemptedRequests).toBeGreaterThan(0);

    const replay = new ReplaySession(log, floor(), 'A17');
    const replayed: string[] = [];
    for (let tick = 0; tick < 400; tick++) replayed.push(replay.tick(tick, tick * 16).id);

    expect(replayed).toEqual(intents);
  });
});
