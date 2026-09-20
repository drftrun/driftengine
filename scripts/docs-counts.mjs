#!/usr/bin/env node
/**
 * Rewrite the numbers `docs/CAPABILITIES.md` quotes about itself.
 *
 * **The guards that check these are right, and doing the arithmetic by hand is what was wrong.**
 * `docs.test.mjs` asserts that the test-file count and the two renderer line counts in that
 * document are current, because a number in a document is a claim like any other and the document
 * this replaced was 556 lines wrong within a week. But every commit that adds a test file or a
 * line of renderer moves them, so the numbers were being corrected one commit *after* the change
 * that moved them — which failed CI on the commit in between, four times.
 *
 * So the numbers are generated. The guard stays exact; the work stops being arithmetic.
 *
 *     npm run docs:counts     # then commit CAPABILITIES.md with the change that moved them
 *
 * **The test count comes from the suite's own summary and this script no longer runs one.** It did
 * until 2026-08-28: `npx vitest run`, in full, to scrape one number out of the last line — so a
 * session that ran the suite and then refreshed the counts paid twice for the same work, 74 seconds
 * of wall clock and about five CPU-minutes each, measured. `vitest.config.ts` writes
 * `.vitest/summary.json` on every run now, and this reads it.
 *
 * **The number only exists in a character, so a reader has to check that the run it is reading was the
 * right one.** Three ways a summary lies, and one check each: a *red* run, where the document's
 * "passing" would be false; a *filtered* run — `npx vitest run one/file` writes a summary that
 * looks exactly like a full one — caught by comparing its suite count against a walk of the tree;
 * and a *stale* run, caught by comparing its start time against the newest test file on disk.
 * Where any of them fails, the count already in the document is kept and the reason is said. A
 * silent stale number is the failure this whole file exists to prevent.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOC = path.join(ROOT, 'docs', 'CAPABILITIES.md');

/**
 * The test files, and when the newest of them was last written.
 *
 * The count is what the document quotes and what `docs.test.mjs` asserts. The modification time is
 * how a summary is known to be stale: a test edited after the last run describes a suite that no
 * longer exists.
 */
/**
 * The roots `vitest.config.ts` runs tests under, which the walk below has to cover exactly: a run is
 * known to be a full one by comparing its file count against this walk, so a root the suite runs and
 * the walk misses makes every full run look filtered. `docs.test.mjs` reads the configuration's own
 * list and fails if this one falls behind it. `tools` joined when the reconstruction trainer's tests
 * did.
 */
export const TEST_ROOTS = ['packages', 'demo', 'editor', 'tools'];

export function surveyTestFiles() {
  let total = 0;
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) {
        total += 1;
        const at = statSync(full).mtimeMs;
        if (at > newest) newest = at;
      }
    }
  };
  for (const root of TEST_ROOTS) walk(path.join(ROOT, root));
  return { total, newest };
}

function lineCount(file) {
  return readFileSync(path.join(ROOT, file), 'utf8').split('\n').length - 1;
}

/**
 * What the last run said, or null with the reason it cannot be used.
 *
 * Null rather than a guess and rather than a throw: the two line counts and the two versions beside
 * it are read from source and are always right, so a missing or untrustworthy summary must not stop
 * this script from fixing them. What it must not do is write a number it cannot stand behind.
 */
export function testsFromSummary(files, file = path.join(ROOT, '.vitest', 'summary.json')) {
  let summary;
  try {
    summary = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { count: null, why: 'no .vitest/summary.json — run `npm test`' };
  }
  if (summary.success !== true || summary.numFailedTests > 0) {
    return { count: null, why: 'the last run was not green — fix the suite, then `npm test`' };
  }
  /*
   * A filtered run writes a summary shaped exactly like a full one. How many *files* it covered is
   * the only thing in it that says so, against a walk of the tree this script does anyway.
   *
   * **`testResults.length` and not `numTotalTestSuites`.** That field counts `describe` blocks —
   * 768 of them against 380 files, measured — so reading it as a file count refuses every full run
   * as filtered. Which is what happened on the first green run after this check was written, and is
   * the argument for the check: it caught a wrong assumption in itself rather than writing a wrong
   * number into a document.
   */
  const covered = Array.isArray(summary.testResults) ? summary.testResults.length : 0;
  if (covered !== files.total) {
    return {
      count: null,
      why:
        `the last run covered ${covered} of ${files.total} test files, so it ` +
        'was a filtered one — run `npm test`',
    };
  }
  if (typeof summary.startTime === 'number' && summary.startTime < files.newest) {
    return { count: null, why: 'a test file is newer than the last run — run `npm test`' };
  }
  return { count: summary.numPassedTests, why: null };
}

