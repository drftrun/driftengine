/**
 * What a workspace imports, so it can be compared with what it declares.
 *
 * **A monorepo hides an undeclared dependency and a consumer finds it.** Every workspace resolves
 * through one hoisted `node_modules`, so a package importing something it never declared builds,
 * tests and typechecks exactly like one that did. It breaks for somebody who installs the package
 * on its own, or under a resolver that does not hoist — which is the worst place to find out,
 * because nothing in this repository can reproduce it.
 *
 * **Comments and strings are stripped before anything is matched**, using `platform.mjs`'s own
 * stripper rather than a second copy. Without it a sentence mentioning a package name reads as an
 * import: a first pass over this repository with a bare regex reported `not permitted`, `the cell`
 * and `${zone.from.name}` as dependencies, from prose alone.
 */
import { withoutCommentsOrStrings } from './platform.mjs';

/**
 * Every module specifier imported by this source.
 *
 * The stripped text says which lines are code; the raw text of those lines says what the specifier
 * was. Taking the specifier from the stripped text is impossible — the stripper blanks the string
 * it lives in — and taking the line from the raw text is what reports prose.
 */
export function importsIn(source) {
  const raw = source.split('\n');
  const code = withoutCommentsOrStrings(source).split('\n');
  const found = [];
  for (let i = 0; i < code.length; i++) {
    if (!/\b(?:from|import)\b/.test(code[i] ?? '')) continue;
    for (const match of (raw[i] ?? '').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      found.push(match[1]);
    }
  }
  return found;
}

/**
 * The package a specifier belongs to, or null for one that is not a package.
 *
 * A relative path is the workspace's own, and `node:` is the platform's. Everything else is a
 * package, and a deep import such as `driftscript/compiler` is that package's business rather
 * than a separate dependency.
 */
export function packageOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length < 2 ? null : `${parts[0]}/${parts[1]}`;
  return parts[0] ?? null;
}

/** Everything a manifest declares, by whatever route. */
export function declaredIn(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

/** What a shipped module may reach: never a `devDependency`, because a consumer does not get one. */
export function shippedDeclaredIn(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

/**
 * Every import in `files` that nothing permits, as a sentence each.
 *
 * **The rule is here rather than in the test**, so it can be checked against files written for the
 * purpose. Against this repository alone it cannot be: no shipped module imports a `devDependency`
 * today, so loosening the rule to allow one fails nothing — a perturbation found exactly that, and
 * the answer was to give the rule something to fail on rather than to weaken it.
 *
 * `files` is `{ path, source, test }`. A test file may reach what the workspace declares by any
 * route, plus `fromRoot` — the root's devDependencies, which is where `vitest` lives and where it
 * belongs. A shipped module may reach only what a consumer installing this package would get.
 */
export function undeclared(files, manifest, fromRoot = new Set()) {
  const shipped = shippedDeclaredIn(manifest);
  const any = declaredIn(manifest);
  const offences = [];
  for (const file of files) {
    const allowed = file.test ? any : shipped;
    for (const specifier of importsIn(file.source)) {
      const name = packageOf(specifier);
      if (name === null || name === manifest.name || allowed.has(name)) continue;
      if (file.test && fromRoot.has(name)) continue;
      offences.push(
        file.test
          ? `${file.path} imports ${name}, which nothing declares`
          : `${file.path} imports ${name}, which ${manifest.name} does not declare`,
      );
    }
  }
  return [...new Set(offences)].sort();
}
