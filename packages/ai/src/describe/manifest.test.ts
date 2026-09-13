/**
 * A manifest that describes the agent rather than its connection.
 */
import { describe, expect, it } from 'vitest';
import { describeAgent, describeForDevelopment, requireStructuredOutput } from './manifest.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { ToolDefinition, ToolSchema } from '../tools/registry.ts';
import type { ContextProvider } from '../context/assemble.ts';
import type { AiProvider, AiProviderCapabilities } from '../provider/types.ts';

const SCHEMA: ToolSchema = { kind: 'object', fields: { target: { kind: 'string' } } };

function registry(...ids: string[]): ToolRegistry<unknown> {
  const reg = new ToolRegistry<unknown>();
  for (const id of ids) {
    reg.register({
      id,
      description: `does ${id}`,
      schema: SCHEMA,
      admits: () => true,
      execute: () => undefined as never,
    } as ToolDefinition<never, never, unknown>);
  }
  return reg;
}

function contextProvider(id: string): ContextProvider<unknown> {
  return {
    id,
    priority: 1,
    describe: () => ({ title: `title of ${id}`, schema: { kind: 'string' } }),
    sample: () => [],
  };
}

function provider(over: Partial<AiProviderCapabilities> = {}): AiProvider {
  return {
    id: 'test-provider',
    capabilities: {
      text: true,
      streamingText: true,
      structuredOutput: false,
      toolCalling: true,
      realtimeAudio: false,
      imageInput: false,
      local: false,
      ...over,
    },
    createSession: () => {
      throw new Error('not reached');
    },
  };
}

describe('describeAgent', () => {
  it('lists tools and context in registration order', () => {
    const manifest = describeAgent(
      registry('zebra@1', 'apple@1'),
      [contextProvider('recent@1'), contextProvider('visible@5')],
      provider(),
    );

    expect(manifest.tools.map((t) => t.id)).toEqual(['zebra@1', 'apple@1']);
    expect(manifest.context.map((c) => c.id)).toEqual(['recent@1', 'visible@5']);
  });

  it('carries each tool description and schema', () => {
    const manifest = describeAgent(registry('inspect@1'), [], provider());

    expect(manifest.tools[0]?.description).toBe('does inspect@1');
    expect(manifest.tools[0]?.schema).toEqual(SCHEMA);
  });

  it('describes an agent with no provider attached', () => {
    const manifest = describeAgent(registry('inspect@1'), [contextProvider('a@1')], null);

    /* An agent with no provider is still a fully described agent — it runs on its
       floor. A manifest that required a connection would have nothing to say about the
       case this package exists to make ordinary. */
    expect(manifest.providerId).toBeNull();
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.context).toHaveLength(1);
  });

  /**
   * **Nothing is refused as of 2026-09-05, and the shape still has to hold.**
   *
   * This asserted the two AI bridges by name until both shipped. A manifest listing only what works
   * teaches a reader to ask for the rest and get a failure instead of a sentence, so the *mechanism*
   * matters whether or not anything is currently using it — and an empty list asserted as empty
   * would be a test that passes if `refused` stopped existing.
   */
  it('carries a refusal list, and every entry in it says what it waits on', () => {
    const manifest = describeAgent(registry(), [], provider());

    expect(Array.isArray(manifest.refused)).toBe(true);
    expect(manifest.refused).toEqual([]);
    for (const entry of manifest.refused) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.waitsOn.length).toBeGreaterThan(0);
    }
  });

  it('states the determinism boundary', () => {
    const manifest = describeAgent(registry(), [], provider());

    expect(manifest.determinismBoundary).toContain('ecs.write');
    expect(manifest.determinismBoundary).not.toContain('ai');
  });
});

describe('requireStructuredOutput', () => {
  it('refuses before the request when the provider declares none', () => {
    const result = requireStructuredOutput(provider(), SCHEMA, { target: 'D4' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      /* Asking anyway and parsing the text is the silent-downgrade failure in a
         different hat: it works often enough to ship and fails on the input nobody
         tested. */
      expect(result.reason).toMatch(/declares no structured output/);
    }
  });

  it('accepts a value matching the schema', () => {
    const result = requireStructuredOutput(provider({ structuredOutput: true }), SCHEMA, {
      target: 'D4',
    });

    expect(result.ok).toBe(true);
  });

  it('returns a typed failure carrying the field path, never a throw', () => {
    const result = requireStructuredOutput(provider({ structuredOutput: true }), SCHEMA, {
      target: 7,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('target');
  });

  it('refuses when no provider is attached', () => {
    const result = requireStructuredOutput(null, SCHEMA, { target: 'D4' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no provider');
  });
});

describe('describeForDevelopment', () => {
  it('carries everything the runtime manifest carries', () => {
    const manifest = describeForDevelopment(registry('inspect@1'), [], provider());

    expect(manifest.tools).toHaveLength(1);
    expect(manifest.providerId).toBe('test-provider');
  });

  /**
   * The development description carries refusals a runtime reader is not told about, and that
   * channel has to stay open even while there is nothing to send down it. Both AI bridges shipped
   * on 2026-09-05 and the list emptied; `describe/manifest.test.mjs` is where the extraction is
   * watched producing a value, so an empty answer here means an empty list rather than a break.
   */
  it('carries a refusals channel a runtime reader would not be given', () => {
    const manifest = describeForDevelopment(registry(), [], null);

    expect(Array.isArray(manifest.refusals)).toBe(true);
    expect(manifest.refusals).toEqual([]);
    /* The property that distinguishes it from the runtime description, which has no such field. */
    expect('refusals' in manifest).toBe(true);
  });

  it('states the guarantees everything else exists to make cheap', () => {
    const manifest = describeForDevelopment(registry(), [], null);

    expect(manifest.guarantees[0]).toContain('never without a current intent');
    expect(manifest.guarantees.join(' ')).toContain('one provider request is in flight');
  });
});
