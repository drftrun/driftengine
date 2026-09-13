/**
 * Building a world from what a module declares.
 *
 * A compiled `.drs` file carries its components, entities, systems and prefabs as **description**
 * rather than code. This turns that description into the engine's own objects: a `ComponentType`
 * per component, a `Prefab` per prefab, and a `SystemDefinition` per system.
 *
 * ## A system definition calls through `exports`, and that is what makes it hot-reloadable
 *
 * `runSchedule` caches one `BoundSystem` per world and definition, and calls `definition.run(view)`.
 * A definition holding the generated function *directly* would pin the pre-patch body in the
 * schedule forever — and the symptom is an edit that compiles, reloads, reports success and changes
 * nothing, which is the one failure hot reload exists to prevent.
 *
 * So `run` reaches the function through `module.exports` on every tick. That is one property lookup
 * per system per tick, which is the same bargain `runtime/module.ts` documents at its own
 * declaration and the reason that indirection exists at all.
 *
 * ## A host-declared component is asserted, never created
 *
 * `component Transform from host { … }` says the host registered one and this is its shape. The
 * module creates nothing for it; it is checked when the module binds, and a mismatch is refused
 * naming the field and both types. **The refusal is the whole value of the declaration** — without
 * it the two descriptions drift, and the first thing anybody notices is a field reading zeroes.
 *
 * ## A system's resources are resolved here, once, and `@driftengine/entities` never learns about them
 *
 * `system Walk { uses graph: NavGraph … }` asks to be handed a value this host owns. Without it a
 * handle reaches a script only as a *function* parameter, and every per-entity walk has to be
 * driven from TypeScript. The generated function takes a second parameter: a table keyed by **type
 * name**, so a host supplies "the `NavGraph` this world has" and never learns what any script
 * called its binding.
 *
 * The table is built at registration and captured, rather than assembled per tick. A resource does
 * not change between ticks, and an object per system per tick is the allocation this package refuses
 * everywhere else.
 *
 * **A missing resource is refused at registration, not left as `undefined`.** Passing nothing would
 * reach a capability as an absent argument and produce a wrong *result* rather than an error, which
 * is the trap `host.ts` step four is about. Init is where a person is watching.
 *
 * `SystemDefinition` gains nothing for this. A resource is a host's object, and the ECS has no
 * business knowing one exists — so the table lives in the closure that already reaches through
 * `module.exports`.
 */
import {
  type ComponentType,
  type Prefab,
  type SystemDefinition,
  type SystemView,
  defineComponent,
  definePrefab,
} from '@driftengine/entities';
import type { DriftModule } from 'driftscript';

/** Components a host already registered, by the name a script writes. */
export type ComponentRegistry = Map<string, ComponentType>;

/**
 * Values a host lends to systems, by the **type name** a script writes in a `uses` clause.
 *
 * By type rather than by binding name, which is the language's own rule: a resource is one per type,
 * so two systems asking for a `NavGraph` are handed the same object whatever each file calls it, and
 * a script renaming its binding changes nothing here.
 */
export type ResourceRegistry = ReadonlyMap<string, unknown>;

export interface RegisteredModule {
  /** Component types this module declared, in declaration order. Host-asserted ones are absent. */
  readonly components: readonly ComponentType[];
  readonly prefabs: readonly Prefab[];
  /** Ready for `buildSchedule`, in declaration order. */
  readonly systems: readonly SystemDefinition[];
}

/**
 * Check every `from host` declaration against what the host registered.
 *
 * Throws on the first mismatch rather than collecting: a shape disagreement means the module was
 * compiled against a different world than the one it is being loaded into, and the second error
 * would be a consequence of the first.
 */
