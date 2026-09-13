/**
 * A package may only reach outside itself through a dependency it declares.
 *
 * Two ways a workspace rots, and this catches both. A relative import that climbs out of
 * its own package compiles perfectly here — the files are all on one disk — and breaks the
 * moment somebody installs the package from a registry. And a bare import of a sibling that
 * is not in `dependencies` resolves through the workspace's hoisted node_modules and fails
 * the same way.
 *
 * Written before the first extraction rather than after the last, on the same reasoning as
 * the link checker in `docs.test.mjs`: a guard added after the change it protects has to be
 * trusted, where one added before it can be watched doing its job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');

function sources(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * The barrel's own first line reads "Game code imports from '@driftengine/core' only",
 * which a naive scan reports as core importing itself. A sentence about an import is not
 * an import — the same correction `docs.test.mjs` needed for its sentinels.
 */
function code(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function packages() {
  return readdirSync(PACKAGES)
    .filter((name) => existsSync(path.join(PACKAGES, name, 'package.json')))
    .map((name) => {
      const manifest = JSON.parse(readFileSync(path.join(PACKAGES, name, 'package.json'), 'utf8'));
      return {
        dir: path.join(PACKAGES, name),
        name: manifest.name,
        runtime: new Set([
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
        ]),
        dev: new Set(Object.keys(manifest.devDependencies ?? {})),
      };
    });
}

test('every relative import stays inside its package and resolves to a file', () => {
  const broken = [];
  for (const pkg of packages()) {
    for (const file of sources(path.join(pkg.dir, 'src'))) {
      for (const [, target] of code(file).matchAll(/from '(\.[^']*)'/g)) {
        const resolved = path.resolve(path.dirname(file), target);
        if (!resolved.startsWith(pkg.dir + path.sep)) {
          broken.push(`${path.relative(ROOT, file)} -> ${target} leaves ${pkg.name}`);
          continue;
        }
        /*
         * Existence is checked as well as containment, because the two failures look
         * nothing alike and only one of them is obvious. A module moved out of a package
         * leaves imports like `../render/mesh` behind, and from `packages/drft/src` that
         * resolves to `packages/drft/render/mesh` — still inside the package by the path
         * test, and pointing at nothing at all.
         */
        const exists = ['.ts', '/index.ts', '.mjs', ''].some((suffix) =>
          existsSync(resolved + suffix),
        );
        if (!exists) {
          broken.push(`${path.relative(ROOT, file)} -> ${target} resolves to nothing`);
        }
      }
    }
  }
  assert.deepEqual(broken, [], broken.join('\n'));
});

/**
 * A sibling may only be imported where it is declared, and a runtime file may not reach a
 * devDependency.
 *
 * The distinction is the whole reason `@driftengine/drft` can claim to depend on nothing: its
 * tests build meshes with core's `MeshBuilder`, which is a development-time need and is not
 * installed for anybody consuming the package. Collapsing the two sets would let a runtime
 * file quietly acquire the same import and the claim would become false without a word.
 */
test('every sibling package imported is declared, and runtime code uses no devDependency', () => {
  const undeclared = [];
  for (const pkg of packages()) {
    for (const file of sources(path.join(pkg.dir, 'src'))) {
      const isTest = file.endsWith('.test.ts');
      for (const [, target] of code(file).matchAll(/from '(@driftengine\/[^'/]+)/g)) {
        if (pkg.runtime.has(target)) continue;
        if (isTest && pkg.dev.has(target)) continue;
        undeclared.push(
          pkg.dev.has(target)
            ? `${path.relative(ROOT, file)} imports ${target}, a devDependency of ${pkg.name}, from runtime code`
            : `${path.relative(ROOT, file)} imports ${target}, which ${pkg.name} does not declare`,
        );
      }
    }
  }
  assert.deepEqual(undeclared, [], undeclared.join('\n'));
});

/**
 * The language may not reach the engine, in either direction of accident.
 *
 * `driftscript` is a reusable language and this engine is its first host — which is the rule
 * `AGENTS.md` opens with, one level up. The seam is only real if something fails when it is
 * crossed, and two crossings are invisible to review: a `peerDependency` added for one convenient
 * type, and an `import type` that a bundler erases so no generated output ever shows it. Either
 * leaves the package compiling perfectly here and unextractable in fact.
 *
 * **Type-only imports are checked exactly like value imports**, because the property being
 * defended is "this package can be moved", not "this package emits no engine code". A type is a
 * dependency on a name, and a name that lives in another repository does not travel.
 *
 * The cost is that a genuinely shared type must be restated at the boundary rather than imported.
 * What would make this wrong is the engine becoming the only host anyone wants — at which point
 * the guard is ceremony, and that is a decision to take out loud rather than by deleting a test.
 *
 * This is one of three mechanisms on the same claim, which is the 2026-08-17 rule applied to the
 * seam itself: `scripts/version.test.mjs` catches the version line, and the
 * `driftscript-runtime-only` fixture in `scripts/size-gate.test.mjs` catches it by failing to
 * bundle with no engine present.
 */
