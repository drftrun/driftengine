/**
 * Evaluating an expression: a value, typed as the language would type it, under the hint of the
 * type it is being assigned to (`numeric.ts` has the rules, `names.ts` what a name means,
 * `typeOf.ts` the types of what is not evaluated).
 */
import type { Expr } from './ast.ts';
import { callMath, mathArgumentHint } from './functions.ts';
import { lookup, member, resolveName, RUNTIME } from './names.ts';
import type { Ctx } from './names.ts';
import { arithmetic, compare, convert, isNumber, operatorTypes } from './numeric.ts';
import type { NumType, Operand } from './numeric.ts';
import { memberType, schemaOf } from './schema.ts';
import type { MemberType } from './schema.ts';
import { literalType, matchType, MINUS_ONE, numericHint } from './typeOf.ts';
import type { Value } from './values.ts';
import { bool, describe, num, numberOf } from './values.ts';
import { effective } from './world.ts';

function operand(e: Expr, value: Value): Operand {
  const literal = e.k === 'num' || e.k === 'bool';
  if (value.k === 'num') return { type: value.type, literal, value: value.v };
  if (value.k === 'entity') return { type: 'entity', literal, value: value.entity?.id ?? 0 };
  if (value.k === 'str') return { type: 'string', literal, value: 0 };
  throw new Error(`${describe(value)} in arithmetic`);
}

/** Two values the language compares by identity rather than by number: symbols, entities, strings. */
function sameThing(a: Value, b: Value): boolean | null {
  if (a.k === 'symbol' || b.k === 'symbol') {
    if (a.k === 'symbol' && b.k === 'symbol') return a.name === b.name;
    const index = a.k === 'symbol' ? a.index : b.k === 'symbol' ? b.index : null;
    const other = a.k === 'symbol' ? b : a;
    return index !== null && other.k === 'num' ? other.v === index : false;
  }
  if (a.k === 'entity' && b.k === 'entity') return a.entity === b.entity;
  if (a.k === 'str' && b.k === 'str') return a.v === b.v;
  return null;
}

function binary(e: Extract<Expr, { k: 'binary' }>, ctx: Ctx, hint: MemberType | null): Value {
  const inner = hint === 'bool' ? null : hint;
  const left = evaluate(e.left, ctx, inner);
  if (e.op === '&&' || e.op === '||') {
    if (left.k === 'runtime') {
      evaluate(e.right, ctx, inner);
      return left;
    }
    const l = numberOf(left, `the left side of ${e.op}`) !== 0;
    if (l === (e.op === '||')) return bool(l);
    const r = evaluate(e.right, ctx, inner);
    return r.k === 'runtime' ? r : bool(numberOf(r, `the right side of ${e.op}`) !== 0);
  }
  const right = evaluate(e.right, ctx, inner);
  if (left.k === 'runtime' || right.k === 'runtime') return RUNTIME;
  if (e.op === '==' || e.op === '!=') {
    const same = sameThing(left, right);
    if (same !== null) return bool(same === (e.op === '=='));
  }
  const types = operatorTypes(
    e.op,
    operand(e.left, left),
    operand(e.right, right),
    numericHint(inner),
  );
  const l = operand(e.left, left).value;
  const r = operand(e.right, right).value;
  if (!isNumber(types.operand)) {
    if (types.result !== 'bool') throw new Error(`${e.op} on ${types.operand}`);
    return bool(compare(e.op, l, r));
  }
  const lv = convert(l, types.operand);
  const rv = convert(r, types.operand);
  if (types.result === 'bool') return bool(compare(e.op, lv, rv));
  return num(types.result as NumType, arithmetic(e.op, lv, rv, types.operand));
}

function call(e: Extract<Expr, { k: 'call' }>, ctx: Ctx): Value {
  if (e.callee.k !== 'name') throw new Error('a call to something that is not a name');
  const path = e.callee.path;
  if (path[0] === 'math' && path.length === 2) {
    const name = path[1] as string;
    return callMath(
      name,
      e.args.map((arg, i) => evaluate(arg, ctx, mathArgumentHint(name, i))),
    );
  }
  const rng = path.length === 2 ? lookup(ctx.scope, path[0] as string) : undefined;
  if (rng?.k === 'rng') {
    const arg = e.args[0];
    if (arg === undefined) throw new Error(`${path.join('.')}() takes a bound`);
    if (path[1] === 'u') {
      const max = convert(numberOf(evaluate(arg, ctx, 'u64'), 'the bound'), 'u64');
      return num('u64', Number(rng.rng.u(BigInt(max))));
    }
    if (path[1] === 'f') {
      return num('f64', rng.rng.f(numberOf(evaluate(arg, ctx, 'f64'), 'the bound')));
    }
  }
  const host = ctx.options.hosts.get(path.join('.'));
  if (host === undefined) throw new Error(`no function ${path.join('.')}`);
  return host(e.args.map((arg) => evaluate(arg, ctx, 'f64')));
}

