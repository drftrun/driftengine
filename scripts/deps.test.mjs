/**
 * Every workspace declares what it imports.
 *
 * The unit tests come first and are not ceremony: a scanner whose regex is broken passes the
 * repository-wide assertion silently, which is the test that cannot fail. They are the
 * perturbation, written down — the same shape `determinism.test.mjs` opens with, for the same
 * reason.
 *
 * ---
 *
 * ## What this found the day it was written
 *
 * **Three published packages imported `gl-matrix` from shipped source and declared it nowhere.**
 * `@driftengine/animation`, `@driftengine/terrain` and `@driftengine/xr` reached it through
 * `@driftengine/core`, which does declare it, and one hoisted `node_modules` made that invisible:
 * everything built, tested and typechecked. It breaks for somebody installing one of those
 * packages under a resolver that does not hoist, which is the worst place to find out because
 * nothing in this repository can reproduce it.
 *
 * **And the editor imported two engine packages it never named**, `@driftengine/texture` and
 * `@driftengine/network`, in the same way and for the same reason.
 *
 * ## A test may reach the root's devDependencies; shipped source may not reach any
 *
 * `vitest` is not in any workspace's manifest and never should be — the suite runs from the root.
 * So a test file's imports are checked against the workspace's declarations **plus the root's
 * devDependencies**, and a shipped module's are checked against `dependencies`,
 * `peerDependencies` and `optionalDependencies` alone. A `devDependency` does not reach a
 * consumer, so a shipped module importing one is a package that does not work when installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { declaredIn, importsIn, packageOf, shippedDeclaredIn, undeclared } from './deps.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The workspaces with source of their own: every package, and the editor. */
function workspaces() {
  const dirs = readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join('packages', entry.name));
  dirs.push('editor');
  return dirs.filter((dir) => existsSync(path.join(ROOT, dir, 'package.json')));
}

function sources(dir) {
  const walk = (at) =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  const src = path.join(ROOT, dir, 'src');
  return existsSync(src) ? walk(src) : [];
}

test('the scanner finds an ordinary import', () => {
  assert.deepEqual(importsIn("import { a } from '@driftengine/core';"), ['@driftengine/core']);
});

test('the scanner finds every form an import takes', () => {
  assert.deepEqual(importsIn("import type { A } from 'gl-matrix';"), ['gl-matrix']);
  assert.deepEqual(importsIn("export * from './local.ts';"), ['./local.ts']);
  assert.deepEqual(importsIn("export { a } from 'pkg';"), ['pkg']);
  assert.deepEqual(importsIn("const m = await import('pkg');"), ['pkg']);
  assert.deepEqual(importsIn("import 'pkg/side-effect';"), ['pkg/side-effect']);
});

test('an import broken across lines is still found', () => {
  const source = "import {\n  a,\n  b,\n} from '@driftengine/ui2d';";
  assert.deepEqual(importsIn(source), ['@driftengine/ui2d']);
});

test('prose that mentions an import is prose', () => {
  /* Every one of these was reported as a dependency by a first pass with a bare regex. */
  assert.deepEqual(importsIn("// import { a } from 'pkg';"), []);
  assert.deepEqual(importsIn("/**\n * Reached by `import x from 'pkg'`.\n */"), []);
  assert.deepEqual(importsIn('throw new Error(\'cannot import "pkg" here\');'), []);
  assert.deepEqual(importsIn('const label = `the delta ${from.name} in the root`;'), []);
});

test('a specifier names the package it belongs to', () => {
  assert.equal(packageOf('gl-matrix'), 'gl-matrix');
  assert.equal(packageOf('driftscript/compiler'), 'driftscript');
  assert.equal(packageOf('@driftengine/core'), '@driftengine/core');
  assert.equal(packageOf('@driftengine/script/capabilities.json'), '@driftengine/script');
});

test('what is not a package is not one', () => {
  assert.equal(packageOf('./local.ts'), null);
  assert.equal(packageOf('../other/thing.ts'), null);
  assert.equal(packageOf('node:fs'), null);
  assert.equal(packageOf('@scope'), null);
});

test('a devDependency counts for a test and not for a shipped module', () => {
  const manifest = { dependencies: { a: '1' }, devDependencies: { b: '1' } };
  assert.ok(declaredIn(manifest).has('b'));
  assert.ok(!shippedDeclaredIn(manifest).has('b'));
  assert.ok(shippedDeclaredIn(manifest).has('a'));
});

/**
 * The rule, on files written to break it.
 *
 * This repository cannot exercise it: nothing shipped imports a `devDependency` today, so a
 * perturbation that let one through failed nothing at all. Two synthetic files give it something
 * to refuse, and the repository-wide tests below then only have to supply the repository.
 */
test('a shipped module may not reach a devDependency and a test may', () => {
  const manifest = { name: '@x/pkg', dependencies: { real: '1' }, devDependencies: { tool: '1' } };
  const files = [
    { path: 'src/a.ts', source: "import { a } from 'real';", test: false },
    { path: 'src/b.ts', source: "import { b } from 'tool';", test: false },
    { path: 'src/b.test.ts', source: "import { b } from 'tool';", test: true },
    { path: 'src/c.test.ts', source: "import { c } from 'vitest';", test: true },
    { path: 'src/d.ts', source: "import { d } from './local.ts';", test: false },
  ];
  assert.deepEqual(undeclared(files, manifest, new Set(['vitest'])), [
    'src/b.ts imports tool, which @x/pkg does not declare',
  ]);
});

test('a workspace may import itself, and a root devDependency does not save a shipped module', () => {
  const manifest = { name: '@x/pkg', devDependencies: { vitest: '1' } };
  const files = [
    { path: 'src/a.ts', source: "import { a } from '@x/pkg/sub';", test: false },
    { path: 'src/b.ts', source: "import { b } from 'vitest';", test: false },
  ];
  assert.deepEqual(undeclared(files, manifest, new Set(['vitest'])), [
    'src/b.ts imports vitest, which @x/pkg does not declare',
  ]);
});

function filesOf(dir) {
  return sources(dir).map((file) => ({
    path: path.relative(ROOT, file),
    source: readFileSync(file, 'utf8'),
    test: file.endsWith('.test.ts'),
  }));
}

test('every workspace declares what its shipped source imports', () => {
  const offences = [];
  for (const dir of workspaces()) {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    const shipped = filesOf(dir).filter((file) => !file.test);
    offences.push(...undeclared(shipped, manifest));
  }
  assert.deepEqual(
    offences.sort(),
    [],
    'one hoisted node_modules hides this here and a consumer finds it:\n  ' + offences.join('\n  '),
  );
});

test('every workspace declares what its tests import, or the root does', () => {
  const root = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fromRoot = new Set(Object.keys(root.devDependencies ?? {}));
  const offences = [];
  for (const dir of workspaces()) {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    const tests = filesOf(dir).filter((file) => file.test);
    offences.push(...undeclared(tests, manifest, fromRoot));
  }
  assert.deepEqual(offences.sort(), [], offences.join('\n  '));
});

/** And the scan really walked the repository, rather than finding no files and passing. */
test('the scan covers every workspace and a real number of files', () => {
  const dirs = workspaces();
  assert.ok(dirs.length >= 21, `${dirs.length} workspaces`);
  assert.ok(dirs.includes('editor'), 'the editor is a workspace and is scanned like one');
  const files = dirs.flatMap((dir) => sources(dir));
  assert.ok(files.length > 500, `${files.length} files scanned`);
});
