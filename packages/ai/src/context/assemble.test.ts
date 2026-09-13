/**
 * Context selected within a budget, and what it dropped said out loud.
 */
import { describe, expect, it } from 'vitest';
import { assembleContext } from './assemble.ts';
import type { ContextProvider } from './assemble.ts';

function provider(
  id: string,
  priority: number,
  items: unknown,
  over: Partial<ContextProvider<unknown>> = {},
): ContextProvider<unknown> {
  return {
    id,
    priority,
    describe: () => ({ title: id, schema: { kind: 'string' } }),
    sample: () => items,
    ...over,
  };
}

describe('assembleContext', () => {
  it('orders sections by descending priority', () => {
    const result = assembleContext(
      [provider('low@1', 1, ['a']), provider('high@1', 100, ['b']), provider('mid@1', 50, ['c'])],
      'A17',
      42,
      10_000,
    );

    expect(result.sections.map((s) => s.id)).toEqual(['high@1', 'mid@1', 'low@1']);
  });

  it('stamps the capture tick on the result rather than on each section', () => {
    const result = assembleContext([provider('a@1', 1, ['x'])], 'A17', 18_221, 10_000);

    /* One stamp, because one assembly happened at one tick. Per-section stamps would
       imply the sections could disagree, and a model reading two different ages for
       one snapshot has been told something false. */
    expect(result.capturedAtTick).toBe(18_221);
    expect(Object.keys(result.sections[0] ?? {})).not.toContain('capturedAtTick');
  });

  it('truncates to maxItems and says that it did', () => {
    const result = assembleContext(
      [provider('many@1', 1, ['a', 'b', 'c', 'd'], { maxItems: 2 })],
      'A17',
      0,
      10_000,
    );

    expect(result.sections[0]?.items).toEqual(['a', 'b']);
    /* Short and truncated look identical from the outside, and only one of them means
       there is more to ask about. */
    expect(result.sections[0]?.truncated).toBe(true);
  });

  it('drops whole sections when the budget runs out, lowest priority first, and names them', () => {
    const big = Array.from({ length: 200 }, (_, i) => `item-${i}`);
    const result = assembleContext(
      [provider('keep@1', 100, ['small']), provider('drop@1', 1, big)],
      'A17',
      0,
      20,
    );

    expect(result.sections.map((s) => s.id)).toEqual(['keep@1']);
    expect(result.dropped).toEqual(['drop@1']);
  });

  it('drops a provider whose sample throws rather than failing the assembly', () => {
    const result = assembleContext(
      [
        provider('broken@1', 100, null, {
          sample: () => {
            throw new Error('consumer bug');
          },
        }),
        provider('fine@1', 1, ['x']),
      ],
      'A17',
      0,
      10_000,
    );

    /* One bad context provider must not silence an agent. */
    expect(result.dropped).toContain('broken@1');
    expect(result.sections.map((s) => s.id)).toEqual(['fine@1']);
  });

  it('needs no provider tokenizer to estimate', () => {
    /* A provider-specific tokenizer may sharpen the estimate but must not be required
       by the core abstraction — otherwise assembling context would depend on which
       provider happened to be configured, and a test could not run without one. */
    const result = assembleContext([provider('a@1', 1, ['hello'])], 'A17', 0, 10_000);

    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('reports zero sections and no crash when given nothing', () => {
    const result = assembleContext([], 'A17', 7, 100);

    expect(result.sections).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.capturedAtTick).toBe(7);
  });
});