/**
 * The writing half, run only as a program.
 *
 * `docs-counts.test.mjs` imports the two readers above to drive the cases a summary can be wrong
 * in, and an unguarded body would rewrite `CAPABILITIES.md` every time that suite ran. The same
 * shape `shots.mjs` uses, and a function rather than an early `process.exit`: exiting on import
 * would take the importer's process with it.
 */
function main() {
  const files = surveyTestFiles();
  const fromRun = testsFromSummary(files);
  const renderer = lineCount('packages/core/src/render/backend/webgl2/renderer.ts');
  const webgpu = lineCount('packages/core/src/render/backend/webgpu/renderer.ts');

  let doc = readFileSync(DOC, 'utf8');
  const before = doc;

  /*
   * The file count is always written; the test count only when the last run can be stood behind.
   * Kept rather than blanked, because the previous number came from a real run and a number one
   * commit old is a better claim than no number at all — and the line below says which it is.
   */
  doc = doc.replace(
    /([\d,]+) test files and ([\d,]+) tests passing/,
    (whole, _quotedFiles, quotedTests) =>
      `${files.total} test files and ${fromRun.count ?? quotedTests} tests passing`,
  );
  /*
   * The container version, from the source rather than from memory.
   *
   * It sat at 1.4 while the format was at 1.5, and at 1.5 while it went to 1.6 and then 1.7 — three
   * drifts in the one sentence that opens by claiming the document is true. Nothing asserted it,
   * because `docs.test.mjs` checks the counts beside it and not this. Generated now, so the sentence
   * cannot be wrong about the format again.
   */
  const formatSource = readFileSync(path.join(ROOT, 'packages/drft/src/drftFormat.ts'), 'utf8');
  const major = /DRFT_VERSION_MAJOR = (\d+)/.exec(formatSource)?.[1] ?? '1';
  const minor = /DRFT_VERSION_MINOR = (\d+)/.exec(formatSource)?.[1] ?? '0';
  doc = doc.replace(/container format \d+\.\d+/, `container format ${major}.${minor}`);
  /*
   * The engine version, for the same reason and found the same way.
   *
   * The fix above generated three of the four claims in that opening sentence and left this one,
   * so it went on drifting alone: it read 3.5.0 against an engine at 3.6.0 the day after Track A
   * shipped. A sentence that opens by saying the document is true is the worst place to leave a
   * field that nothing asserts, and *most* of it being generated makes the remainder harder to
   * doubt rather than easier.
   */
  const engine = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  doc = doc.replace(/True against engine \d+\.\d+\.\d+/, `True against engine ${engine}`);
  doc = doc.replace(
    /`renderer\.ts` is now \*\*[\d,]+ lines\*\*/,
    `\`renderer.ts\` is now **${renderer} lines**`,
  );
  doc = doc.replace(
    /`webgpu\/renderer\.ts` is \*\*[\d,]+\*\*, for [\d,]+ lines/,
    `\`webgpu/renderer.ts\` is **${webgpu.toLocaleString('en-GB')}**, for ${(renderer + webgpu).toLocaleString('en-GB')} lines`,
  );

  const counted =
    fromRun.count === null ? 'the count already in the document' : `${fromRun.count} tests`;
  if (doc === before) {
    console.log(
      `ok: already current — ${files.total} test files, ${counted}, ${renderer + webgpu} renderer lines`,
    );
  } else {
    writeFileSync(DOC, doc);
    console.log(
      `wrote: ${files.total} test files, ${counted}, ${renderer} + ${webgpu} renderer lines`,
    );
  }
  /* Said rather than swallowed: a script that quietly kept a stale number would be the thing this
     file was written to stop, one layer up. */
  if (fromRun.why !== null) console.log(`  the test count was left alone: ${fromRun.why}`);
}

const runDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runDirectly) main();
