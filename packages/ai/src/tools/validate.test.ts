/**
 * Validation that names the field and never throws.
 *
 * Every failure is a returned result. A model producing bad arguments is ordinary
 * rather than exceptional — it is the thing schemas exist for — and a throw would put
 * the ordinary case on the exception path.
 */
import { describe, expect, it } from 'vitest';
import { validateArgs } from './validate.ts';
import type { ToolSchema } from './registry.ts';

const TARGET: ToolSchema = {
  kind: 'object',
  fields: {
    target: { kind: 'string' },
    distance: { kind: 'number' },
  },
};

describe('validateArgs', () => {
  it('accepts a valid object and returns the value', () => {
    const result = validateArgs(TARGET, { target: 'D4', distance: 8 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ target: 'D4', distance: 8 });
  });

  it('names a missing field in the path', () => {
    const result = validateArgs(TARGET, { target: 'D4' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe('distance');
      expect(result.reason).toMatch(/missing/i);
    }
  });

  it('names both the expected and the received type', () => {
    const result = validateArgs(TARGET, { target: 'D4', distance: 'eight' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('number');
      expect(result.reason).toContain('string');
    }
  });

  it('reports a nested failure with a dotted path', () => {
    const nested: ToolSchema = {
      kind: 'object',
      fields: {
        target: {
          kind: 'object',
          fields: { position: { kind: 'object', fields: { x: { kind: 'number' } } } },
        },
      },
    };

    const result = validateArgs(nested, { target: { position: { x: 'no' } } });

    expect(result.ok).toBe(false);
    /* `x` alone would send a reader looking through every field called x in the
       schema. The path is what makes the message actionable. */
    if (!result.ok) expect(result.path).toBe('target.position.x');
  });

  it('rejects an extra field rather than dropping it', () => {
    const result = validateArgs(TARGET, { target: 'D4', distance: 8, colour: 'red' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      /* A model inventing a field is a signal. Silently discarding it hides the drift
         between what the prompt describes and what the schema accepts, and that drift
         is exactly what a versioned schema exists to make visible. */
      expect(result.path).toBe('colour');
      expect(result.reason).toMatch(/unknown|extra|not in the schema/i);
    }
  });

  it('lists the permitted values when an enum is wrong', () => {
    const schema: ToolSchema = {
      kind: 'object',
      fields: { mode: { kind: 'enum', values: ['walk', 'run'] } },
    };

    const result = validateArgs(schema, { mode: 'fly' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('walk');
      expect(result.reason).toContain('run');
    }
  });

  it('validates arrays element by element, with an indexed path', () => {
    const schema: ToolSchema = {
      kind: 'object',
      fields: { tags: { kind: 'array', of: { kind: 'string' } } },
    };

    expect(validateArgs(schema, { tags: ['a', 'b'] }).ok).toBe(true);

    const result = validateArgs(schema, { tags: ['a', 7] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe('tags[1]');
  });

  it('never throws, on any input', () => {
    const inputs = [null, undefined, 7, 'string', [], () => undefined, Symbol('s')];

    for (const input of inputs) {
      expect(() => validateArgs(TARGET, input)).not.toThrow();
      expect(validateArgs(TARGET, input).ok).toBe(false);
    }
  });
});
