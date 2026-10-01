/**
 * Reading the reference's tables out of an evaluated script world: the rows that own a component,
 * and typed access to one row's members.
 *
 * A member the row does not have is an error naming the row and the member, unless the caller
 * gives a fallback: a table the layout reads wrong should fail at the bake, not draw a city with a
 * zero in it.
 */
import type { Value } from '../script/values.ts';
import { effective, pathOf, ScriptWorld } from '../script/world.ts';
import type { ScriptEntity } from '../script/world.ts';

export type Rgba = readonly [number, number, number, number];

/** One row's members, typed on the way out. */
export interface Row {
  readonly entity: ScriptEntity;
  /** A number; booleans read as 0 or 1. */
  n(key: string, fallback?: number): number;
  /** A name: an enum constant, an entity's own name, a string. */
  s(key: string, fallback?: string): string;
  /** A colour, written positionally or by name. */
  c(key: string, fallback?: Rgba): Rgba;
  /** The raw member, for vectors and anything else. */
  v(key: string): Value | undefined;
}

function nameOf(value: Value): string | null {
  if (value.k === 'symbol') return value.name;
  if (value.k === 'entity') return value.entity?.name ?? null;
  if (value.k === 'str') return value.v;
  return null;
}

function colourOf(value: Value): Rgba | null {
  if (value.k !== 'struct') return null;
  const parts = value.fields
    ? ['r', 'g', 'b', 'a'].map((k) => value.fields?.get(k))
    : value.items.slice(0, 4);
  if (parts.length !== 4 || parts.some((p) => p?.k !== 'num')) return null;
  return parts.map((p) => (p?.k === 'num' ? p.v : 0)) as unknown as Rgba;
}

/** `entity`'s value for `component` as a row. */
export function row(entity: ScriptEntity, component: string): Row {
  const value = effective(entity, component);
  if (value?.k !== 'struct' || value.fields === null) {
    throw new Error(`${pathOf(entity)} has no named ${component}`);
  }
  const fields = value.fields;
  const where = (key: string): string => `${pathOf(entity)}.${component}.${key}`;
  return {
    entity,
    n(key, fallback) {
      const v = fields.get(key);
      if (v?.k === 'num') return v.v;
      if (fallback !== undefined) return fallback;
      throw new Error(`${where(key)} is not a number`);
    },
    s(key, fallback) {
      const v = fields.get(key);
      const name = v ? nameOf(v) : null;
      if (name !== null) return name;
      if (fallback !== undefined) return fallback;
      throw new Error(`${where(key)} is not a name`);
    },
    c(key, fallback) {
      const v = fields.get(key);
      const colour = v ? colourOf(v) : null;
      if (colour !== null) return colour;
      if (fallback !== undefined) return fallback;
      throw new Error(`${where(key)} is not a colour`);
    },
    v: (key) => fields.get(key),
  };
}

/** Every entity that owns `component`, prefabs excluded, as rows, in declaration order. */
export function rows(world: ScriptWorld, component: string): Row[] {
  return world
    .query(component)
    .filter((e) => !e.prefab)
    .map((e) => row(e, component));
}

/** The second member of every `(first, X)` pair on `entity`, by name. */
export function pairTargets(entity: ScriptEntity, first: string): string[] {
  const out: string[] = [];
  for (const pair of entity.pairs) {
    const a = nameOf(pair.first);
    const b = nameOf(pair.second);
    if (a === first && b !== null) out.push(b);
  }
  return out;
}

/** The city-wide constants every `cfg { export const … }` block declares, as numbers. */
export function constants(world: ScriptWorld): ReadonlyMap<string, number> {
  const cfg = ScriptWorld.walk(world.root, ['cfg']);
  if (cfg === null) throw new Error('the scripts declare no cfg block');
  const out = new Map<string, number>();
  for (const [key, value] of cfg.exports) if (value.k === 'num') out.set(key, value.v);
  return out;
}
