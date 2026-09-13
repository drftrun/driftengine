import { describe, expect, it } from 'vitest';
import { hasKnownExtent, UNKNOWN_EXTENT, validateIntent } from './types.ts';
import type { Intent } from './types.ts';

function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i',
    priority: 10,
    toolIds: ['inspect@1'],
    args: [{}],
    expectedExtentMs: 1000,
    source: 'model',
    ...over,
  };
}

describe('Intent', () => {
  it('treats -1 as the documented unknown extent', () => {
    expect(UNKNOWN_EXTENT).toBe(-1);
    expect(hasKnownExtent(intent({ expectedExtentMs: UNKNOWN_EXTENT }))).toBe(false);
    expect(hasKnownExtent(intent({ expectedExtentMs: 0 }))).toBe(true);
    expect(hasKnownExtent(intent({ expectedExtentMs: 1 }))).toBe(true);
  });

  it('rejects a tool and argument mismatch, naming both lengths', () => {
    const result = validateIntent(intent({ toolIds: ['a@1', 'b@1'], args: [{}] }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('2');
      expect(result.reason).toContain('1');
    }
  });

  it('accepts an intent that names no tools at all', () => {
    /* A wait, a look, a pause. The floor produces these and they are not degenerate —
       an agent doing nothing on purpose is still an agent with a purpose. */
    expect(validateIntent(intent({ toolIds: [], args: [] })).ok).toBe(true);
  });

  it('lets a floor intent outrank every model intent', () => {
    const panic = intent({ source: 'floor', priority: 1000 });
    const proposal = intent({ source: 'model', priority: 40 });

    /*
     * The floor is not implicitly lowest. A consumer's panic behaviour — flee, take
     * cover, stop before the edge — must be able to outrank anything a model
     * proposed, and a design that ranked the floor below the model by construction
     * would make that unexpressible.
     */
    expect(panic.priority).toBeGreaterThan(proposal.priority);
    expect(validateIntent(panic).ok).toBe(true);
  });
});
