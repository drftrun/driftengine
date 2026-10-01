/**
 * Numbers as the script language types and computes them: which type a binary operation runs in,
 * how a value converts between types, and the arithmetic itself.
 *
 * Ported from the language's own type checker (`expr/visit_type.c`) and value arithmetic
 * (`expr/util.c`), because the reference's world depends on it in ways a plain `f64` evaluation
 * would not reproduce:
 *
 * - **The type being assigned to is a hint.** A decimal literal narrows to `f32` under an `f32`
 *   hint, and an operand that converts to the hint without loss is cast to it — so two `f32`
 *   operands compute in `f32`, rounding after every operation.
 * - **An integer literal is `u64` (or `i64` when negative) and narrows to the smallest type that
 *   holds it**, which decides whether `i * 17` stays `i32` and wraps.
 * - **`/` is float, in `f32` when its left side is and `f64` otherwise; `%` is `i64`.**
 * - Two operands of different types meet at the more expressive one when the other converts to it
 *   without loss; otherwise at `f64` if either is a float, else `i64`.
 *
 * What it gives up: `i64` and `u64` live in JavaScript numbers, exact to 2⁵³. A result past that
 * throws rather than rounding silently; the corpus's integers are seeds and counts in the
 * thousands.
 */

export type NumType =
  'bool' | 'u8' | 'u16' | 'u32' | 'u64' | 'i8' | 'i16' | 'i32' | 'i64' | 'f32' | 'f64';

/** A scalar's static type: a number, or an entity or string, which compare but do not compute. */
export type ScalarType = NumType | 'entity' | 'string';

interface Info {
  readonly expressiveness: number;
  readonly storage: number;
  readonly integer: boolean;
  readonly signed: boolean;
  readonly float: boolean;
}

/** `flecs_expr_type_info`'s table: expressiveness, then the storage rank. */
const INFO: Record<NumType, Info> = {
  bool: { expressiveness: 1, storage: 1, integer: false, signed: true, float: false },
  u8: { expressiveness: 2, storage: 2, integer: true, signed: false, float: false },
  u16: { expressiveness: 3, storage: 3, integer: true, signed: false, float: false },
  u32: { expressiveness: 4, storage: 4, integer: true, signed: false, float: false },
  u64: { expressiveness: 6, storage: 7, integer: true, signed: false, float: false },
  i8: { expressiveness: 7, storage: 1, integer: true, signed: true, float: false },
  i16: { expressiveness: 8, storage: 2, integer: true, signed: true, float: false },
  i32: { expressiveness: 9, storage: 3, integer: true, signed: true, float: false },
  i64: { expressiveness: 11, storage: 6, integer: true, signed: true, float: false },
  f32: { expressiveness: 12, storage: 3, integer: false, signed: true, float: true },
  f64: { expressiveness: 13, storage: 4, integer: false, signed: true, float: true },
};

export const isNumber = (type: string | null): type is NumType => type !== null && type in INFO;
export const isFloat = (type: string | null): boolean => type === 'f32' || type === 'f64';

/** One side of a binary operation, as the type checker sees it. */
export interface Operand {
  readonly type: ScalarType;
  /** Whether it is a literal in the source, which may narrow. */
  readonly literal: boolean;
  readonly value: number;
}

const expressiveness = (type: ScalarType | null): number =>
  isNumber(type) ? INFO[type].expressiveness : 0;

/** Whether `from` converts to `to` without losing precision. */
function lossless(from: ScalarType, to: ScalarType | null): boolean {
  if (!isNumber(from) || !isNumber(to)) return false;
  if (INFO[to].expressiveness < INFO[from].expressiveness) return false;
  return INFO[to].storage >= INFO[from].storage;
}

const toHint = (hint: ScalarType | null, type: ScalarType): ScalarType =>
  lossless(type, hint) ? (hint as ScalarType) : type;

/** A literal's smallest type: floats narrow only toward an `f32` hint. */
function narrow(hint: ScalarType | null, operand: Operand): ScalarType {
  if (!operand.literal || !isNumber(operand.type)) return operand.type;
  const info = INFO[operand.type];
  if (info.float) return hint === 'f32' ? 'f32' : operand.type;
  if (!info.integer) return operand.type;
  const v = operand.value;
  if (info.signed) {
    if (v >= -128 && v <= 127) return 'i8';
    if (v >= -32768 && v <= 32767) return 'i16';
    if (v >= -2147483648 && v <= 2147483647) return 'i32';
    return 'i64';
  }
  if (v <= 255) return 'u8';
  if (v <= 65535) return 'u16';
  if (v <= 4294967295) return 'u32';
  return 'u64';
}

const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const COMPARISON = new Set(['==', '!=', '<', '>', '<=', '>=']);

/**
 * The type both operands are cast to, and the type of the result: `flecs_expr_type_for_operator`.
 * Throws where the language refuses the expression.
 */
