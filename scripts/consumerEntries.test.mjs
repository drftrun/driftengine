/**
 * No engine source cites a consumer's report entry by number.
 *
 * **Because those numbers are recycled, and the recycling is by design.** A consumer's engine-gap
 * report deletes a closed entry rather than striking it through, which frees the number for the
 * next one. So a comment here saying "entry E4" is correct on the day it is written and quietly
 * wrong afterwards, pointing a reader at a request that has nothing to do with the code around it.
 *
 * **Twice now, and a consumer caught it both times.** `ragdoll.ts` cited E4 for ragdoll root
 * accessors; by the time anybody read it, E4 was a staging directory on a Windows share.
 * `flat.test.ts` cited E1 for a cutout moving ahead of the lighting branch; E1 today is shadows
 * from an area light. The second was found in the same session that shipped the *new* E4 and
 * introduced a third violation writing the test for it, which is why this gate exists rather than
 * a third correction.
 *
 * **What to write instead**: name the thing. The changelog carries the number, `CHANGELOG.json`
 * carries the reasoning, and git carries both. A comment that says what the code does needs no
 * citation at all.
 *
 * **What it refuses is the *bare* form, and that is the whole rule.** This repository labels plan
 * tasks the same way a consumer labels entries — the parity program has `C1`, `D1`, `E1`, `F2` —
 * so `E1` alone in a comment is ambiguous between a task that is fixed forever and an entry number
 * that will be handed to something else. `Task E1` says which and is allowed. A bare one is not,
 * because the reader cannot tell, and half the time the answer has expired.
 *
 * **What this does not scan.** Nothing is exempt any more. Dated design and plan documents used
 * to be, because a spec written on a day may say which numbers were open on that day: it is a
 * record of a decision rather than an explanation of live code. Those documents are gone, and
 * everything under `packages/*<!---->/src` is the second kind.
 *
 * **What would make it wrong** is a consumer who stops recycling numbers, at which point a
 * citation becomes stable and this gate becomes a style rule instead of a correctness one. Nothing
 * here would notice, so the reason is written down rather than assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');

/**
 * A citation, and deliberately not every `E` followed by a digit.
 *
 * `TEXTURE4`, `E5` in a hex or base64 blob and a variable called `e3` are all legitimate and all
 * match a looser pattern. What is being caught is prose: a word boundary, `E`, one digit, a word
 * boundary, in a sentence that treats it as a name.
 */
const CITATION = /(?<!\bTask )\bE[1-9][0-9]?\b/;

/** Only inside a comment: this is a rule about prose, and code is not prose. */
function comments(source) {
  const out = [];
  const block = /\/\*[\s\S]*?\*\//g;
  const line = /\/\/[^\n]*/g;
  for (const match of source.matchAll(block)) out.push([match.index, match[0]]);
  for (const match of source.matchAll(line)) out.push([match.index, match[0]]);
  return out;
}

function sources(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('no engine source cites a consumer report entry by its number', () => {
  const offenders = [];
  for (const file of sources(PACKAGES)) {
    const source = readFileSync(file, 'utf8');
    for (const [at, text] of comments(source)) {
      const found = text.match(CITATION);
      if (found === null) continue;
      const line = source.slice(0, at).split('\n').length;
      offenders.push(`${path.relative(ROOT, file)}:${line} cites "${found[0]}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a consumer's entry numbers are recycled, so a comment citing one goes stale silently. ` +
      `Name the thing instead and let the changelog carry the number, or write \`Task E<n>\` if ` +
      `it is one of this repository's own plan tasks:\n  ${offenders.join('\n  ')}`,
  );
});