export function assertHostShapes(module: DriftModule, registry: ComponentRegistry): void {
  for (const declared of module.info.components ?? []) {
    if (!declared.fromHost) continue;

    const registered = registry.get(declared.name);
    if (registered === undefined) {
      throw new Error(
        `\`${module.info.module}\` declares \`component ${declared.name} from host\`, and this host ` +
          `registered no component of that name. It has ` +
          `${[...registry.keys()].map((k) => `\`${k}\``).join(', ')}. A \`from host\` declaration ` +
          'asserts a shape rather than creating one, so there is nothing to fall back to.',
      );
    }

    const actual = new Map(registered.schema.fields.map((field) => [field.name, field.type]));
    for (const field of declared.schema.fields) {
      const found = actual.get(field.name);
      if (found === undefined) {
        throw new Error(
          `\`${declared.name}.${field.name}\` is declared in \`${module.info.module}\` and the ` +
            `registered component has no such field. It has ` +
            `${[...actual.keys()].map((k) => `\`${k}\``).join(', ')}.`,
        );
      }
      if (found !== field.type) {
        throw new Error(
          `\`${declared.name}.${field.name}\` is \`${field.type}\` in \`${module.info.module}\` and ` +
            `\`${found}\` in the component this host registered. A script reading it would get a ` +
            'value of a type it was not compiled against.',
        );
      }
    }
  }
}

/**
 * Build every component, prefab and system a module declares.
 *
 * Components are registered into `registry` as they are made, so a prefab or a system later in the
 * same module finds them — and so a second module loaded against the same registry shares them
 * rather than making a second store for one name.
 */
export function registerEntityModule(
  module: DriftModule,
  registry: ComponentRegistry,
  resources: ResourceRegistry = new Map(),
): RegisteredModule {
  assertHostShapes(module, registry);

  const components: ComponentType[] = [];
  for (const declared of module.info.components ?? []) {
    /* A host-declared component is already registered; asserting its shape is all this does. */
    if (declared.fromHost) continue;
    const existing = registry.get(declared.name);
    /* A module reloaded keeps the store it already made: replacing the type would orphan every
       entity holding one, which is a world that silently loses its components on an edit. */
    const type = existing ?? defineComponent(declared.schema);
    registry.set(declared.name, type);
    components.push(type);
  }

  const prefabs = (module.info.prefabs ?? []).map((declared) =>
    definePrefab(
      declared.name,
      declared.components.map((component) => {
        const type = registry.get(component.name);
        if (type === undefined) {
          throw new Error(
            `prefab \`${declared.name}\` names the component \`${component.name}\`, which nothing ` +
              'has registered. The compiler refuses this, so a module reaching here was built ' +
              'against a different set of declarations than it is being loaded with.',
          );
        }
        return [type, component.values] as const;
      }),
    ),
  );

  const systems = (module.info.systems ?? []).map((declared): SystemDefinition => {
    const resolve = (names: readonly string[]): ComponentType[] =>
      names.map((name) => {
        const type = registry.get(name);
        if (type === undefined) {
          throw new Error(
            `system \`${declared.name}\` declares \`${name}\`, which nothing has registered.`,
          );
        }
        return type;
      });

    /*
     * Built once and frozen, so a system cannot acquire a resource by writing into the table it was
     * handed — which would be state shared between ticks that nothing declares.
     */
    const lent: Record<string, unknown> = {};
    for (const resource of declared.uses ?? []) {
      if (!resources.has(resource.type)) {
        throw new Error(
          `system \`${declared.name}\` uses \`${resource.name}: ${resource.type}\`, and no ` +
            `\`${resource.type}\` was supplied. Pass one in the third argument to ` +
            '`registerEntityModule`, keyed by the type name. Refused here rather than passed as ' +
            'nothing, because an absent argument reaches a capability as a wrong answer.',
        );
      }
      lent[resource.type] = resources.get(resource.type);
    }
    Object.freeze(lent);

    return {
      name: declared.name,
      reads: resolve(declared.reads),
      writes: resolve(declared.writes),
      after: declared.after,
      everyTicks: declared.everyTicks,
      /*
       * Through `exports` on every tick, never captured here. See the header: a captured function
       * is pinned in the schedule across a hot patch, and the symptom is an edit that reports
       * success and changes nothing.
       */
      run(view: SystemView): void {
        const fn = module.exports[declared.name];
        if (typeof fn !== 'function') {
          throw new Error(
            `\`${declared.name}\` is not exported by \`${module.info.module}\` any more. A disposed ` +
              'module left in a schedule fails here rather than silently doing nothing.',
          );
        }
        /* The second argument is passed whether or not this system asked for anything. A generated
           function without `uses` clauses declares one parameter and ignores it, which is what makes
           the quiet form quiet in the compiler and costs nothing here. */
        (fn as (v: SystemView, r: Record<string, unknown>) => void)(view, lent);
      },
    };
  });

  return { components, prefabs, systems };
}