export function operatorTypes(
  op: string,
  left: Operand,
  right: Operand,
  hint: ScalarType | null,
): { operand: ScalarType; result: ScalarType } {
  if ((op === '/' || op === '%') && right.literal && right.value === 0) {
    throw new Error('division by zero');
  }
  if (op === '/') {
    const type = isFloat(left.type) ? left.type : 'f64';
    return { operand: type, result: type };
  }
  if (op === '%') return { operand: 'i64', result: 'i64' };
  if (op === '&&' || op === '||') return { operand: 'bool', result: 'bool' };
  const result: ScalarType | null = COMPARISON.has(op) ? 'bool' : null;
  const done = (operand: ScalarType): { operand: ScalarType; result: ScalarType } => {
    let type = operand;
    if (op === '-' && type === 'u64') type = 'i64';
    if (type === 'bool' && ARITHMETIC.has(op)) type = 'i32';
    return { operand: type, result: result ?? type };
  };
  if (left.type === 'entity' || right.type === 'entity') return done('entity');
  if (left.type === right.type) {
    if ((op === '==' || op === '!=') && isFloat(left.type) && left.literal && right.literal) {
      throw new Error('a floating point literal compared for equality with another');
    }
    return done(left.type);
  }
  const l = toHint(hint, narrow(hint, left));
  const r = toHint(hint, narrow(hint, right));
  if (l === r) return done(l);
  if (op === '==' || op === '!=') {
    if (l === 'bool' || r === 'bool') return done('bool');
    if (isFloat(l) || isFloat(r)) {
      if (left.literal && right.literal) {
        throw new Error('a floating point literal compared for equality with another');
      }
      if (isFloat(l) && right.literal) return done(l);
      if (isFloat(r) && left.literal) return done(r);
    }
  }
  if (expressiveness(l) >= expressiveness(r)) {
    if (lossless(r, l)) return done(l);
  } else if (lossless(l, r)) {
    return done(r);
  }
  if (isNumber(l) && isNumber(r)) {
    if (isFloat(l) || isFloat(r)) return done('f64');
    if (INFO[l].signed && INFO[l].integer) return done('i64');
    if (INFO[r].signed && INFO[r].integer) return done('i64');
  }
  throw new Error(`incompatible types in an expression (${l} and ${r})`);
}

function wrap(v: number, bits: number, signed: boolean): number {
  const size = 2 ** bits;
  let out = ((v % size) + size) % size;
  if (signed && out >= size / 2) out -= size;
  return out;
}

function exact(v: number, type: string): number {
  if (!Number.isSafeInteger(v)) throw new Error(`${type} value ${v} is past 2^53`);
  return v;
}

/** `value` converted to `to` as a C cast does: truncation toward zero, and a wrap to the width. */
export function convert(value: number, to: NumType): number {
  switch (to) {
    case 'f64':
      return value;
    case 'f32':
      return Math.fround(value);
    case 'bool':
      return value !== 0 ? 1 : 0;
    case 'i64':
      return exact(Math.trunc(value), to);
    case 'u64': {
      const v = exact(Math.trunc(value), to);
      if (v < 0) throw new Error(`u64 value ${v} is negative`);
      return v;
    }
    case 'i32':
      return Math.trunc(value) | 0;
    case 'u32':
      return Math.trunc(value) >>> 0;
    case 'i16':
      return wrap(Math.trunc(value), 16, true);
    case 'u16':
      return wrap(Math.trunc(value), 16, false);
    case 'i8':
      return wrap(Math.trunc(value), 8, true);
    case 'u8':
      return wrap(Math.trunc(value), 8, false);
  }
}

/** `l op r` computed in `type`, both operands already converted to it. */
export function arithmetic(op: string, l: number, r: number, type: NumType): number {
  if ((op === '/' || op === '%') && r === 0) throw new Error('division by zero');
  if (type === 'i32') {
    if (op === '+') return (l + r) | 0;
    if (op === '-') return (l - r) | 0;
    if (op === '*') return Math.imul(l, r);
  }
  let v: number;
  switch (op) {
    case '+':
      v = l + r;
      break;
    case '-':
      v = l - r;
      break;
    case '*':
      v = l * r;
      break;
    case '/':
      v = l / r;
      break;
    case '%':
      v = l % r;
      break;
    default:
      throw new Error(`the operator ${op} is not arithmetic`);
  }
  return convert(v, type);
}

export function compare(op: string, l: number, r: number): boolean {
  switch (op) {
    case '==':
      return l === r;
    case '!=':
      return l !== r;
    case '<':
      return l < r;
    case '>':
      return l > r;
    case '<=':
      return l <= r;
    case '>=':
      return l >= r;
  }
  throw new Error(`the operator ${op} is not a comparison`);
}

/** C's `round`: halves away from zero, where `Math.round` takes them toward positive infinity. */
export function cRound(x: number): number {
  const whole = Math.trunc(x);
  return Math.abs(x - whole) >= 0.5 ? whole + Math.sign(x) : whole;
}
