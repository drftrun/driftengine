/**
 * A world as data: entities, their components, and every value under a **stable field id**.
 *
 * Ids rather than names, so a field renamed with an explicit id still loads; never positions,
 * because a field inserted in the middle would renumber every field after it and a save would load
 * the right names with the wrong values — worse than failing, because it looks like it worked.
 *
 * ---
 *
 * ## Loading across a change goes through `migrate`, unchanged
 *
 * The file carries the **schema each component had when it was written**, so a load has both sides
 * and can hand them to the migration Track N's Phase 5 built. A field added since arrives with its
 * default, one removed is dropped, and one whose *type* changed is refused naming it rather than
 * coerced. Nothing here re-implements any of that; if the migration needs changing, the change
 * belongs in `driftscript` and serves both callers.
 *
 * ## Entity references are remapped, which is why the type has to be declared
 *
 * A saved entity's slot may be live in the world being loaded into, so a scene that kept its
 * handles would overwrite whatever held them. Every entity is created fresh and every stored
 * reference is rewritten through the map — which only works for fields **declared** `Entity`. A
 * number that happens to hold one is a number, and is left alone. That is the cost of not guessing.
 *
 * ## It writes nothing until it can write everything
 *
 * A refusal on the fifth entity must not leave four in the world. Every migration runs first, into
 * plain objects; the world is touched only once all of them have succeeded.
 */
import { type Schema, migrate } from 'driftscript';
import type { Entity } from './entity.ts';
import type { ComponentType } from './store.ts';
import type { World } from './world.ts';

export interface SerializedScene {
  readonly version: 1;
  /** What each component type looked like when this was written. The `from` half of a migration. */
  readonly schemas: Readonly<Record<string, Schema>>;
  readonly entities: readonly {
    /** Component name → field id → value. Entity-typed values hold a scene index, not a handle. */
    readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }[];
}

export type LoadResult =
  | { readonly loaded: true; readonly entities: readonly Entity[] }
  | { readonly loaded: false; readonly reason: string };

/**
 * Write a world out.
 *
 * The component types are passed rather than discovered, because a world holds a store for every
 * type anything has ever asked it about — including empty ones a query created — and a scene is a
 * decision about what to save rather than everything that happens to exist.
 */
export function serializeWorld(world: World, types: readonly ComponentType[]): SerializedScene {
  /* Scene index per entity, so a stored reference is a position in this file rather than a handle
     that means nothing in another world. */
  /*
   * Membership through a `Set`, not `Array.includes`.
   *
   * It was `includes`, which is a linear scan per entity and made this quadratic: **8.8 seconds**
   * for a hundred thousand entities across three components, measured. With a set it is a fraction
   * of that. The shape is worth naming because it reads as obviously correct — the list is the
   * thing being built, so testing it is the natural move — and the cost is invisible until the
   * world is large.
   */
  const indexOf = new Map<Entity, number>();
  const living: Entity[] = [];
  for (const type of types) {
    const store = world.store(type);
    for (let i = 0; i < store.size; i += 1) {
      const entity = store.dense[i] as Entity;
      if (indexOf.has(entity)) continue;
      indexOf.set(entity, living.length);
      living.push(entity);
    }
  }

  const schemas: Record<string, Schema> = {};
  for (const type of types) schemas[type.name] = type.schema;

  const entities = living.map((entity) => {
    const components: Record<string, Record<string, unknown>> = {};
    for (const type of types) {
      if (!world.has(entity, type)) continue;
      const fields: Record<string, unknown> = {};
      for (const field of type.schema.fields) {
        const value = world.read(entity, type, field.name);
        fields[field.id] = field.type === 'Entity' ? (indexOf.get(value as Entity) ?? -1) : value;
      }
      components[type.name] = fields;
    }
    return { components };
  });

  return { version: 1, schemas, entities };
}

/** Read a world in, or refuse in words having written nothing. */
export function deserializeWorld(
  world: World,
  scene: SerializedScene,
  types: readonly ComponentType[],
): LoadResult {
  const byName = new Map(types.map((type) => [type.name, type]));

  /* Everything checked and migrated before the world is touched at all. */
  const planned: { components: { type: ComponentType; values: Record<string, unknown> }[] }[] = [];

  for (const record of scene.entities) {
    const components: { type: ComponentType; values: Record<string, unknown> }[] = [];
    for (const [name, saved] of Object.entries(record.components)) {
      const type = byName.get(name);
      if (type === undefined) {
        return {
          loaded: false,
          reason:
            `this scene holds a \`${name}\`, and no component type by that name was supplied. ` +
            'Loading it as nothing would drop data the file still holds.',
        };
      }
      const from = scene.schemas[name];
      if (from === undefined) {
        return {
          loaded: false,
          reason:
            `this scene holds a \`${name}\` and no schema for it, so there is nothing to match ` +
            'its fields by. A scene written without one cannot be loaded across any change at all.',
        };
      }

      /* `migrate` takes an instance keyed by the *saved* names, so the ids in the file are read
         through the saved schema. That is what keeps the file addressed by id and the migration
         unchanged from the one the language uses. */
      const instance: Record<string, unknown> = {};
      for (const field of from.fields) instance[field.name] = saved[field.id];

      const defaults: Record<string, unknown> = {};
      for (const field of type.schema.fields)
        defaults[field.name] = field.type === 'String' ? null : 0;

      const result = migrate(instance, from, type.schema, defaults);
      if (!result.migrated) return { loaded: false, reason: result.reason };
      components.push({ type, values: result.value });
    }
    planned.push({ components });
  }

  const made = planned.map(() => world.create());
  planned.forEach((record, index) => {
    const entity = made[index] as Entity;
    for (const { type, values } of record.components) {
      /* Scene indices become handles here, and only for fields the schema declares `Entity`. */
      for (const field of type.schema.fields) {
        if (field.type !== 'Entity') continue;
        const at = values[field.name];
        values[field.name] = typeof at === 'number' && at >= 0 && at < made.length ? made[at] : 0;
      }
      world.add(entity, type, values);
    }
  });

  return { loaded: true, entities: made };
}
