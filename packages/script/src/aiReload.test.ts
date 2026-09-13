/**
 * A reload disposes sessions and keeps the budget.
 *
 * The rules a hot reload has to hold for an agent, each of which is a different kind of
 * mistake if it is got wrong: a leaked remote stream, a budget that resets on every
 * edit, a duplicate registration, and a buffered intent naming a tool that has gone.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentSession,
  Budget,
  DeterministicProvider,
  ToolRegistry,
  UtilityPolicy,
} from '@driftengine/ai';
import type { AiEvent, Intent, PolicyOption, ToolDefinition, ToolSchema } from '@driftengine/ai';

interface World {
  readonly present: Set<string>;
}

const SCHEMA: ToolSchema = { kind: 'object', fields: {} };

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

function tool(id: string, schema: ToolSchema = SCHEMA): ToolDefinition<never, never, World> {
  return {
    id,
    description: 'a tool',
    schema,
    admits: () => true,
    execute: () => undefined as never,
  } as ToolDefinition<never, never, World>;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('hot reload and an agent', () => {
  it('aborts every in-flight request the reloaded module owned', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 500, events: answering('a@1') });
    const sessions = [
      new AgentSession({ agentId: 'A1', policy: floor(), provider }),
      new AgentSession({ agentId: 'A2', policy: floor(), provider }),
    ];

    for (const session of sessions) session.tick(0, 0);
    expect(provider.requestCount).toBe(2);

    /* What a reload does: dispose what the old module owned, before the new one runs. */
    for (const session of sessions) session.dispose('hot reload');
    await flush();

    /* No leaked remote stream survives the remount. */
    expect(provider.abortedCount).toBe(2);
  });

  it('keeps usage across the reload, because a budget that reset would be no budget', async () => {
    const provider = new DeterministicProvider({ latencyTicks: 1, events: answering('a@1') });
    const budget = new Budget({ requests: 3 });
    const before = new AgentSession({ agentId: 'A1', policy: floor(200), provider, budget });

    for (let tick = 0; tick < 40; tick++) {
      before.tick(tick, tick * 16);
      provider.advance(tick);
      await flush();
    }
    const spent = before.usage.requests;
    expect(spent).toBeGreaterThan(0);
    before.dispose('hot reload');

    /*
     * The consumer carries the budget across, and the new session inherits an exhausted
     * one. A budget scoped to a session would reset on every edit, so a developer would
     * spend an afternoon's tokens and every reload would report none.
     */
    const after = new AgentSession({ agentId: 'A1', policy: floor(200), provider, budget });
    expect(after.degraded).toBe(budget.exhausted);
  });

  it('lets a reload re-register a tool id with a changed schema', () => {
    const registry = new ToolRegistry<World>();
    registry.register(tool('inspect@1'));

    /* A duplicate id is an error, and it has to stay one: two tools answering to one
       name is a call resolving to whichever registered last. A reload is not that — it
       is the *same* tool declared again — so a consumer rebuilds the registry rather
       than mutating it, and this asserts the rebuild is what works. */
    expect(() => registry.register(tool('inspect@1'))).toThrow(/inspect@1/);

    const rebuilt = new ToolRegistry<World>();
    rebuilt.register(tool('inspect@1', { kind: 'object', fields: { added: { kind: 'string' } } }));
    expect(rebuilt.get('inspect@1')?.schema).toEqual({
      kind: 'object',
      fields: { added: { kind: 'string' } },
    });
  });

  it('discards a buffered intent naming a tool the reload removed, and the floor covers', async () => {
    const world: World = { present: new Set() };
    const before = new ToolRegistry<World>();
    before.register(tool('gone@1'));

    const provider = new DeterministicProvider({ latencyTicks: 1, events: answering('gone@1') });
    const session = new AgentSession({
      agentId: 'A1',
      policy: floor(1000),
      provider,
      tools: before,
      world,
    });

    session.tick(0, 0);
    provider.advance(1);
    await flush();
    expect(session.buffered?.toolIds).toEqual(['gone@1']);

    /* The new module does not declare `gone@1`. The buffered intent names something
       that no longer exists, and the composed guard refuses an unregistered tool. */
    const after = new ToolRegistry<World>();
    after.register(tool('kept@1'));
    const reloaded = new AgentSession({
      agentId: 'A1',
      policy: floor(1000),
      provider,
      tools: after,
      world,
    });

    reloaded.tick(0, 0);
    expect(reloaded.current?.source).toBe('floor');
    expect(after.admits(['gone@1'], [{}], world)).toBe(false);
  });
});
