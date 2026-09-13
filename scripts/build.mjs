/**
 * What a consumer installs, built from what this repository edits.
 *
 * **This exists because Node cannot load what the packages ship.** `main` points at
 * `src/index.ts`, which a bundler resolves and Node does not — not because the specifiers are
 * wrong, but because Node refuses to strip types for any file under `node_modules` at all:
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, a categorical refusal rather than a resolution
 * failure. It fires on the package entry before a single relative import is reached, so extensions
 * alone fix nothing. Reproduced from a real tarball on 2026-09-04, and invisible from inside the
 * workspace: a dependency resolves through a symlink whose real path has no `node_modules` segment
 * in it, so the refusal never fires locally. `scripts/cleanroom.mjs` is the instrument that can see
 * it.
 *
 * **`tsc` with `rewriteRelativeImportExtensions`, which is a type strip with no code generation
 * anywhere in it.** Every relative import in this repository names `.ts`; the emit rewrites those to
 * `.js` and changes nothing else, so the shipped JavaScript is the source with its types removed,
 * line for line. Nothing is bundled, minified or reordered, which is why no source map ships.
 *
 * **The order is a dependency order and this file derives it rather than listing it.** A package
 * compiles against its dependencies' *declarations*, so `drft` must be built before `assets` or the
 * compiler has nothing to resolve `@driftengine/drft` to. Seventeen packages is too many to keep a
 * hand-written list honest — `driftscript`'s build has two and says the same thing.
 *
 * Usage:
 *   node scripts/build.mjs            every package, in dependency order
 *   node scripts/build.mjs drft       one of them, and whatever it needs first
 *   node scripts/build.mjs --clean    remove every dist and stop
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TSC = path.join(ROOT, 'node_modules', '.bin', 'tsc');
const SCOPE = '@driftengine/';

/** Every package directory that has a build config, by its package name. */
function readPackages() {
  const packages = new Map();
  for (const dir of readdirSync(path.join(ROOT, 'packages'))) {
    const manifest = path.join(ROOT, 'packages', dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    /*
     * **Runtime and peer ranges only. A devDependency is not a build edge, and treating one as an
     * edge is a cycle rather than an ordering.** `@driftengine/drft` declares a dev range on core so
     * that a test can reach core's reproducible transcendentals, and core depends on drft — so the
     * first version of this file refused to build anything at all, with
     * `ai -> core -> drft -> core`. The build excludes `*.test.ts`, so nothing a dev range names is
     * ever compiled into the emit and nothing it names has to exist first.
     */
    const deps = [
      ...Object.keys(m.dependencies ?? {}),
      ...Object.keys(m.peerDependencies ?? {}),
      ...Object.keys(m.optionalDependencies ?? {}),
    ].filter((n) => n.startsWith(SCOPE));
    packages.set(m.name, { dir, name: m.name, deps });
  }
  return packages;
}

/**
 * Dependency order, and a cycle is an error rather than a guess.
 *
 * **A peer range is an edge and a dev range is not**, which is the distinction the first version of
 * this file got wrong. `assets` peers on core and compiles against it, so core must exist first;
 * `drft` declares a dev range on core for a test, and core depends on `drft`, so counting that edge
 * makes a cycle out of a dependency graph that has none.
 */
function buildOrder(packages) {
  const order = [];
  const state = new Map();
  const visit = (name, trail) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(`build: dependency cycle — ${[...trail, name].join(' -> ')}`);
    }
    const entry = packages.get(name);
    if (entry === undefined) return;
    state.set(name, 'visiting');
    for (const dep of entry.deps) visit(dep, [...trail, name]);
    state.set(name, 'done');
    order.push(entry);
  };
  for (const name of [...packages.keys()].sort()) visit(name, []);
  return order;
}

const args = process.argv.slice(2);
const packages = readPackages();
const order = buildOrder(packages);

if (args.includes('--clean')) {
  for (const entry of order)
    rmSync(path.join(ROOT, 'packages', entry.dir, 'dist'), { recursive: true, force: true });
  console.log(`removed ${order.length} dist directories`);
  process.exit(0);
}

/* A named package builds what it needs first, because that is the only way it can compile. */
const wanted = args.filter((a) => !a.startsWith('-'));
const selected =
  wanted.length === 0
    ? order
    : order.filter((entry) => {
        const needed = new Set();
        const collect = (name) => {
          if (needed.has(name)) return;
          needed.add(name);
          for (const dep of packages.get(name)?.deps ?? []) collect(dep);
        };
        for (const w of wanted) collect(w.startsWith(SCOPE) ? w : SCOPE + w);
        return needed.has(entry.name);
      });

if (selected.length === 0) {
  console.error(`build: nothing matched ${wanted.join(', ')}`);
  process.exit(1);
}

/**
 * The licence line, stamped onto every emitted barrel after `tsc` has written it.
 *
 * **`tsc` drops it from three of the eighteen, and the three are not obvious.** A barrel whose
 * first emitted statement is a re-export loses its leading comments entirely — `animation`,
 * `entities` and `physics` emitted a `dist/index.js` whose first line was an `export ... from`
 * with no licence and no description, while the other fifteen kept both. Relying on the compiler
 * to carry a legal notice is relying on a detail of comment attachment that nothing asserts.
 *
 * The source barrels all state it too, and that copy is the one that matters most: a consumer
 * that bundles resolves `main` to `src/index.ts` and never reads `dist`. This covers the other
 * path, a consumer loading the built package from Node.
 *
 * `/*!` rather than a plain block comment because that is the form a minifier keeps by default,
 * so the notice survives into a game's shipped bundle instead of dying at the bundler.
 */
const BANNER =
  '/*! DriftEngine | Copyright 2026 Drift Technologies | Apache-2.0 | https://github.com/drftrun/driftengine */\n';

function stampBanner(dir) {
  const barrel = path.join(ROOT, 'packages', dir, 'dist', 'index.js');
  if (!existsSync(barrel)) return;
  const text = readFileSync(barrel, 'utf8');
  if (text.startsWith('/*!')) return;
  writeFileSync(barrel, BANNER + text);
}

let failed = 0;
for (const entry of selected) {
  const config = path.join(ROOT, 'packages', entry.dir, 'tsconfig.build.json');
  process.stdout.write(`  ${entry.name.padEnd(26)}`);
  try {
    execFileSync(TSC, ['-p', config], { cwd: ROOT, stdio: 'pipe' });
    stampBanner(entry.dir);
    console.log('ok');
  } catch (error) {
    failed++;
    console.log('FAILED');
    process.stdout.write(String(error.stdout ?? '') + String(error.stderr ?? ''));
  }
}

console.log(
  failed === 0 ? `\nbuilt ${selected.length} packages` : `\n${failed} of ${selected.length} failed`,
);
process.exit(failed === 0 ? 0 : 1);
