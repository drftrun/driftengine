/**
 * Every kind in the changelog is one a renderer knows.
 *
 * **A kind the renderer does not know is silently dropped**, and that is not hypothetical: engine
 * 3.9.0 shipped a `note` entry — a written refusal, which this project treats as a deliverable —
 * and it appeared in no release note anywhere. `scripts/changelog.mjs` skipped it because it maps
 * over a fixed list, the shared `release-notes` component skipped it because it filters against
 * one, and the only thing that said anything was a *consumer's* test failing on a word it
 * had never heard of. Whoever found that had no context for why.
 *
 * So the check runs here, against the file the kinds are written in, and names the kind and the
 * release rather than leaving somebody to grep four repositories for a list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The kinds a renderer knows, read out of the renderer rather than repeated here.
 *
 * Repeating them would make this a fourth copy of the list and a test that passes while the
 * renderer is wrong — which is the whole failure it exists to catch, one level up.
 */
function renderableKinds() {
  const source = readFileSync(path.join(ROOT, 'scripts/changelog.mjs'), 'utf8');
  const block = /const KINDS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(block, 'scripts/changelog.mjs must declare a `KINDS` list');
  return new Set([...block[1].matchAll(/\['(\w+)',/g)].map((m) => m[1]));
}

test('every changelog kind is one the release-notes renderer knows', () => {
  const known = renderableKinds();
  assert.ok(known.size > 0, 'no kinds were read out of the renderer');

  const releases = JSON.parse(
    readFileSync(path.join(ROOT, 'packages/core/CHANGELOG.json'), 'utf8'),
  );
  const unknown = [];
  for (const release of releases) {
    for (const entry of release.entries) {
      if (!known.has(entry.kind)) unknown.push(`${release.version}: \`${entry.kind}\``);
    }
  }

  assert.deepEqual(
    unknown,
    [],
    `changelog kinds no renderer knows, so these entries appear nowhere:\n  ${unknown.join('\n  ')}\n` +
      `known: ${[...known].join(', ')}. Teach scripts/changelog.mjs, the design system's ` +
      "release-notes component, and a consumer's version test — all four hold the list.",
  );
});
