/**
 * What shape every claim in `scripts/*-check.mjs` is, counted.
 *
 * **A one-sided claim cannot see a term that is present and wrong by a factor.** That is not a
 * theory: on 2026-09-04 an area-light claim reading "brighter than its control" passed with the
 * specular term multiplied by 0.02, at a contrast of 2.42 against a threshold of 1.2. The band that
 * replaced it fails at 0.02x and at 2x. This counts how much of the repository is still the first
 * shape.
 *
 * It is a census and not a verdict. **One-sided is a suspect list, not a defect list** — such a
 * claim does go red when its term is deleted outright, and what it survives is the factor. Only
 * `claimAudit.sh` decides, by deleting the term and watching.
 *
 *     node scripts/claimCensus.mjs
 *
 * Reads source rather than running anything, so it needs no dev server and no GPU.
 */
import { readFileSync, readdirSync } from 'node:fs';

const dir = 'scripts';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('-check.mjs'))
  .sort();

/** Pull the argument list of every call to `name(` as raw source, bracket-matched. */
function callArgs(source, name) {
  const out = [];
  const needle = name + '(';
  let at = 0;
  while ((at = source.indexOf(needle, at)) !== -1) {
    const before = source[at - 1] ?? ' ';
    if (/[A-Za-z0-9_$.]/.test(before)) {
      at += needle.length;
      continue;
    }
    let depth = 0,
      i = at + needle.length - 1,
      args = [],
      cur = '',
      inStr = null;
    for (; i < source.length; i++) {
      const c = source[i];
      if (inStr) {
        if (c === '\\') {
          cur += c + source[++i];
          continue;
        }
        if (c === inStr) inStr = null;
        cur += c;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        inStr = c;
        cur += c;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        depth++;
        if (depth === 1) {
          continue;
        }
      }
      if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          args.push(cur);
          break;
        }
      }
      if (c === ',' && depth === 1) {
        args.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    out.push(args.map((a) => a.trim().replace(/\s+/g, ' ')));
    at = i;
  }
  return out;
}

function shape(expr) {
  const rel = expr.match(/[<>]=?|===|!==/g) ?? [];
  const hasAnd = /&&/.test(expr);
  const twoSided =
    hasAnd && rel.filter((r) => /^[<>]/.test(r)).length >= 2 && /</.test(expr) && />/.test(expr);
  if (twoSided) return 'band';
  if (/===|!==/.test(expr) && rel.every((r) => /=|!/.test(r))) return 'equality';
  if (rel.some((r) => /^[<>]/.test(r))) return 'one-sided';
  return 'boolean';
}

let totals = {};
for (const f of files) {
  const src = readFileSync(`${dir}/${f}`, 'utf8');
  const calls = [...callArgs(src, 'check'), ...callArgs(src, 'claim')].filter((a) => a.length >= 2);
  const kinds = calls.map((a) => shape(a[1]));
  const tally = {};
  for (const k of kinds) tally[k] = (tally[k] ?? 0) + 1;
  for (const k of kinds) totals[k] = (totals[k] ?? 0) + 1;
  const order = ['band', 'one-sided', 'equality', 'boolean'];
  console.log(
    f.replace('-check.mjs', '').padEnd(18),
    String(calls.length).padStart(3),
    order
      .filter((k) => tally[k])
      .map((k) => `${k} ${tally[k]}`)
      .join(', '),
  );
}
console.log('\ntotal', JSON.stringify(totals));
