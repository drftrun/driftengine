import { describe, expect, it } from 'vitest';
import { CommandLog } from './log.ts';
import type { AiCommand, LogEntry } from './log.ts';
import { applyCommand } from './apply.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { ToolDefinition, ToolSchema } from '../tools/registry.ts';

function command(over: Partial<AiCommand> = {}): AiCommand {
  return {
    kind: 'command',
    toolId: 'inspect@1',
    args: {},
    agentId: 'A17',
    issuedAtTick: 10,
    acceptedAtTick: 12,
    ...over,
  };
}

describe('CommandLog', () => {
  it('writes into the caller array and returns a count', () => {
    const log = new CommandLog(16);
    log.record(command({ acceptedAtTick: 5 }));
    log.record(command({ acceptedAtTick: 5, toolId: 'speak@1' }));
    log.record(command({ acceptedAtTick: 6 }));

    const out: LogEntry[] = [];
    /* Reading a tick allocates nothing. A replay reads every tick, so a per-tick array
       would put an allocation on the one path that walks the whole recording. */
    expect(log.at(5, out)).toBe(2);
    expect(out.slice(0, 2).map((e) => (e.kind === 'command' ? e.toolId : e.kind))).toEqual([
      'inspect@1',
      'speak@1',
    ]);
  });

  it('returns commands accepted at one tick in acceptance order', () => {
    const log = new CommandLog(16);
    for (const id of ['a@1', 'b@1', 'c@1']) log.record(command({ toolId: id, acceptedAtTick: 3 }));

    const out: LogEntry[] = [];
    log.at(3, out);
    expect(out.slice(0, 3).map((c) => (c.kind === 'command' ? c.toolId : c.kind))).toEqual([
      'a@1',
      'b@1',
      'c@1',
    ]);
  });

  it('wraps at capacity, retaining the newest', () => {
    const log = new CommandLog(4);
    for (let tick = 0; tick < 10; tick++) log.record(command({ acceptedAtTick: tick }));

    expect(log.length).toBe(4);

    const out: LogEntry[] = [];
    expect(log.at(0, out)).toBe(0);
    expect(log.at(9, out)).toBe(1);
  });

  it('returns zero and writes nothing for a tick with no commands', () => {
    const log = new CommandLog(4);
    log.record(command({ acceptedAtTick: 1 }));

    const out: LogEntry[] = ['sentinel' as unknown as LogEntry];
    expect(log.at(99, out)).toBe(0);
    expect(out[0]).toBe('sentinel');
  });

  it('records a preemption beside the commands, because input cannot be recomputed', () => {
    const log = new CommandLog(8);
    log.record(command({ acceptedAtTick: 4 }));
    log.record({ kind: 'preemption', agentId: 'A17', acceptedAtTick: 9 });

    const out: LogEntry[] = [];
    expect(log.at(9, out)).toBe(1);
    /*
     * The floor is deterministic and replays by rerunning, but an observation is
     * external input — the same class of thing as a keypress. Without this entry a
     * replay reruns the floor straight past the moment it was interrupted, and every
     * decision after that is wrong for one reason.
     */
    expect(out[0]?.kind).toBe('preemption');
  });

  it('keeps issue and acceptance ticks apart', () => {
    const log = new CommandLog(4);
    log.record(command({ issuedAtTick: 100, acceptedAtTick: 140 }));

    const out: LogEntry[] = [];
    log.at(140, out);
    const first = out[0];
    if (first?.kind !== 'command') throw new Error('expected a command');

    /* The gap between them is what the admission guards exist to police, and a trace
       that collapsed the two would hide exactly the thing a buffered agent widens. */
    expect(first.issuedAtTick).toBe(100);
    expect(first.acceptedAtTick).toBe(140);
  });
});

interface World {
  present: Set<string>;
  moved: string[];
}

const SCHEMA: ToolSchema = { kind: 'object', fields: {} };

function tools(over: Partial<ToolDefinition<never, never, World>> = {}): ToolRegistry<World> {
  const registry = new ToolRegistry<World>();
  registry.register({
    id: 'inspect@1',
    description: 'a tool',
    schema: SCHEMA,
    admits: (_args, world) => world.present.has('D4'),
    execute: (_args, world) => {
      world.moved.push('D4');
      return 'inspected' as never;
    },
    ...over,
  } as ToolDefinition<never, never, World>);
  return registry;
}

describe('applyCommand', () => {
  it('executes when the preconditions still hold', () => {
    const world: World = { present: new Set(['D4']), moved: [] };
    const outcome = applyCommand(tools(), world, command(), 140);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toBe('inspected');
  });

  it('refuses a command whose guard has gone false since acceptance', () => {
    const world: World = { present: new Set(), moved: [] };
    const outcome = applyCommand(tools(), world, command(), 140);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain('inspect@1');
      /*
       * The guard ran once at the drain and runs again here, because those are two
       * different moments. A snapshot is never authority, and the buffer widens the
       * gap on purpose — admission proves the plan was true when it was taken up, not
       * that it is true now.
       */
      expect(outcome.reason).toMatch(/no longer admits|changed/);
    }
    expect(world.moved).toEqual([]);
  });

  it('refuses an unregistered tool', () => {
    const world: World = { present: new Set(['D4']), moved: [] };
    const outcome = applyCommand(tools(), world, command({ toolId: 'ghost@1' }), 1);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/unknown/);
  });

  it('turns a throwing execute into a returned failure', () => {
    const world: World = { present: new Set(['D4']), moved: [] };
    const registry = tools({
      execute: () => {
        throw new Error('collider missing');
      },
    });

    const outcome = applyCommand(registry, world, command(), 1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('collider missing');
  });

  it('never throws, on any path', () => {
    const world: World = { present: new Set(['D4']), moved: [] };
    const throwing = tools({
      admits: () => {
        throw new Error('guard bug');
      },
    });

    /* A caller inside `fixedUpdate` never needs a `try`. */
    expect(() => applyCommand(throwing, world, command(), 1)).not.toThrow();
    expect(() => applyCommand(tools(), world, command({ toolId: 'ghost@1' }), 1)).not.toThrow();
  });
});