const LANGUAGE_PACKAGES = new Set(['driftscript', 'driftscript-language']);

/**
 * The entity model imports no engine package either, and for a stronger reason than the rule.
 *
 * An entity model that knew what a `Transform` was would be an entity model that knew it had a
 * scene — and the argument for declared reads and writes is that a declaration is about a component
 * *id* rather than about what the component means. Nothing here has to resolve a `SceneNode` to
 * schedule a system that writes one.
 *
 * `driftscript` is allowed and is the one dependency: `Schema` and `migrate`, 406 bytes gzipped, so
 * that storage, serialization, migration and a future inspector read one description of a component
 * rather than two that can drift.
 */
test('the entity model imports no engine package', () => {
  const offences = [];
  const dir = path.join(PACKAGES, 'entities');

  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (dep.startsWith('@driftengine/'))
        offences.push(`the manifest declares ${dep} in ${field}`);
    }
  }

  for (const file of sources(path.join(dir, 'src'))) {
    for (const [, target] of code(file).matchAll(/from '([^']+)'/g)) {
      if (target.startsWith('@driftengine/')) {
        offences.push(`${path.relative(ROOT, file)} imports ${target}`);
      }
    }
  }

  assert.deepEqual(
    offences,
    [],
    `the entity model must not know what a component means:\n  ${offences.join('\n  ')}`,
  );
});

test('the language packages import no engine package', () => {
  const offences = [];
  for (const pkg of packages()) {
    if (!LANGUAGE_PACKAGES.has(pkg.name)) continue;

    const manifest = JSON.parse(readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (dep.startsWith('@driftengine/')) {
          offences.push(`${pkg.name} declares ${dep} in ${field}`);
        }
      }
    }

    for (const file of sources(path.join(pkg.dir, 'src'))) {
      for (const [, target] of code(file).matchAll(/from '([^']+)'/g)) {
        if (target.startsWith('@driftengine/')) {
          offences.push(`${path.relative(ROOT, file)} imports ${target}`);
        }
      }
    }
  }

  assert.deepEqual(
    offences,
    [],
    `the language must be movable without the engine:\n  ${offences.join('\n  ')}`,
  );
});

/**
 * The two packages that import nothing at all still import nothing at all.
 *
 * **Three documents say this and nothing said it in a way that could fail.** `ARCHITECTURE.md` §2
 * calls `@driftengine/chemistry` a package that "imports no other engine package";
 * `packages/physics/README.md` opens with the same sentence about itself and rests a claim on it —
 * a deterministic simulation with no renderer in its module graph, which is what an authoritative
 * host runs. The test above catches an *undeclared* sibling import. It does not catch a declared
 * one, and the way this property ends is a `peerDependency` added for a single convenient type,
 * which turns the guard above green rather than red.
 *
 * So the manifest is checked as well as the source, which is the shape the two tests below it
 * already use for the entity model and the language: those two properties were worth asserting
 * for the same reason and these were left to prose.
 *
 * **`present/` is the case this exists for.** It writes into caller-supplied arrays whose shape it
 * declares *structurally* — core's `ParticleInstances` satisfies `SmokeTarget` exactly and neither
 * package names the other — and the cheap way to write that seam is to import the core type and be
 * done. One `import type` there compiles here, erases at bundle time, appears in no output, and
 * makes the standalone size figure in three documents a fiction.
 *
 * What would make this wrong is core coming to depend on chemistry, which `ARCHITECTURE.md` says it
 * must not: chemistry is optional the way audio and splats are, and the arrow runs consumer ->
 * chemistry, never chemistry -> core.
 */
const STANDALONE_PACKAGES = new Set(['@driftengine/chemistry', '@driftengine/physics']);

test('the standalone packages import no engine package', () => {
  const offences = [];
  let checked = 0;
  for (const pkg of packages()) {
    if (!STANDALONE_PACKAGES.has(pkg.name)) continue;
    checked++;

    const manifest = JSON.parse(readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (dep.startsWith('@driftengine/')) {
          offences.push(`${pkg.name} declares ${dep} in ${field}`);
        }
      }
    }

    for (const file of sources(path.join(pkg.dir, 'src'))) {
      for (const [, target] of code(file).matchAll(/from '([^']+)'/g)) {
        if (target.startsWith('@driftengine/')) {
          offences.push(`${path.relative(ROOT, file)} imports ${target}`);
        }
      }
    }
  }

  /* A renamed package would empty the set and pass, which is the failure the two tests above this
     one share and neither notices. */
  assert.equal(
    checked,
    STANDALONE_PACKAGES.size,
    `expected ${STANDALONE_PACKAGES.size} standalone packages, found ${checked}`,
  );
  assert.deepEqual(
    offences,
    [],
    `three documents call these standalone:\n  ${offences.join('\n  ')}`,
  );
});
