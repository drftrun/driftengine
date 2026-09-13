/**
 * Every worker this engine ships must compile as an IIFE.
 *
 * **Because a bundler decides that, not us.** `workerPool.ts` builds its worker with
 * `new Worker(new URL('./islandWorker.ts', import.meta.url), { type: 'module' })`, which Vite,
 * webpack and Parcel all detect *statically* and compile as a worker — whether or not the consuming
 * game ever starts a pool. Vite's default `worker.format` is `iife`, and an IIFE cannot carry a
 * top-level await.
 *
 * On 2026-09-05 that broke a consumer's production build outright:
 *
 *     [vite:worker-import-meta-url] Module format "iife" does not support top-level await
 *     file: driftengine/packages/physics/src/workerPool.ts
 *
 * The entry had a top-level `await import('node:worker_threads')` so one file could serve both a
 * browser worker and `node:worker_threads`. Every engine gate was green: `typecheck`, the suite,
 * `test:scripts`, and `check:pool` itself — which drives a *dev server*, and a dev server serves
 * module workers and never builds an IIFE. The first thing to see it was a consumer's `vite build`.
 *
 * So this asserts the constraint directly rather than by proxy. A test forbidding the string
 * `await` would pass a worker that broke IIFE some other way; compiling the file the way a consumer
 * compiles it is the same question a consumer asks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ESBUILD = path.join(ROOT, 'node_modules', '.bin', 'esbuild');

/**
 * Every file constructed as a worker anywhere under `packages/`.
 *
 * Found by reading the `new Worker(new URL(...))` calls rather than by listing entries by hand, so
 * a second worker added tomorrow is covered tomorrow. `splatSortWorker.ts` builds its worker from a
 * `Blob` and has no URL to find, which is correct: a stringified function has no module graph and
 * no import to be top-level-awaited.
 */
/**
 * Source with comments removed.
 *
 * The first run of this file is why. `splatSortWorker.ts`'s header *describes*
 * `new Worker(new URL('./x.ts', import.meta.url))` as the form it deliberately avoids, and the scan
 * read that prose as a call. `docs.test.mjs` strips comments before matching symbols for the same
 * reason and in the same words.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function workerEntries() {
  const found = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === 'node_modules' || name === 'dist') continue;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
      const source = stripComments(readFileSync(full, 'utf8'));
      for (const [, spec] of source.matchAll(/new Worker\(\s*new URL\(\s*['"]([^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(full), spec);
        /* A specifier that resolves to nothing is a scanning bug, not a worker. Asserted rather
           than skipped, so a real entry that moves is not quietly dropped from this gate. */
        assert.ok(
          existsSync(target),
          `${path.relative(ROOT, full)} names a worker that is not there: ${spec}`,
        );
        found.add(target);
      }
    }
  };
  walk(path.join(ROOT, 'packages'));
  return [...found].sort();
}

test('every worker entry compiles as an IIFE, which is what a bundler does to it', () => {
  const entries = workerEntries();

  /* The floor. An empty list would make this file pass by finding nothing, which is the shape the
     2026-09-04 audit removed fifty-seven of. */
  assert.ok(entries.length > 0, 'no worker entries were found — the scan is broken');

  for (const entry of entries) {
    const relative = path.relative(ROOT, entry);
    try {
      execFileSync(
        ESBUILD,
        [entry, '--bundle', '--format=iife', '--platform=browser', '--outfile=/dev/null'],
        { cwd: ROOT, stdio: 'pipe' },
      );
    } catch (error) {
      const detail = String(error.stderr ?? error.message)
        .split('\n')
        .slice(0, 6)
        .join('\n');
      assert.fail(
        `${relative} does not compile as an IIFE, so a consumer's production build fails on it ` +
          `even if they never start it:\n${detail}`,
      );
    }
  }
});

/**
 * A package barrel names no worker.
 *
 * **Because a bundler emits one before it decides the code is unreachable.** Vite's
 * `vite:worker-import-meta-url` rewrites `new Worker(new URL(...))` at *transform* time, so a barrel
 * that merely re-exports something constructing a worker writes that worker to disk as an asset even
 * when tree-shaking then removes every path to it.
 *
 * Reported by a consumer on 2026-09-05 and reproduced on a second the same day: importing
 * `PhysicsWorld` shipped **12,259 gzipped bytes** of island worker into a build where the pool's own
 * symbols were absent from every other chunk and nothing named the worker at all.
 *
 * **Every gate in this repository was green while that shipped**, including the one above, which
 * asks whether a worker *compiles* and not whether a barrel *reaches* one. So this asks the second
 * question, the way a consumer's bundler asks it: bundle the barrel and look for the construction.
 * A barrel that needs one is not forbidden — it is asked to be a specifier of its own, the way
 * `physics/src/workers.ts` is.
 */
test('no package barrel reaches a worker construction', () => {
  const barrels = readdirSync(path.join(ROOT, 'packages'))
    .map((name) => ({ name, entry: path.join(ROOT, 'packages', name, 'src', 'index.ts') }))
    .filter((pkg) => existsSync(pkg.entry));

  assert.ok(barrels.length > 10, `expected the packages to have barrels, found ${barrels.length}`);

  const offenders = [];
  for (const { name, entry } of barrels) {
    const out = path.join(ROOT, 'node_modules', '.cache', `barrel-${name}.js`);
    try {
      execFileSync(
        ESBUILD,
        [entry, '--bundle', '--format=esm', '--platform=browser', `--outfile=${out}`],
        { cwd: ROOT, stdio: 'pipe' },
      );
    } catch {
      /* A barrel that will not bundle for a browser is `boundaries.test.mjs`'s subject, not this
         one. Skipping keeps one failure in one place. */
      continue;
    }
    /* The construction itself, after comments are gone, because a header describing the form is
       exactly what tripped the scan above on its first run. */
    if (/new Worker\s*\(\s*new URL/.test(stripComments(readFileSync(out, 'utf8')))) {
      offenders.push(`@driftengine/${name}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these barrels reach a worker construction, so a bundler emits it for every consumer that ` +
      `imports anything from them:\n  ${offenders.join('\n  ')}\n` +
      'Move the factory behind its own specifier, as `physics/src/workers.ts` is.',
  );
});
