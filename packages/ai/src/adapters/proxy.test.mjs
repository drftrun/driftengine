/**
 * No credential appears anywhere in this package's runtime source.
 *
 * Read from the files rather than reasoned about. A rule kept by remembering is a rule
 * that lasts until somebody adds a convenience header, and the convenience header is
 * exactly how a key ends up in a browser bundle.
 *
 * Wider than the proxy adapter, because the rule is the package's rather than one
 * file's — a helper that grew a header would pass a check scoped to `proxy.ts` and
 * still put a key on the wire.
 *
 * `node:test` rather than vitest because the workspace tsconfig gives package tests no
 * node types, so reading a file from a `.ts` test does not typecheck.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CREDENTIAL = /api[_-]?key|authorization|bearer/i;
const SRC = path.resolve(import.meta.dirname, '..');

/**
 * Source with comments removed.
 *
 * `realtime/session.ts` explains in prose that audio stays bridged and names the
 * package to say so, which a naive scan reports as the coupling it forbids. A sentence
 * about an import is not an import — the same correction `boundaries.test.mjs` and
 * `docs.test.mjs` both needed.
 */
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function runtimeSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) runtimeSources(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

test('the proxy adapter names no credential in its own source', () => {
  assert.doesNotMatch(code(path.join(SRC, 'adapters', 'proxy.ts')), CREDENTIAL);
});

test('no runtime source in the package names a credential', () => {
  const offenders = runtimeSources(SRC)
    .filter((file) => CREDENTIAL.test(code(file)))
    .map((file) => path.relative(SRC, file));

  assert.deepEqual(offenders, [], `credential-shaped names in:\n  ${offenders.join('\n  ')}`);
});

test('no runtime source imports the audio package', () => {
  /*
   * Audio stays bridged, not coupled — the parent design's §39. A consumer wires its
   * own microphone and speaker to what a realtime session yields, because the moment an
   * AI package owned an audio graph it would be an AI package that knew what a mix was.
   *
   * `boundaries.test.mjs` cannot catch this: it checks that every import is *declared*,
   * and the failure here would be adding the declaration too.
   */
  const offenders = runtimeSources(SRC)
    .filter((file) => /@driftengine\/audio/.test(code(file)))
    .map((file) => path.relative(SRC, file));

  assert.deepEqual(offenders, []);
});

test('the credential check can fail', () => {
  /* The guard above passes trivially if its pattern is wrong, and a pattern nobody has
     watched match is a pattern nobody knows works. */
  assert.match('const apiKey = process.env.KEY', CREDENTIAL);
  assert.match("headers: { Authorization: 'Bearer x' }", CREDENTIAL);
});
