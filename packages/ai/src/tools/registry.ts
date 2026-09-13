/**
 * Tools an agent may call, and the guards that decide whether a proposal is still true.
 *
 * A tool schema is generated from the same contracts the language type-checks against,
 * so it cannot drift from the implementation. That is what makes this different from
 * writing a prompt that describes some functions.
 */

/**
 * What a model may be asked to produce.
 *
 * Schema-expressible types only. Anything a schema cannot describe cannot be asked
 * for, validated, or recorded in a trace, and a tool taking one would be a tool whose
 * arguments are checked by hope.
 */
export type ToolSchema =
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'array'; readonly of: ToolSchema }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ToolSchema>> };

const EXPRESSIBLE = new Set(['string', 'number', 'boolean', 'enum', 'array', 'object']);

/**
 * `W` is the consumer's world view, and this package never constrains it.
 *
 * An engine package that knew what a world contained would be an engine package that
 * knew what game it was in. A guard asking `world.exists(id)` is the consumer's
 * sentence, written against the consumer's world.
 */
export interface ToolDefinition<A, R, W> {
  /** Stable and versioned — `inspect@1`. Never renumbered once shipped. */
  readonly id: string;
  readonly description: string;
  readonly schema: ToolSchema;
  readonly rateClass?: string;
  readonly idempotent?: boolean;
  /**
   * Whether this call is still true of the world.
   *
   * Declared once, at registration, by the tool. The model never writes one: a
   * model-authored precondition on a model-authored action is the model marking its
   * own homework.
   */
  admits(args: A, world: W): boolean;
  execute(args: A, world: W): R;
}

export class ToolRegistry<W> {
  private readonly byId = new Map<string, ToolDefinition<never, never, W>>();
  private readonly order: string[] = [];

  register<A, R>(tool: ToolDefinition<A, R, W>): void {
    if (this.byId.has(tool.id)) {
      throw new Error(`a tool is already registered as "${tool.id}"`);
    }
    if (!/@\d+$/.test(tool.id)) {
      throw new Error(
        `tool id "${tool.id}" carries no version — ids are versioned as "name@1" so a ` +
          `recorded trace stays readable after the tool's shape changes`,
      );
    }

    const bad = inexpressible(tool.schema, '');
    if (bad !== null) {
      throw new Error(`tool "${tool.id}" has a schema field a schema cannot express: ${bad}`);
    }

    this.byId.set(tool.id, tool as unknown as ToolDefinition<never, never, W>);
    this.order.push(tool.id);
  }

  /** Registration order, so a prompt's tool list is stable and a trace stays comparable. */
  ids(): readonly string[] {
    return this.order;
  }

  get(id: string): ToolDefinition<never, never, W> | undefined {
    return this.byId.get(id);
  }

  /**
   * Whether every tool an intent names still admits its arguments.
   *
   * A plain loop rather than a `map` and an `every`: this runs at the moment a
   * buffered intent drains, which is inside a fixed step.
   */
  admits(toolIds: readonly string[], args: readonly unknown[], world: W): boolean {
    for (let i = 0; i < toolIds.length; i++) {
      const id = toolIds[i];
      if (id === undefined) return false;
      const tool = this.byId.get(id);
      if (tool === undefined) return false;
      try {
        if (!tool.admits(args[i] as never, world)) return false;
      } catch {
        /* A consumer bug in a guard must not become an exception inside a tick. It
           becomes a refusal, the intent is discarded, and the policy floor covers. */
        return false;
      }
    }
    return true;
  }
}

/** The dotted path of the first field no schema can express, or `null`. */
function inexpressible(schema: ToolSchema, path: string): string | null {
  if (!EXPRESSIBLE.has(schema.kind)) return path === '' ? schema.kind : path;

  if (schema.kind === 'array') return inexpressible(schema.of, path === '' ? 'of' : `${path}.of`);

  if (schema.kind === 'object') {
    for (const [name, field] of Object.entries(schema.fields)) {
      const found = inexpressible(field, path === '' ? name : `${path}.${name}`);
      if (found !== null) return found;
    }
  }

  return null;
}
