/**
 * Calls to arithmetic that JavaScript engines are not obliged to round identically.
 *
 * `+ - * /` are IEEE-754 double operations by specification and JavaScript permits no
 * fused-multiply-add contraction, so each rounds individually on every engine. `Math.sqrt` is
 * required correctly rounded by IEEE-754 and is *not* among the functions ECMAScript declines to
 * specify. Everything in `NOT_SPECIFIED` is on that list, and two engines may differ by an ulp.
 *
 * **This is a gate rather than a paragraph because the paragraph already existed and was false.**
 * `hullShape`'s header claimed the same input yields the same features in the same order on every
 * machine while ten `Math.hypot` calls sat under it — two of them deciding whether a plane becomes
 * a face and how many separating axes exist — and nothing in the suite could see it.
 *
 * **What this gives up:** a legitimate build-time use has to carry a marker and a reason, and the
 * comment stripper is naive enough to mangle a `//` inside a string literal — the same limitation
 * `boundaries.test.mjs` lives with, and for the same reason: no file it scans contains one.
 * **What would make it wrong** is a value computed here that provably never reaches a tick, which
 * is what the marker is for.
 */

/** Exactly the functions ECMAScript declines to specify precisely, plus `random`. */
export const NOT_SPECIFIED = [
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atanh',
  'atan2',
  'cbrt',
  'cos',
  'cosh',
  'exp',
  'expm1',
  'hypot',
  'log',
  'log1p',
  'log2',
  'log10',
  'pow',
  'random',
  'sin',
  'sinh',
  'tan',
  'tanh',
];

const CALL = new RegExp(String.raw`\bMath\.(${NOT_SPECIFIED.join('|')})\s*\(`);

/**
 * `a ** b`, which is `Math.pow` wearing punctuation.
 *
 * **Added 2026-09-03, and it found one in the package this gate was written for.**
 * `joints.ts` computed a squared length as `(p[j * 6] ?? 0) ** 2 + ...` inside the collision
 * kernel, under a header asserting the kernel's arithmetic is reproducible, and the gate could not
 * see it because it looked for the spelling rather than for the operation. `Number::exponentiate`
 * is implementation-approximated in exactly the way `Math.pow` is, and an integer exponent does not
 * rescue it: whether an engine special-cases `x ** 2` into `x * x` is a choice each engine makes.
 *
 * `**=` is caught too. `x *= x` is what a caller wanted anyway.
 */
const EXPONENT = /(?<![*/])\*\*(?!\*)/;

/** The escape hatch, which must carry a reason after the dash. */
const MARKER = /\/\/\s*determinism: build-time —\s*\S/;

/**
 * Blank out comments **and string literals** while preserving every line and column.
 *
 * **The strings are why this changed.** The old version stripped comments only, and said so:
 * *"the comment stripper is naive enough to mangle a `//` inside a string literal ... no file it
 * scans contains one."* Widening the scope to `packages/script/src` made that false twice over —
 * capability descriptions are prose in string literals, and prose contains `**bold**`, which the
 * exponent check above would read as arithmetic. One alternation in a single pass fixes both: a
 * `//` inside a string is consumed as part of the string rather than starting a comment.
 *
 * **What it gives up** is arithmetic inside a template literal's `${...}`, which is blanked with
 * the template. Nothing in the simulation set builds a string out of a transcendental, and a
 * consumer who did would be building a string rather than a simulation.
 */
function withoutCommentsOrStrings(source) {
  const tokens =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  return source.replace(tokens, (match) => match.replace(/[^\n]/g, ' '));
}

/** Every unexempted call, as `{ line, fn }`, one-based. */
export function violations(source) {
  const raw = source.split('\n');
  const code = withoutCommentsOrStrings(source).split('\n');
  const found = [];
  for (let i = 0; i < code.length; i++) {
    const line = code[i] ?? '';
    const exempt = i > 0 && MARKER.test(raw[i - 1] ?? '');
    if (exempt) continue;
    const match = CALL.exec(line);
    if (match) {
      found.push({ line: i + 1, fn: match[1] });
      continue;
    }
    if (EXPONENT.test(line)) found.push({ line: i + 1, fn: 'pow' });
  }
  return found;
}
