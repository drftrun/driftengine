/**
 * The model is told when its answer will be used, in three lines.
 */
import { describe, expect, it } from 'vitest';
import { continuationPreamble } from './continuation.ts';
import { UNKNOWN_EXTENT } from '../policy/types.ts';
import type { Intent } from '../policy/types.ts';
import { AgentSession } from '../session/agent.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { PolicyOption } from '../policy/types.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent, AiRequest } from '../provider/types.ts';

function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'inspect-door',
    priority: 10,
    toolIds: ['inspect@1'],
    args: [{}],
    expectedExtentMs: 2000,
    source: 'model',
    ...over,
  };
}

describe('continuationPreamble', () => {
  it('says what the agent is doing', () => {
    expect(continuationPreamble(intent(), 1400)).toContain('inspect-door');
  });

  it('says how long is left', () => {
    expect(continuationPreamble(intent(), 1400)).toContain('1.4s');
  });

  it('says the answer applies when that finishes, not now', () => {
    const text = continuationPreamble(intent(), 1400);

    /* The line that does the work. Without it the model proposes what is right now
       and wrong in 1.4 seconds, and the lookahead becomes lag that is still paid for. */
    expect(text).toContain('when that finishes, not now');
  });

  it('says unknown rather than printing a negative number', () => {
    const text = continuationPreamble(intent({ expectedExtentMs: UNKNOWN_EXTENT }), -1);

    expect(text).toContain('unknown');
    expect(text).not.toContain('-1');
  });

  it('describes a floor intent exactly as it describes a model intent', () => {
    const fromFloor = continuationPreamble(intent({ source: 'floor' }), 1400);
    const fromModel = continuationPreamble(intent({ source: 'model' }), 1400);

    /* Telling the model the engine improvised would invite it to treat the current
       behaviour as provisional. The floor's choice is what the agent is doing. */
    expect(fromFloor).toBe(fromModel);
  });
});

describe('the session sends it', () => {
  it('carries the preamble on a continuation but not on a first request', async () => {
    const seen: AiRequest[] = [];
    const events: AiEvent[] = [{ kind: 'done', reason: 'complete' }];
    const provider = new DeterministicProvider({ latencyTicks: 1, events });

    const wrapped = {
      id: provider.id,
      capabilities: provider.capabilities,
      createSession: (options: { model: string }) => {
        const inner = provider.createSession(options);
        return {
          run: (request: AiRequest) => {
            seen.push(request);
            return inner.run(request);
          },
          abort: (reason?: string) => inner.abort(reason),
        };
      },
    };

    const option: PolicyOption = {
      intent: {
        id: 'idle',
        priority: 10,
        toolIds: [],
        args: [],
        expectedExtentMs: 1000,
        source: 'floor',
      },
      score: () => 1,
    };

    const session = new AgentSession({
      agentId: 'A17',
      policy: new UtilityPolicy([option]),
      provider: wrapped,
    });

    session.tick(0, 0);

    /*
     * Every request this session makes is a continuation: by the time one is issued
     * the floor has already said what the agent is doing, which is the state the
     * preamble describes. A request with no "currently" would be one issued before
     * any intent existed, and the state machine has no edge for that.
     */
    expect(seen).toHaveLength(1);
    expect(seen[0]?.preamble).toContain('when that finishes, not now');
  });
});