function matchValue(e: Extract<Expr, { k: 'match' }>, ctx: Ctx, hint: MemberType | null): Value {
  let subject = evaluate(e.subject, ctx, null);
  if (subject.k === 'runtime') {
    /* A subject only the running reference knows is taken at rest, as if it were zero (`false`,
       `0`), falling to the default case where no case names that. */
    ctx.world.notices.push(`${ctx.unit.file}: a match on run-time state is taken at rest`);
    subject = bool(false);
  }
  let chosen: Expr | null = null;
  for (const c of e.cases) {
    if (c.label === null) {
      chosen = c.value;
      break;
    }
    const label = evaluate(c.label, ctx, null);
    const same = sameThing(subject, label);
    const equal =
      same ??
      (subject.k === 'num' && label.k === 'num' && subject.v === convert(label.v, subject.type));
    if (equal) {
      chosen = c.value;
      break;
    }
  }
  if (chosen === null) throw new Error(`no case of the match takes ${describe(subject)}`);
  const value = evaluate(chosen, ctx, hint);
  const type = matchType(e, ctx, hint);
  return value.k === 'num' && isNumber(type) ? num(type, convert(value.v, type)) : value;
}

/** `e`'s value under `hint`, the type it is being assigned to. */
export function evaluate(e: Expr, ctx: Ctx, hint: MemberType | null): Value {
  switch (e.k) {
    case 'num': {
      const type = literalType(e);
      const v = Number(e.text);
      return num(type, e.negative ? -v : v);
    }
    case 'bool':
      return bool(e.value);
    case 'str':
      return { k: 'str', v: e.value };
    case 'name':
      return resolveName(e, ctx, true);
    case 'unary':
      if (e.op === '!') {
        const operand = evaluate(e.operand, ctx, null);
        return operand.k === 'runtime'
          ? operand
          : bool(numberOf(operand, 'the operand of !') === 0);
      }
      return binary({ k: 'binary', op: '*', left: MINUS_ONE, right: e.operand }, ctx, hint);
    case 'binary':
      return binary(e, ctx, hint);
    case 'member':
      return member(evaluate(e.target, ctx, null), [e.name]);
    case 'index': {
      const target = evaluate(e.target, ctx, null);
      if (target.k === 'vector') {
        const i = convert(numberOf(evaluate(e.index, ctx, null), 'an index'), 'i32');
        const item = target.items[i];
        if (item === undefined)
          throw new Error(`index ${i} past a vector of ${target.items.length}`);
        return item;
      }
      if (target.k === 'entity' && target.entity !== null && e.index.k === 'name') {
        const component = e.index.path.join('.');
        const found = effective(target.entity, component);
        if (found !== undefined) return found;
        ctx.world.notices.push(`${ctx.unit.file}: ${component} is read from an entity at run time`);
        return RUNTIME;
      }
      if (target.k === 'symbol' || target.k === 'runtime') {
        /* A singleton component read off itself (`State[State]`), which only a running host has. */
        ctx.world.notices.push(`${ctx.unit.file}: ${describe(target)} is read at run time`);
        return RUNTIME;
      }
      throw new Error(`${describe(target)} cannot be indexed`);
    }
    case 'call':
      return call(e, ctx);
    case 'init': {
      const schema = hint !== null ? schemaOf(hint, ctx.world.schemas) : null;
      if (e.named !== null) {
        const fields = new Map<string, Value>();
        for (const m of e.named) {
          fields.set(
            m.key,
            evaluate(m.value, ctx, memberType(schema, m.key) ?? (schema ? null : 'f32')),
          );
        }
        return { k: 'struct', fields, items: [] };
      }
      return {
        k: 'struct',
        fields: null,
        items: e.items.map((item, i) => evaluate(item, ctx, schema?.[i]?.type ?? 'f32')),
      };
    }
    case 'vector': {
      const element = hint?.endsWith('[]') ? hint.slice(0, -2) : null;
      return { k: 'vector', items: e.items.map((item) => evaluate(item, ctx, element)) };
    }
    case 'pair':
      return {
        k: 'pair',
        first: evaluate(e.first, ctx, null),
        second: evaluate(e.second, ctx, null),
      };
    case 'match':
      return matchValue(e, ctx, hint);
    case 'has':
      ctx.world.notices.push(`${ctx.unit.file}: a has-query is answered at run time`);
      return RUNTIME;
    case 'script':
      return { k: 'script', body: e.body };
    case 'range':
      throw new Error('a range outside a for');
  }
}
