/**
 * A tool registry whose ids are versioned and whose schemas are expressible.
 *
 * The registry is also where **admission guards** live, and where they must live: a
 * guard declared by the tool, once, at registration, is a guard the model cannot
 * write. A model-authored precondition on a model-authored action is the model
 * marking its own homework.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.ts';
import type { ToolDefinition, ToolSchema } from './registry.ts';

interface World {
  readonly present: ReadonlySet<string>;
}

const OBJECT_SCHEMA: ToolSchema = {
  kind: 'object',
  fields: { target: { kind: 'string' } },
};

function tool(id: string, extra: Partial<ToolDefinition<never, never, World>> = {}) {
  return {
    id,
    description: 'a tool',
    schema: OBJECT_SCHEMA,
    admits: () => true,
    execute: () => undefined as never,
    ...extra,
  } as ToolDefinition<never, never, World>;
}

describe('ToolRegistry', () => {
  it('refuses a duplicate id, naming it', () => {
    const registry = new ToolRegistry<World>();
    registry.register(tool('inspect@1'));

    expect(() => registry.register(tool('inspect@1'))).toThrow(/inspect@1/);
  });

  it('accepts a second version of the same tool alongside the first', () => {
    const registry = new ToolRegistry<World>();
    registry.register(tool('inspect@1'));
    registry.register(tool('inspect@2'));

    /* Versioning the id is what makes this legal. A recorded trace written against
       `inspect@1` stays readable after `inspect@2` ships, which is the whole reason
       the suffix is required rather than encouraged. */
    expect(registry.ids()).toEqual(['inspect@1', 'inspect@2']);
  });

  it('refuses an id with no version, and says why versions are required', () => {
    const registry = new ToolRegistry<World>();

    expect(() => registry.register(tool('inspect'))).toThrow(/version/i);
  });

  it('returns ids in registration order, so a prompt list is stable', () => {
    const registry = new ToolRegistry<World>();
    registry.register(tool('zebra@1'));
    registry.register(tool('apple@1'));
    registry.register(tool('mango@1'));

    /* Registration order, deliberately not alphabetical — and the names are chosen so
       the two disagree. A test whose fixture makes them agree cannot fail. */
    expect(registry.ids()).toEqual(['zebra@1', 'apple@1', 'mango@1']);
  });

  it('refuses a schema carrying a value no schema can express, naming the path', () => {
    const registry = new ToolRegistry<World>();
    const bad = {
      kind: 'object',
      fields: {
        target: { kind: 'string' },
        nested: { kind: 'object', fields: { callback: { kind: 'function' } } },
      },
    } as unknown as ToolSchema;

    expect(() => registry.register(tool('bad@1', { schema: bad }))).toThrow(/nested\.callback/);
  });

  it('returns undefined for an unregistered id rather than throwing', () => {
    const registry = new ToolRegistry<World>();

    /* Resolution failure is the caller's refusal to word — the execution policy
       distinguishes "unknown" from "not permitted", and it cannot do that if the
       lookup has already thrown. */
    expect(registry.get('missing@1')).toBeUndefined();
  });

  it('admits an intent only when every tool it names admits', () => {
    const registry = new ToolRegistry<World>();
    registry.register(tool('a@1', { admits: (_args, world) => world.present.has('a') }));
    registry.register(tool('b@1', { admits: (_args, world) => world.present.has('b') }));

    const world = { present: new Set(['a', 'b']) };
    expect(registry.admits(['a@1', 'b@1'], [{}, {}], world)).toBe(true);
    expect(registry.admits(['a@1', 'b@1'], [{}, {}], { present: new Set(['a']) })).toBe(false);
    expect(registry.admits(['a@1', 'b@1'], [{}, {}], { present: new Set(['b']) })).toBe(false);
  });

  it('treats a guard that throws as a refusal rather than propagating', () => {
    const registry = new ToolRegistry<World>();
    registry.register(
      tool('boom@1', {
        admits: () => {
          throw new Error('consumer bug');
        },
      }),
    );

    /* Guards run inside a fixed step. A consumer bug in one must not become an
       exception in the middle of a tick — it becomes a refusal, and the floor covers. */
    expect(() => registry.admits(['boom@1'], [{}], { present: new Set() })).not.toThrow();
    expect(registry.admits(['boom@1'], [{}], { present: new Set() })).toBe(false);
  });

  it('refuses an intent naming a tool that is not registered', () => {
    const registry = new ToolRegistry<World>();

    expect(registry.admits(['gone@1'], [{}], { present: new Set() })).toBe(false);
  });
});
