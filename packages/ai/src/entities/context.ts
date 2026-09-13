import {
  entityGeneration,
  entityIndex,
  packEntity,
  type Entity,
  type World,
} from '@driftengine/entities';
import type { ComponentType } from '@driftengine/entities';
import type { ContextProvider } from '../context/assemble.ts';
import type { ToolDefinition, ToolSchema } from '../tools/registry.ts';

/**
 * Context and tools over an entity world.
 *
 * This is the half of AI-6 that links. The other half — a bridge that moves something
 * along a path — is refused in writing, because nothing pathfinds and `drift/navigation`
 * waits on no track at all. A seam with no implementation behind it is what R1 withdrew.
 */

/** A stable, printable name for an entity, and the only form a model ever sees. */
export function entityRef(entity: Entity): string {
  return `e${entityIndex(entity)}.${entityGeneration(entity)}`;
}

/**
 * Read a reference back, or `null` when it is not one.
 *
 * A model inventing an identifier is ordinary rather than exceptional — the parent
 * design's identity constraints say so in words — so this returns rather than throws,
 * and the caller's guard turns it into a refusal.
 */
export function parseEntityRef(ref: string, world: World): Entity | null {
  const match = /^e(\d+)\.(\d+)$/.exec(ref);
  if (match === null) return null;

  /* Rebuilt and asked, rather than searched for. `alive` compares the generation, so a
     handle whose slot has been reused answers false — which is the whole reason a
     reference carries one. */
  const entity = packEntity(Number(match[1]), Number(match[2]));
  return world.alive(entity) ? entity : null;
}

export interface EntityContextOptions {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly maxItems?: number;
  readonly components: readonly ComponentType[];
}

/**
 * A context provider that samples a query into a list of references.
 *
 * **This allocates, and that is correct here.** A reference is a string and a sample is
 * a list, so neither can be free. What matters is where it runs: context is assembled
 * once per *request*, not once per tick, and a request already costs a network round
 * trip. The floor is the per-tick path and it is the one with the allocation floor.
 *
 * What wrapping the cursor must not do is make *iteration* allocate — that property is
 * `@driftengine/entities`' and is floored in its own suite — so the loop reads the
 * cursor directly rather than materialising it first.
 */
export function entityContext(
  world: World,
  options: EntityContextOptions,
): ContextProvider<readonly string[]> {
  const schema: ToolSchema = { kind: 'array', of: { kind: 'string' } };
  const limit = options.maxItems ?? Number.POSITIVE_INFINITY;
  const [a, b, c, d] = options.components;

  return {
    id: options.id,
    priority: options.priority,
    maxItems: options.maxItems,
    describe: () => ({ title: options.title, schema }),
    sample: (): readonly string[] => {
      const out: string[] = [];
      if (a === undefined) return out;
      for (const entity of world.query(a, b, c, d)) {
        if (out.length >= limit) break;
        out.push(entityRef(entity));
      }
      return out;
    },
  };
}

/**
 * A tool addressing an entity, whose guard checks the **generation** and not only the index.
 *
 * The staleness case the buffer makes likely rather than rare: an entity is destroyed
 * and its slot is reused, so an index that still resolves resolves to something else
 * entirely. A guard checking only the index would let a plan made about one thing run
 * against another, which is worse than the plan failing.
 */
export function entityTool<R>(
  world: World,
  id: string,
  description: string,
  execute: (entity: Entity, world: World) => R,
): ToolDefinition<{ target: string }, R | null, World> {
  return {
    id,
    description,
    schema: { kind: 'object', fields: { target: { kind: 'string' } } },
    admits: (args) => parseEntityRef(args.target, world) !== null,
    execute: (args, w) => {
      const entity = parseEntityRef(args.target, world);
      return entity === null ? null : execute(entity, w);
    },
  };
}
