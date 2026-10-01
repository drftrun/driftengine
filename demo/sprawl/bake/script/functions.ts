/**
 * The functions the scripts call: the `math` module, the generator's two methods, and whatever
 * host functions the caller supplies — each typed as the language declares it, because a
 * function's parameter types are the hint its arguments are computed under.
 *
 * `min` and `max` are the C ternaries rather than `Math.min`, which differs on a signed zero.
 * `clamp` returns its first argument's own type, with the bounds cast to it, as the language's
 * per-type clamp does. The rest are JavaScript's `Math`, which, like the reference's C library,
 * descends from fdlibm; a one-ulp difference would only matter where it flips a `floor`.
 */
import type { NumType } from './numeric.ts';
import { convert, cRound } from './numeric.ts';
import type { Value } from './values.ts';
import { num, numberOf } from './values.ts';

type Unary = (x: number) => number;

const UNARY: ReadonlyMap<string, Unary> = new Map<string, Unary>([
  ['sin', Math.sin],
  ['cos', Math.cos],
  ['tan', Math.tan],
  ['atan', Math.atan],
  ['sqrt', Math.sqrt],
  ['floor', Math.floor],
  ['ceil', Math.ceil],
  ['round', cRound],
  ['abs', Math.abs],
]);

/** The hint each argument of `math.name` is computed under: `f64`, except `clamp`'s value. */
export function mathArgumentHint(name: string, index: number): NumType | null {
  return name === 'clamp' && index === 0 ? null : 'f64';
}

/** The language's `math.PI`, which is the same double as JavaScript's. */
export const MATH_PI = 3.141592653589793;

/** `math.name(args)`; `args` were computed under `mathArgumentHint`. */
export function callMath(name: string, args: readonly Value[]): Value {
  const f64 = (i: number): number => {
    const arg = args[i];
    if (arg === undefined) throw new Error(`math.${name} is missing argument ${i + 1}`);
    return numberOf(arg, `argument ${i + 1} of math.${name}`);
  };
  const unary = UNARY.get(name);
  if (unary !== undefined) return num('f64', unary(f64(0)));
  switch (name) {
    case 'min': {
      const a = f64(0);
      const b = f64(1);
      return num('f64', a < b ? a : b);
    }
    case 'max': {
      const a = f64(0);
      const b = f64(1);
      return num('f64', a > b ? a : b);
    }
    case 'atan2':
      return num('f64', Math.atan2(f64(0), f64(1)));
    case 'clamp': {
      const v = args[0];
      const type = v?.k === 'num' ? v.type : 'f64';
      const x = f64(0);
      const lo = convert(f64(1), type);
      const hi = convert(f64(2), type);
      return num(type, x < lo ? lo : x > hi ? hi : x);
    }
  }
  throw new Error(`math.${name} is not a function this reader knows`);
}

/** The type `math.name` returns, without calling it. */
export function mathReturnType(name: string, first: NumType | null): NumType | null {
  if (name === 'clamp') return first;
  return UNARY.has(name) || name === 'min' || name === 'max' || name === 'atan2' ? 'f64' : null;
}
