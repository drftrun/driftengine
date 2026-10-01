/**
 * The values a script computes, and how one is stored into a declared type.
 *
 * A number carries its type (`numeric.ts` decides how types meet). A composite is either
 * positional or named, as it was written, until a schema turns positional into named. An entity
 * reference is to an entity the reader built, or to nothing (the language's `0`). A name the reader
 * cannot resolve — a constant of an enum declared by the reference's engine, such as a district
 * kind — is a symbol, compared by name.
 */
import type { Stmt } from './ast.ts';
import { convert, isNumber } from './numeric.ts';
import type { NumType } from './numeric.ts';
import type { ScriptRng } from './rng.ts';
import { schemaOf } from './schema.ts';
import type { Member, MemberType } from './schema.ts';
import type { ScriptEntity } from './world.ts';

export type Value =
  | { readonly k: 'num'; readonly type: NumType; readonly v: number }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'entity'; readonly entity: ScriptEntity | null }
  /** An enum constant: `index` for the one enum a script declares, null for the engine's own. */
  | { readonly k: 'symbol'; readonly name: string; readonly index: number | null }
  | {
      readonly k: 'struct';
      /** Named members, or null when written positionally and never given a schema. */
      readonly fields: ReadonlyMap<string, Value> | null;
      readonly items: readonly Value[];
    }
  | { readonly k: 'vector'; readonly items: readonly Value[] }
  | { readonly k: 'pair'; readonly first: Value; readonly second: Value }
  | { readonly k: 'rng'; readonly rng: ScriptRng }
  | { readonly k: 'script'; readonly body: readonly Stmt[] }
  /**
   * State that exists only while the reference runs — a component read off a singleton, a
   * has-query — which the bake cannot know. It propagates through members and operators; a
   * condition on it takes its first branch, so the tree holds the interface as it looks running.
   */
  | { readonly k: 'runtime' };

export const num = (type: NumType, v: number): Value => ({ k: 'num', type, v });
export const bool = (v: boolean): Value => ({ k: 'num', type: 'bool', v: v ? 1 : 0 });
export const named = (fields: ReadonlyMap<string, Value>): Value => ({
  k: 'struct',
  fields,
  items: [],
});

/** A short description for a message: the kind and, for a scalar, the value. */
export function describe(value: Value): string {
  switch (value.k) {
    case 'num':
      return `${value.type} ${value.v}`;
    case 'str':
      return JSON.stringify(value.v);
    case 'entity':
      return value.entity ? `entity ${value.entity.name || '_'}` : 'entity 0';
    case 'symbol':
      return value.name;
    default:
      return value.k;
  }
}

/** The number in a numeric value, or a thrown error naming what it was instead. */
export function numberOf(value: Value, what: string): number {
  if (value.k === 'num') return value.v;
  if (value.k === 'symbol' && value.index !== null) return value.index;
  throw new Error(`${what} is ${describe(value)}, not a number`);
}

/** The zero a member takes when a positional initialiser stops short of it. */
function zero(type: MemberType | null, extra: ReadonlyMap<string, readonly Member[]>): Value {
  if (type === null) return num('f32', 0);
  if (isNumber(type)) return num(type, 0);
  if (type === 'string') return { k: 'str', v: '' };
  if (type === 'entity') return { k: 'entity', entity: null };
  const schema = schemaOf(type, extra);
  if (schema !== null) return coerce({ k: 'struct', fields: null, items: [] }, type, extra);
  return num('f32', 0);
}

/**
 * `value` stored into `type`: a number converted as a C cast does, a composite given its schema's
 * member names and each member stored in turn. A null type is a member the schema table does not
 * know: a float is stored as `f32`, which is what such members almost always are, and anything
 * else is kept as it came.
 */
export function coerce(
  value: Value,
  type: MemberType | null,
  extra: ReadonlyMap<string, readonly Member[]>,
): Value {
  if (type === null) {
    return value.k === 'num' && value.type === 'f64' ? num('f32', convert(value.v, 'f32')) : value;
  }
  if (type === 'any') return value;
  if (isNumber(type)) return num(type, convert(numberOf(value, `a value stored as ${type}`), type));
  if (type === 'string') {
    if (value.k !== 'str') throw new Error(`${describe(value)} stored as a string`);
    return value;
  }
  if (type === 'entity') {
    if (value.k === 'num' && value.v === 0) return { k: 'entity', entity: null };
    return value;
  }
  if (type.endsWith('[]')) {
    if (value.k !== 'vector') throw new Error(`${describe(value)} stored as ${type}`);
    const element = type.slice(0, -2);
    return { k: 'vector', items: value.items.map((item) => coerce(item, element, extra)) };
  }
  const schema = schemaOf(type, extra);
  if (schema === null || value.k !== 'struct') return value;
  const fields = new Map<string, Value>();
  if (value.fields === null) {
    if (value.items.length > schema.length) {
      throw new Error(`${value.items.length} values for ${type}, which has ${schema.length}`);
    }
    schema.forEach((member, i) => {
      const item = value.items[i];
      fields.set(member.name, item ? coerce(item, member.type, extra) : zero(member.type, extra));
    });
    return named(fields);
  }
  for (const member of schema) {
    const given = value.fields.get(member.name);
    fields.set(member.name, given ? coerce(given, member.type, extra) : zero(member.type, extra));
  }
  for (const key of value.fields.keys()) {
    if (!fields.has(key)) throw new Error(`${type} has no member ${key}`);
  }
  return named(fields);
}

/**
 * A named initialiser applied over what an entity already has — its own value, or the one it
 * inherits: the members it names change, the rest keep `base`'s. `update` is already stored into
 * the members' types.
 */
export function merge(base: Value | undefined, update: ReadonlyMap<string, Value>): Value {
  const fields = new Map<string, Value>(base?.k === 'struct' && base.fields ? base.fields : []);
  if (base?.k === 'struct' && base.fields === null && base.items.length > 0) {
    throw new Error('a named initialiser over a positional value with no schema to name it');
  }
  for (const [key, value] of update) fields.set(key, value);
  return named(fields);
}
