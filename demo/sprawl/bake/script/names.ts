/**
 * What a name in an expression means, and the context every evaluation runs in.
 *
 * **A name means the first of these that exists**: a variable (a prop, a const, a loop variable,
 * or a global — an `export` at a file's top level), then `math.PI` and `platform.mobile`, then a
 * constant of an enum a script declared, then an entity by path — whose remaining steps name an
 * `export const` (`cfg.cityScale`) — then a template. What is none of these is taken as a constant
 * of an enum the reference's engine declares (`DistrictDowntown`): a symbol, counted, so the report
 * can list every one.
 */
import type { Expr } from './ast.ts';
import { MATH_PI } from './functions.ts';
import type { Value } from './values.ts';
import { bool, describe, num } from './values.ts';
import type { Scope, ScriptEntity, ScriptWorld, Unit } from './world.ts';

export interface EvalOptions {
  /** `platform.mobile`, which the quality layer matches on. */
  readonly mobile: boolean;
  /** Functions the reference's host registers, by dotted name. */
  readonly hosts: ReadonlyMap<string, (args: readonly Value[]) => Value>;
}

export interface Ctx {
  readonly world: ScriptWorld;
  readonly unit: Unit;
  readonly scope: Scope;
  /** The entity whose block is running: `$this`. */
  readonly self: ScriptEntity;
  readonly options: EvalOptions;
}

export function lookup(scope: Scope | null, name: string): Value | undefined {
  for (let at = scope; at !== null; at = at.parent) {
    const found = at.vars.get(name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** State only the running reference has; see `Value`. */
export const RUNTIME: Value = { k: 'runtime' };

/** `value`'s members along `path`; run-time state stays run-time state. */
export function member(value: Value, path: readonly string[]): Value {
  let at = value;
  for (const step of path) {
    if (at.k === 'runtime') return at;
    const next = at.k === 'struct' ? at.fields?.get(step) : undefined;
    if (next === undefined) throw new Error(`${describe(at)} has no member ${step}`);
    at = next;
  }
  return at;
}

/** A name, as the header describes; `count` is false where only its type is wanted. */
export function resolveName(e: Extract<Expr, { k: 'name' }>, ctx: Ctx, count: boolean): Value {
  const [head, ...rest] = e.path as [string, ...string[]];
  if (e.dollar && head === 'this') return member({ k: 'entity', entity: ctx.self }, rest);
  const variable = lookup(ctx.scope, head) ?? ctx.world.root.exports.get(head);
  if (variable !== undefined) return member(variable, rest);
  if (e.dollar) throw new Error(`no variable named ${head}`);
  if (head === 'math' && rest[0] === 'PI' && rest.length === 1) return num('f64', MATH_PI);
  if (head === 'platform' && rest[0] === 'mobile') return bool(ctx.options.mobile);
  for (const [, constants] of ctx.world.enums) {
    const index = constants.indexOf(e.path[e.path.length - 1] as string);
    if (index >= 0 && e.path.length <= 2)
      return { k: 'symbol', name: constants[index] as string, index };
  }
  for (let n = e.path.length; n >= 1; n -= 1) {
    const entity = ctx.world.resolve(e.path.slice(0, n), ctx.unit, ctx.self);
    if (entity === null) continue;
    if (n === e.path.length) return { k: 'entity', entity };
    const exported = entity.exports.get(e.path[n] as string);
    if (exported !== undefined) return member(exported, e.path.slice(n + 1));
    /* A template by its full path (`module.Name`): templates are not entities here. */
    const last = e.path[n] as string;
    if (n === e.path.length - 1 && ctx.world.templates.has(last)) {
      return { k: 'symbol', name: last, index: null };
    }
    throw new Error(`${e.path.slice(0, n + 1).join('.')} is not exported`);
  }
  const name = e.path.join('.');
  if (count && !ctx.world.templates.has(name)) {
    ctx.world.symbols.set(name, (ctx.world.symbols.get(name) ?? 0) + 1);
  }
  return { k: 'symbol', name, index: null };
}
