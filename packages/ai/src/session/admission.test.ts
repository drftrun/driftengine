/**
 * A stale intent is discarded, because it is a plan for a different world.
 *
 * It was authored against a snapshot and executes later, and the buffer widens that
 * gap on purpose. Discarding rather than deferring is the whole of it: an intent whose
 * world is gone is not a plan that ran late, and holding it produces an agent that
 * acts on the past as soon as the present relents.
 */
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent.ts';
import { UtilityPolicy } from '../policy/utility.ts';
import type { Intent, PolicyOption } from '../policy/types.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { ToolDefinition, ToolSchema } from '../tools/registry.ts';
import { DeterministicProvider } from '../testing/deterministic.ts';
import type { AiEvent } from '../provider/types.ts';

interface World {
  present: Set<string>;
}

const EMPTY_SCHEMA: ToolSchema = { kind: 'object', fields: {} };

function tool(id: string, admits: (args: never, world: World) => boolean) {
  return {
    id,
    description: 'a tool',
    schema: EMPTY_SCHEMA,
    admits,
    execute: () => undefined as never,
  } as ToolDefinition<never, never, World>;
}

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

function answering(toolIds: string[]): AiEvent[] {
  return [
    ...toolIds.map((toolId, i): AiEvent => ({
      kind: 'toolCall',
      callId: `c${i}`,
      toolId,
      args: {},
    })),
    { kind: 'done', reason: 'complete' },
  ];
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('admission at drain', () => {
  it('discards a buffered intent whose guard has gone false, and the floor covers', async () => {
    const world: World = { present: new Set(['D4']) };
    const tools = new ToolRegistry<World>();
    tools.register(tool('inspect@1', (_a, w) => w.present.has('D4')));

    const provider = new DeterministicProvider({
      latencyTicks: 1,
      events: answering(['inspect@1']),
    });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(1000),
      provider,
      tools,
      world,
    });

    session.tick(0, 0);
    provider.advance(1);
    await flush();
    expect(session.buffered?.source).toBe('model');

    /* The door is gone between the model being asked and the answer being used. */
    world.present.delete('D4');

    session.complete(10);

    expect(session.current?.source).toBe('floor');
    expect(session.buffered).toBeNull();
  });

  it('does not retry the discarded intent on a later tick', async () => {
    const world: World = { present: new Set() };
    const tools = new ToolRegistry<World>();
    tools.register(tool('inspect@1', (_a, w) => w.present.has('D4')));

    const provider = new DeterministicProvider({
      latencyTicks: 1,
      events: answering(['inspect@1']),
    });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(50),
      provider,
      tools,
      world,
    });

    session.tick(0, 0);
    provider.advance(1);
    await flush();
    session.complete(10);

    /* Deferring would produce an agent that acts on the past the moment the present
       relents — the door reappears and a five-second-old plan executes as though it
       had just been made. */
    world.present.add('D4');
    for (let tick = 1; tick < 20; tick++) {
      const intent = session.tick(tick, 20 + tick * 60);
      expect(intent.id).not.toContain('model:1');
    }
  });

  it('admits only when every tool the intent names admits', async () => {
    for (const missing of ['a', 'b', 'c']) {
      const world: World = { present: new Set(['a', 'b', 'c']) };
      world.present.delete(missing);

      const tools = new ToolRegistry<World>();
      for (const name of ['a', 'b', 'c']) {
        tools.register(tool(`${name}@1`, (_args, w) => w.present.has(name)));
      }

      const provider = new DeterministicProvider({
        latencyTicks: 1,
        events: answering(['a@1', 'b@1', 'c@1']),
      });
      const session = new AgentSession({
        agentId: 'A17',
        policy: floor(1000),
        provider,
        tools,
        world,
      });

      session.tick(0, 0);
      provider.advance(1);
      await flush();
      session.complete(10);

      expect(session.current?.source, `with ${missing} absent`).toBe('floor');
    }
  });

  it('takes a guard that throws as a refusal rather than an exception in the tick', async () => {
    const world: World = { present: new Set() };
    const tools = new ToolRegistry<World>();
    tools.register(
      tool('boom@1', () => {
        throw new Error('consumer bug');
      }),
    );

    const provider = new DeterministicProvider({
      latencyTicks: 1,
      events: answering(['boom@1']),
    });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(1000),
      provider,
      tools,
      world,
    });

    session.tick(0, 0);
    provider.advance(1);
    await flush();

    expect(() => session.complete(10)).not.toThrow();
    expect(session.current?.source).toBe('floor');
  });

  it('leaves no tick with an empty slot at the drain where the guard fails', async () => {
    const world: World = { present: new Set() };
    const tools = new ToolRegistry<World>();
    tools.register(tool('inspect@1', (_a, w) => w.present.has('D4')));

    const provider = new DeterministicProvider({
      latencyTicks: 2,
      events: answering(['inspect@1']),
    });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(40),
      provider,
      tools,
      world,
    });

    /* Every guard fails, so every buffered intent is discarded at every drain. The
       agent must still have something to do on every one of these ticks. */
    let empties = 0;
    for (let tick = 0; tick < 500; tick++) {
      const intent = session.tick(tick, tick * 20);
      provider.advance(tick);
      await flush();
      if (session.current === null || intent === null) empties++;
    }

    expect(empties).toBe(0);
  });

  it('admits an intent naming no tools, because a deliberate pause is still a plan', async () => {
    const world: World = { present: new Set() };
    const tools = new ToolRegistry<World>();

    const provider = new DeterministicProvider({ latencyTicks: 1, events: answering([]) });
    const session = new AgentSession({
      agentId: 'A17',
      policy: floor(1000),
      provider,
      tools,
      world,
    });

    session.tick(0, 0);
    provider.advance(1);
    await flush();
    session.complete(10);

    expect(session.current?.source).toBe('model');
  });
});
