/**
 * **What this file is for: a module a package starts by URL being in the package it ships.** The
 * engine starts its workers as a page does, `new Worker(new URL('./islandWorker.ts',
 * import.meta.url))`, and `tsc` rewrites the extensions of import specifiers and of nothing else —
 * so the published `dist/workerPool.js` named `./islandWorker.ts`, beside a `dist` that holds only
 * `islandWorker.js`. A hand-written `.mjs` module, which `tsc` does not compile, was not in `dist`
 * at all. Both were found packaging a game for the native host, from the build rather than the
 * source; neither is visible from inside the workspace, where every package resolves its source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { emitModules, missingModules, rewriteModuleUrls } from './emitModules.mjs';

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'emit-modules-'));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  return root;
}

test('A MODULE NAMED BY URL IS RENAMED AS ITS IMPORT WOULD BE, and nothing else is, prose included', () => {
  const code = [
    "new Worker(new URL('./islandWorker.ts', import.meta.url), { type: 'module' });",
    'new URL("../threads/scope.mts", import.meta.url);',
    "new URL('./workerScope.mjs', import.meta.url);",
    "new URL('./icon.png', import.meta.url);",
    "new URL('https://example.com/x.ts', import.meta.url);",
    "/* Vite resolves `new URL('./x.ts', import.meta.url)` inside a `new Worker`. */",
  ].join('\n');
  assert.equal(
    rewriteModuleUrls(code),
    [
      "new Worker(new URL('./islandWorker.js', import.meta.url), { type: 'module' });",
      'new URL("../threads/scope.mjs", import.meta.url);',
      "new URL('./workerScope.mjs', import.meta.url);",
      "new URL('./icon.png', import.meta.url);",
      "new URL('https://example.com/x.ts', import.meta.url);",
      "/* Vite resolves `new URL('./x.ts', import.meta.url)` inside a `new Worker`. */",
    ].join('\n'),
  );
});

test('THE EMIT GETS ITS HAND-WRITTEN MODULES AND ITS URLS RENAMED, and then names nothing missing', () => {
  const root = tree({
    'src/pool.ts': "new Worker(new URL('./worker.ts', import.meta.url));",
    'src/threads/scope.mjs': 'export {};',
    'src/threads/scope.test.mjs': 'a test, which does not ship',
    'dist/pool.js': "new Worker(new URL('./worker.ts', import.meta.url));",
    'dist/worker.js': 'export {};',
    'dist/threads/start.js': "new URL('./scope.mjs', import.meta.url);",
    'dist/prose.js':
      "// a worker is started with `new URL('./gone.js', import.meta.url)`\nexport {};",
  });
  const src = path.join(root, 'src');
  const dist = path.join(root, 'dist');
  assert.deepEqual(missingModules(dist).sort(), [
    'pool.js names ./worker.ts, which is not there',
    'threads/start.js names ./scope.mjs, which is not there',
  ]);
  emitModules(src, dist);
  assert.equal(
    readFileSync(path.join(dist, 'pool.js'), 'utf8'),
    "new Worker(new URL('./worker.js', import.meta.url));",
  );
  assert.equal(readFileSync(path.join(dist, 'threads', 'scope.mjs'), 'utf8'), 'export {};');
  assert.equal(existsSync(path.join(dist, 'threads', 'scope.test.mjs')), false);
  assert.deepEqual(missingModules(dist), []);
});
