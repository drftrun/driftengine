import type { ToolSchema } from './registry.ts';

export type ValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string; readonly path: string };

/**
 * Check a model's arguments against a tool's schema.
 *
 * **Never throws.** A model producing bad arguments is ordinary rather than
 * exceptional — it is the thing schemas exist for — and putting the ordinary case on
 * the exception path means every call site needs a `try` it will eventually forget.
 *
 * **An unknown field is a failure, not something to drop.** A model inventing a field
 * is a signal: it means the prompt and the schema disagree about the tool's shape, and
 * silently discarding it is how that disagreement survives a release. *What it costs:*
 * a provider that helpfully adds metadata to a tool call breaks until the schema names
 * it. *What would make it wrong:* if a mainstream provider does that unavoidably, the
 * answer is a declared passthrough field rather than a blanket tolerance.
 */
export function validateArgs(schema: ToolSchema, args: unknown): ValidationResult {
  const failure = check(schema, args, '');
  return failure ?? { ok: true, value: args };
}

function fail(path: string, reason: string): ValidationResult {
  return { ok: false, reason, path };
}

function check(schema: ToolSchema, value: unknown, path: string): ValidationResult | null {
  switch (schema.kind) {
    case 'string':
    case 'number':
    case 'boolean': {
      const actual = typeof value;
      if (actual !== schema.kind) {
        return fail(path, `expected ${schema.kind}, received ${describe(value)}`);
      }
      return null;
    }

    case 'enum': {
      if (typeof value !== 'string' || !schema.values.includes(value)) {
        return fail(
          path,
          `expected one of ${schema.values.join(', ')}, received ${describe(value)}`,
        );
      }
      return null;
    }

    case 'array': {
      if (!Array.isArray(value)) return fail(path, `expected array, received ${describe(value)}`);
      for (let i = 0; i < value.length; i++) {
        const failure = check(schema.of, value[i], `${path}[${i}]`);
        if (failure !== null) return failure;
      }
      return null;
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(path, `expected object, received ${describe(value)}`);
      }

      const record = value as Record<string, unknown>;
      for (const [name, field] of Object.entries(schema.fields)) {
        const at = path === '' ? name : `${path}.${name}`;
        if (!(name in record)) return fail(at, `missing required field`);
        const failure = check(field, record[name], at);
        if (failure !== null) return failure;
      }

      for (const name of Object.keys(record)) {
        if (name in schema.fields) continue;
        const at = path === '' ? name : `${path}.${name}`;
        return fail(at, `unknown field, not in the schema`);
      }

      return null;
    }

    default:
      return fail(path, `unrecognised schema kind`);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
