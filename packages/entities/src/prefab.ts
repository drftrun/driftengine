/**
 * A prefab is a **value**, and instantiating it writes that value into a fresh entity.
 *
 * **There is no link back**, and that is a decision rather than a limitation. A live link is what an
 * *editor* wants — change the prefab and every instance changes — and it costs every instance a
 * record of which fields it has overridden, checked on every write. Track K is what needs that, and
 * it can add the record without changing what a prefab is.
 *
 * Overrides are applied at instantiation and are not remembered for the same reason: an override
 * that was remembered would be half of that record, doing none of its job.
 */
import type { Entity } from './entity.ts';
import type { ComponentType } from './store.ts';
import type { World } from './world.ts';

export interface Prefab {
  readonly name: string;
  readonly components: readonly (readonly [ComponentType, Readonly<Record<string, unknown>>])[];
}

export function definePrefab(
  name: string,
  components: readonly (readonly [ComponentType, Readonly<Record<string, unknown>>])[],
): Prefab {
  return { name, components };
}

/**
 * Make one.
 *
 * Overrides are keyed by component **name**, because that is what a caller has in front of them —
 * a `ComponentType` key would mean holding the type to override a field of it, which is exactly the
 * import a scene file or an editor panel does not have.
 *
 * An override naming a component the prefab does not carry is **refused**. Adding it instead would
 * make a typo a silent extra component, and adding nothing would make a typo a silent no-op; the
 * only answer that cannot be mistaken for working is to say so.
 */
export function instantiate(
  world: World,
  prefab: Prefab,
  overrides: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): Entity {
  const named = new Set(prefab.components.map(([type]) => type.name));
  for (const name of Object.keys(overrides)) {
    if (named.has(name)) continue;
    throw new Error(
      `\`${prefab.name}\` has no \`${name}\` to override. It has ${[...named].join(', ')}. An ` +
        'override for something absent is a typo either way — added silently, or ignored silently.',
    );
  }

  const entity = world.create();
  for (const [type, values] of prefab.components) {
    const override = overrides[type.name];
    /*
     * **Spread would apply a key whose value is `undefined`, which is not an override.** A caller
     * building one from optional data — `{ hp: config.hp }` where `config.hp` may be absent — means
     * "leave it alone", and a spread means "set it to nothing": the component is then written with
     * `undefined` where a number belongs. Measured elsewhere in this repository as the same shape
     * taking a camera's arm to `NaN` on its first step. Nothing here can see it, because this
     * repository does not run `exactOptionalPropertyTypes`.
     */
    world.add(entity, type, override === undefined ? values : applyOverride(values, override));
  }
  return entity;
}

/** `values` with every *defined* key of `override` applied over it. */
function applyOverride(
  values: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...values };
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
