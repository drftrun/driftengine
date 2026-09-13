/**
 * The counts script reads the suite's summary and never runs a suite.
 *
 * **This exists because the waste it prevents was invisible.** `docs-counts.mjs` used to get the
 * test count by running `npx vitest run` in full and scraping the last line — 74 seconds of wall
 * clock and about five CPU-minutes, measured 2026-08-28 — so anyone who ran the suite and then
 * refreshed the counts paid for two. Nothing said so: both commands succeeded, one of them just
 * took a minute longer than it looked like it should.
 *
 * So the first test below is the regression guard, and the rest are the reader's own contract: a
 * summary is a report about *one* run, and a script that writes a document from it has to know
 * which run. A filtered run, a red run and a stale run all produce a file shaped exactly like the
 * one it wants.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { surveyTestFiles, testsFromSummary } from './docs-counts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** A summary file holding whatever a case needs to say. */
function summaryOf(fields) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drift-counts-'));
  const file = path.join(dir, 'summary.json');
  writeFileSync(
    file,
    JSON.stringify({
      success: true,
      numFailedTests: 0,
      numPassedTests: 3000,
      /* One entry per file, which is what a filtered run has fewer of. `numTotalTestSuites` counts
         `describe` blocks — 768 against 380 files in this repository — and reading that as a file
         count refuses every full run. */
      testResults: Array.from({ length: 380 }, (_, index) => ({ name: `file${index}.test.ts` })),
      startTime: Date.now(),
      ...fields,
    }),
  );
  return file;
}

test('the script does not run the suite to count its tests', () => {
  const source = readFileSync(path.join(ROOT, 'scripts', 'docs-counts.mjs'), 'utf8');
  /*
   * The shape rather than the word: `execFileSync`, `spawnSync` and `exec` are all ways back to a
   * second suite, and the reason this file is cheap is that it starts no process at all.
   */
  for (const forbidden of ['execFileSync', 'execSync', 'spawnSync', 'child_process']) {
    assert.ok(
      !source.includes(`${forbidden}(`) && !source.includes(`'${forbidden}'`),
      `docs-counts.mjs names ${forbidden}, which is how it used to run a second full suite`,
    );
  }
  assert.ok(source.includes('.vitest'), 'docs-counts.mjs must read the summary the suite writes');
});

test('the file survey counts the tree and dates it', () => {
  const files = surveyTestFiles();
  assert.ok(files.total > 300, `expected the engine's test files, counted ${files.total}`);
  assert.ok(files.newest > 0, 'the survey must date the newest test file');
});

test('a green full run is what the count is taken from', () => {
  const files = { total: 380, newest: 0 };
  const answer = testsFromSummary(files, summaryOf({ numPassedTests: 3096 }));
  assert.equal(answer.count, 3096);
  assert.equal(answer.why, null);
});

test('a filtered run is refused, because its summary looks like a full one', () => {
  const files = { total: 380, newest: 0 };
  const answer = testsFromSummary(
    files,
    summaryOf({ testResults: Array.from({ length: 9 }, () => ({ name: 'one.test.ts' })) }),
  );
  assert.equal(answer.count, null);
  assert.match(answer.why, /filtered/);
  assert.match(answer.why, /9 of 380/);
});

test('a red run is refused, because the document claims the tests pass', () => {
  const files = { total: 380, newest: 0 };
  const failed = testsFromSummary(files, summaryOf({ success: false }));
  assert.equal(failed.count, null);
  assert.match(failed.why, /not green/);
  /* `success` and the failure count are two claims in one file, and either being wrong is enough. */
  const counted = testsFromSummary(files, summaryOf({ numFailedTests: 1 }));
  assert.equal(counted.count, null);
});

test('a run older than a test file is refused', () => {
  const file = summaryOf({ startTime: 1_000 });
  const answer = testsFromSummary({ total: 380, newest: 2_000 }, file);
  assert.equal(answer.count, null);
  assert.match(answer.why, /newer than the last run/);
});

test('a missing summary is refused by name, not guessed at', () => {
  const answer = testsFromSummary(
    { total: 380, newest: 0 },
    path.join(tmpdir(), 'nothing-here.json'),
  );
  assert.equal(answer.count, null);
  assert.match(answer.why, /npm test/);
});

test('a summary that is not JSON is refused rather than throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drift-counts-'));
  const file = path.join(dir, 'summary.json');
  writeFileSync(file, 'not json at all');
  /* A run killed part-way through leaves one of these, and a throw here would stop the script
     fixing the four numbers it reads straight from source. */
  const answer = testsFromSummary({ total: 380, newest: 0 }, file);
  assert.equal(answer.count, null);
  assert.match(answer.why, /npm test/);
});
