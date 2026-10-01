/**
 * An expression's type, answered without evaluating it.
 *
 * A `match` is typed across all its cases — the language folds them into the most expressive
 * type, starting from the one being assigned to — while only one case runs, and a case that draws
 * from the generator must not draw. So its type cannot come from evaluating, and comes from here.
 */
import type { Expr } from './ast.ts';
import { mathReturnType } from './functions.ts';
import { isNumber, operatorTypes } from './numeric.ts';
import type { NumType, Operand, ScalarType } from './numeric.ts';
import type { Ctx } from './names.ts';
import { resolveName } from './names.ts';
import type { MemberType } from './schema.ts';

export const numericHint = (hint: MemberType | null): NumType | null =>
  hint !== null && isNumber(hint) && hint !== 'bool' ? hint : null;

export const literalType = (e: Extract<Expr, { k: 'num' }>): NumType =>
  e.text.includes('.') ? 'f64' : e.negative ? 'i64' : 'u64';

/** A unary minus, which the language parses as a multiplication by this literal. */
export const MINUS_ONE: Expr = { k: 'num', text: '1', negative: true };

export function matchType(
  e: Extract<Expr, { k: 'match' }>,
  ctx: Ctx,
  hint: MemberType | null,
): ScalarType | null {
  let type: ScalarType | null = numericHint(hint);
  for (const c of e.cases) {
    const t = typeOf(c.value, ctx, hint);
    if (type === null) type = t;
    else if (isNumber(type) && t !== null && isNumber(t)) {
      const literal = c.value.k === 'num';
      const value = c.value.k === 'num' ? Number(c.value.text) : 0;
      type = operatorTypes(
        '+',
        { type, literal: false, value: 0 },
        { type: t, literal, value },
        null,
      ).result;
    }
  }
  return type;
}

/** The expression's type, without evaluating it: null where it is not a number or not known. */
export function typeOf(e: Expr, ctx: Ctx, hint: MemberType | null): ScalarType | null {
  switch (e.k) {
    case 'num':
      return literalType(e);
    case 'bool':
      return 'bool';
    case 'str':
      return 'string';
    case 'name': {
      const value = resolveName(e, ctx, false);
      return value.k === 'num' ? value.type : value.k === 'entity' ? 'entity' : null;
    }
    case 'unary':
      return e.op === '!'
        ? 'bool'
        : typeOf({ k: 'binary', op: '*', left: MINUS_ONE, right: e.operand }, ctx, hint);
    case 'binary': {
      if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(e.op)) return 'bool';
      const inner = numericHint(hint);
      const side = (x: Expr): Operand | null => {
        const t = typeOf(x, ctx, inner);
        return t === null
          ? null
          : { type: t, literal: x.k === 'num', value: x.k === 'num' ? Number(x.text) : 1 };
      };
      const l = side(e.left);
      const r = side(e.right);
      return l && r ? operatorTypes(e.op, l, r, inner).result : null;
    }
    case 'call': {
      if (e.callee.k !== 'name') return null;
      const [head, name] = e.callee.path;
      if (head === 'math' && name !== undefined) {
        const first = e.args[0] ? typeOf(e.args[0], ctx, null) : null;
        return mathReturnType(name, first !== null && isNumber(first) ? first : null);
      }
      return name === 'u' ? 'u64' : name === 'f' ? 'f64' : null;
    }
    case 'match':
      return matchType(e, ctx, hint);
    default:
      return null;
  }
}
