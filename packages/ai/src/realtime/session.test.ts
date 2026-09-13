/**
 * Realtime sessions that add a transport and change no consumer.
 */
import { describe, expect, it } from 'vitest';
import { createRealtimeSession } from './session.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import { AgentSession } from '../session/agent.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import type { AiEvent, AiProvider, AiRequest } from '../provider/types.ts';

const HELLO: AiEvent[] = [
  { kind: 'text', text: 'hello' },
  { kind: 'done', reason: 'complete' },
];

function request(): AiRequest {
  return {
    preamble: '',
    context: { capturedAtTick: 0 },
    toolIds: [],
    signal: new AbortController().signal,
  };
}

function withRealtime(base: DeterministicProvider, realtimeAudio: boolean): AiProvider {
  return {
    id: base.id,
    capabilities: { ...base.capabilities, realtimeAudio },
    createSession: (options) => base.createSession(options),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('createRealtimeSession', () => {
  it('refuses a provider declaring no realtime transport, before connecting', () => {
    const base = new DeterministicProvider({ latencyTicks: 1, events: HELLO });
    const result = createRealtimeSession(withRealtime(base, false), { model: 'test' });

    expect(result.session).toBeNull();
    expect(result.reason).toContain('no realtime transport');
    /* Before, not during: no session was created against the provider at all. A socket
       opened against something that cannot hold the conversation fails later and more
       expensively than a string comparison. */
    expect(base.requestCount).toBe(0);
  });

  it('emits the same event union a non-realtime session emits', async () => {
    const base = new DeterministicProvider({ latencyTicks: 1, events: HELLO });
    const result = createRealtimeSession(withRealtime(base, true), { model: 'test' });
    expect(result.session).not.toBeNull();

    const seen: AiEvent[] = [];
    void (async () => {
      for await (const event of result.session?.run(request()) ?? []) seen.push(event);
    })();

    base.advance(1);
    await flush();

    /* Nothing downstream branches on transport. The buffered loop, the floor, the
       guards and the command log all read what they already read. */
    expect(seen).toEqual(HELLO);
  });

  it('treats a second disposal as a no-op rather than an error', () => {
    const base = new DeterministicProvider({ latencyTicks: 1, events: HELLO });
    const result = createRealtimeSession(withRealtime(base, true), { model: 'test' });

    /* Disposal races a scene replacement and a hot reload, and both may reach the same
       session. */
    expect(() => result.session?.abort('first')).not.toThrow();
    expect(() => result.session?.abort('second')).not.toThrow();
  });

  it('leaves the buffered loop with exactly one request in flight', async () => {
    const base = new DeterministicProvider({ latencyTicks: 3, events: HELLO });
    const provider = withRealtime(base, true);

    const option: PolicyOption = {
      intent: {
        id: 'idle',
        priority: 10,
        toolIds: [],
        args: [],
        expectedExtentMs: 200,
        source: 'floor',
      } satisfies Intent,
      score: () => 1,
    };

    const session = new AgentSession({
      agentId: 'A17',
      policy: new UtilityPolicy([option]),
      provider,
    });

    for (let tick = 0; tick < 200; tick++) {
      session.tick(tick, tick * 16);
      base.advance(tick);
      await flush();
    }

    expect(base.peakConcurrency).toBe(1);
  });
});
