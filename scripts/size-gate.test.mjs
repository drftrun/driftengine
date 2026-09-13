/**
 * What each entry point costs, measured rather than asserted.
 *
 * The engine's public promise used to be that it is small. With optional packages the honest
 * form is "you pay only for what you import, and here is the number", and a number nobody
 * checks becomes wrong the same way a document does.
 *
 * esbuild is a devDependency rather than an `npx` fetch, so the gate is deterministic in CI
 * and does not need the network at test time. It bundles TypeScript directly, which is what
 * every consumer of this engine does — they resolve `main` to `src/index.ts` and bundle it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ESBUILD = path.join(ROOT, 'node_modules', '.bin', 'esbuild');

import { FLOORS } from './size-floors.mjs';

const TOLERANCE = 0.03;

/**
 * The bundled JavaScript for a fixture, minified, as text.
 *
 * Separate from `bundleBytes` because the two answer different questions and one of them is not
 * about size at all. Bundling twice costs a fraction of a second and keeps each test reading as
 * what it asserts.
 */
function bundleSource(fixture) {
  const out = mkdtempSync(path.join(tmpdir(), 'size-'));
  try {
    execFileSync(
      ESBUILD,
      [
        path.join(ROOT, 'scripts', 'fixtures', 'size', `${fixture}.ts`),
        '--bundle',
        '--minify',
        '--format=esm',
        '--platform=browser',
        /*
         * **Measure the source, and say so rather than inherit it.** Since the default export
         * condition became `dist`, a bundler that is not told otherwise resolves an engine import
         * to a build this gate does not make — and CI never builds, so every fixture failed to
         * resolve at once. `dist` is a type strip with no code generation, so bundling it would
         * measure the same bytes anyway; naming the condition keeps the floors comparable to the
         * ones already recorded and keeps this gate independent of whether anything is built.
         */
        '--conditions=drift-source',
        `--outfile=${path.join(out, 'bundle.js')}`,
      ],
      { cwd: ROOT, stdio: 'pipe' },
    );
    return readFileSync(path.join(out, 'bundle.js'), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function bundleBytes(fixture) {
  const out = mkdtempSync(path.join(tmpdir(), 'size-'));
  try {
    execFileSync(
      ESBUILD,
      [
        path.join(ROOT, 'scripts', 'fixtures', 'size', `${fixture}.ts`),
        '--bundle',
        '--minify',
        '--format=esm',
        '--platform=browser',
        /*
         * **Measure the source, and say so rather than inherit it.** Since the default export
         * condition became `dist`, a bundler that is not told otherwise resolves an engine import
         * to a build this gate does not make — and CI never builds, so every fixture failed to
         * resolve at once. `dist` is a type strip with no code generation, so bundling it would
         * measure the same bytes anyway; naming the condition keeps the floors comparable to the
         * ones already recorded and keeps this gate independent of whether anything is built.
         */
        '--conditions=drift-source',
        `--outfile=${path.join(out, 'bundle.js')}`,
      ],
      { cwd: ROOT, stdio: 'pipe' },
    );
    return gzipSync(readFileSync(path.join(out, 'bundle.js'))).byteLength;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

for (const [fixture, floor] of Object.entries(FLOORS)) {
  test(`${fixture} stays within ${Math.round(TOLERANCE * 100)}% of ${floor} bytes gzipped`, () => {
    const actual = bundleBytes(fixture);
    const drift = Math.abs(actual - floor) / floor;
    assert.ok(
      drift <= TOLERANCE,
      `${fixture} is ${actual} bytes gzipped against a floor of ${floor} ` +
        `(${(drift * 100).toFixed(1)}% off). If this is deliberate, update the floor in the ` +
        'same commit and say why.',
    );
  });
}

/**
 * The language's own gates are no longer here, and that is the extraction finishing rather than a
 * guard being dropped.
 *
 * Three tests stood in this place: a ceiling proving `driftscript`'s runtime bundles with no engine
 * present, the same for its compiler entry, and a probe on diagnostic text proving a production
 * bundle never reaches the parser. All three asserted properties of a package this repository
 * vendored, and it is now an installed dependency at a published version.
 *
 * **They moved rather than went.** `driftscript`'s own repository runs all three against its own
 * source, where a change can actually break them, plus a clean-room install this could never have
 * checked. Keeping copies here would assert a dependency's internals from outside, which is the
 * shape of test that passes for years and then fails for a reason nobody in this repository can
 * fix.
 *
 * What this repository still owns about that seam is `scripts/boundaries.test.mjs`, which refuses an
 * engine import from `@driftengine/entities` — the one package that takes `Schema` and `migrate`
 * from the language and must stay ignorant of what a component means.
 */

/**
 * The assertion the whole split is for.
 *
 * If adding a package to an entry point does not grow its bundle, then core is dragging that
 * package in regardless and both numbers are measuring the same thing. The likeliest cause is
 * a re-export left behind in core's barrel.
 *
 * The margin is absolute rather than proportional, and that is a correction rather than a
 * preference: audio is 3,151 lines of source and adds 4.9 KB gzipped, which is 1.3% of a
 * core bundle dominated by shader text that does not minify. A percentage threshold generous
 * enough to pass would have been too loose to catch anything.
 */
const MINIMUM_GROWTH = 1024;

test('importing core alone does not pull in an optional package', () => {
  const core = bundleBytes('core-only');
  for (const [fixture, label] of [
    ['core-and-audio', 'the audio graph'],
    ['core-and-assets', 'the model readers'],
    ['core-audio-spatial', 'the audio graph and the spatial layer'],
    ['core-and-splats', 'the splat readers, sort and pass'],
    ['core-and-animation', 'skeletons, clips and the graphs over them'],
  ]) {
    const withIt = bundleBytes(fixture);
    assert.ok(
      withIt - core >= MINIMUM_GROWTH,
      `core-only is ${core} bytes and ${fixture} is ${withIt}, a difference of ${withIt - core}. ` +
        `If adding ${label} does not grow the bundle, the tree-shaking is not working and both ` +
        'numbers are measuring the same thing.',
    );
  }
});
