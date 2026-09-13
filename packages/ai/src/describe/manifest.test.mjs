/**
 * The development manifest and the capability map name the same refusals.
 *
 * Two descriptions of one thing will drift, and this is the pair that would. The
 * sentinel in `docs/CAPABILITIES.md` catches the *symbol* arriving; nothing catches the
 * manifest going on saying a surface is refused after the row that refused it has been
 * corrected, which is the same failure with the documents swapped.
 *
 * `node:test` rather than vitest because the workspace tsconfig gives package tests no
 * node types, so reading a file from a `.ts` test does not typecheck.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

function sentinelNames() {
  const doc = readFileSync(path.join(ROOT, 'docs', 'CAPABILITIES.md'), 'utf8');
  const block = /```sentinels\n([\s\S]*?)```/.exec(doc);
  assert.ok(block, 'CAPABILITIES.md must carry a ```sentinels block');
  return block[1]
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * The ids a `REFUSED` list names, from source text.
 *
 * Takes the source rather than reading it, so the extraction can be pointed at a sample. That
 * became necessary on 2026-09-05 when the real list emptied: `[]` from a working parser and `[]`
 * from a broken one are the same value, and the test below exists to tell them apart.
 */
function refusalIdsIn(source) {
  const block = /const REFUSED[^=]*=\s*\[[\s\S]*?\];/.exec(source);
  assert.ok(block, 'manifest.ts must carry a REFUSED list');
  return [...block[0].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
}

function manifestSource() {
  return readFileSync(path.join(import.meta.dirname, 'manifest.ts'), 'utf8');
}

function manifestRefusalIds() {
  return refusalIdsIn(manifestSource());
}

test('every refusal the manifest names is a sentinel the capability map carries', () => {
  const sentinels = new Set(sentinelNames());
  const unbacked = manifestRefusalIds().filter((id) => !sentinels.has(id));

  assert.deepEqual(
    unbacked,
    [],
    `the manifest refuses what CAPABILITIES.md does not:\n  ${unbacked.join('\n  ')}`,
  );
});

test('every AI sentinel the capability map carries is named by the manifest', () => {
  const named = new Set(manifestRefusalIds());
  const missing = sentinelNames()
    .filter((name) => name.startsWith('ai-'))
    .filter((name) => !named.has(name));

  /* The direction that catches the *end* of a refusal: a sentinel added for a third
     bridge, with the manifest left saying nothing about it. */
  assert.deepEqual(
    missing,
    [],
    `CAPABILITIES.md refuses what the manifest does not name:\n  ${missing.join('\n  ')}`,
  );
});

/**
 * **The list is empty, so this is the test that stops the other two being decorative.**
 *
 * Both directions above compare two sets, and both are satisfied by an extraction that returns
 * nothing at all. That was covered by asserting the real list held exactly two ids — until
 * 2026-09-05, when both bridges shipped and the list legitimately emptied. Asserting emptiness in
 * its place would have been asserting the failure.
 *
 * So the extraction is watched producing a value from a sample instead. A parser that works on this
 * and returns `[]` for the real file is telling the truth about the real file.
 */
test('the extraction finds ids where there are ids, so an empty answer means an empty list', () => {
  const sample = `const REFUSED: readonly { id: string; waitsOn: string }[] = [
  { id: 'sample-one', waitsOn: 'a thing' },
  { id: 'sample-two', waitsOn: 'another' },
];`;
  assert.deepEqual(refusalIdsIn(sample), ['sample-one', 'sample-two']);

  /* And the empty form the real file now carries parses as empty rather than as unparseable. */
  const empty = `const REFUSED: readonly { id: string; waitsOn: string }[] = [];`;
  assert.deepEqual(refusalIdsIn(empty), []);

  assert.ok(sentinelNames().length > 4, 'no sentinels were extracted');
  assert.ok(manifestSource().includes('const REFUSED'), 'the real list is still where this looks');
});
