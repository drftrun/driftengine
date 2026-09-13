/**
 * Every package has a README, the root README lists every package, and the sizes they quote are real.
 *
 * **All three of these had drifted at once, and none of them failed.** The root table said "Five
 * packages", listed six, and there were eleven on disk — `animation`, `splats`, `script` and both
 * language packages were absent from the map a reader starts at. Four packages had no README at
 * all. And every README that quoted a gzipped cost quoted a stale one, each under a sentence saying
 * the number was "a fact about the build rather than a claim in a document": core said 369.8 KB
 * against a measured 524.3, drft said 2.7 against 4.4, audio 4.9 against 6.0, assets 9.3 against
 * 11.1. `media` claimed the size gate measured it and no fixture for it exists.
 *
 * That is the failure `docs/README.md` opens by describing, in the one place a stranger looks first.
 * So it is asserted here rather than reviewed: a package added without a README, or left out of the
 * root table, or quoting a number that has moved, is a red suite.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOORS } from './size-floors.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES = path.join(ROOT, 'packages');

function packages() {
  return readdirSync(PACKAGES)
    .filter((name) => existsSync(path.join(PACKAGES, name, 'package.json')))
    .map((name) => ({
      dir: name,
      manifest: JSON.parse(readFileSync(path.join(PACKAGES, name, 'package.json'), 'utf8')),
      readme: path.join(PACKAGES, name, 'README.md'),
    }));
}

const rootReadme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('every package has a README', () => {
  const missing = packages()
    .filter((pkg) => !existsSync(pkg.readme))
    .map((pkg) => pkg.dir);
  assert.deepEqual(missing, [], `packages with no README:\n  ${missing.join('\n  ')}`);
});

/**
 * Every package can be built for Node.
 *
 * **`npm run build` is not in the gate list `AGENTS.md` prints**, deliberately: a consumer that
 * bundles resolves `main` to `src/index.ts` and needs no build at all, so the suite that runs on
 * every change does not pay for one. The cost of that is what happened on 2026-09-05, when
 * `@driftengine/xr` shipped without a `tsconfig.build.json` and `npm run build` failed on `main`
 * with `TS5058` while `typecheck`, `test:scripts` and 4,394 tests were all green.
 *
 * A missing config is the whole of what went wrong, and it is a file's absence rather than a
 * compilation error, so it is cheap to catch here instead of by running eighteen builds. What this
 * does not check is that the build *succeeds*; `npm run cleanroom` is where that lives.
 */
test('every package can be built for Node', () => {
  const missing = packages()
    .filter((pkg) => !existsSync(path.join(PACKAGES, pkg.dir, 'tsconfig.build.json')))
    .map((pkg) => pkg.manifest.name);
  assert.deepEqual(
    missing,
    [],
    `packages with no tsconfig.build.json, so \`npm run build\` fails on them:\n  ${missing.join('\n  ')}`,
  );
});

test('a package README opens by naming the package', () => {
  /* A reader arriving from a file tree needs the first line to say which of eleven things this is.
     Deriving it from the manifest means a rename cannot leave the heading behind. */
  const wrong = [];
  for (const pkg of packages()) {
    if (!existsSync(pkg.readme)) continue;
    const heading = readFileSync(pkg.readme, 'utf8').split('\n')[0].trim();
    /* Contains the name rather than equals it, because `driftscript`'s README opens `# DriftScript`
       — the language's own name, which reads better than its package id and says just as clearly
       which of eleven things a reader has opened. What this still catches is a heading a rename
       left behind, which is the drift worth catching. */
    if (!heading.toLowerCase().includes(pkg.manifest.name.toLowerCase())) {
      wrong.push(`${pkg.dir}: "${heading}" does not name ${pkg.manifest.name}`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n  '));
});

test('the root README names every package that exists', () => {
  const absent = packages()
    .map((pkg) => pkg.manifest.name)
    .filter((name) => !rootReadme.includes(name));
  assert.deepEqual(
    absent,
    [],
    `the map a stranger reads first does not mention:\n  ${absent.join('\n  ')}`,
  );
});

test('the root README names no package that does not exist', () => {
  const real = new Set(packages().map((pkg) => pkg.manifest.name));
  const named = new Set([...rootReadme.matchAll(/`(@driftengine\/[a-z-]+)`/g)].map((m) => m[1]));
  const ghosts = [...named].filter((name) => !real.has(name));
  assert.deepEqual(
    ghosts,
    [],
    `named in the root README but not on disk:\n  ${ghosts.join('\n  ')}`,
  );
});

test('the package count the root README states is the number of packages', () => {
  /*
   * The sentence said "Five packages" while listing six and while eleven existed. A count in prose
   * is exactly the claim this repository has been caught by twice before — the version bump said
   * six and five for a month, and sixteen for a day.
   */
  const match = /\*\*([A-Za-z]+) packages, and a consumer takes only what it uses:\*\*/.exec(
    rootReadme,
  );
  assert.ok(match !== null, 'the package table has lost its introducing sentence');

  const WORDS = {
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
  };
  const stated = WORDS[match[1].toLowerCase()];
  assert.ok(stated !== undefined, `unrecognised number word "${match[1]}"`);
  assert.equal(
    stated,
    packages().length,
    `the root README says ${match[1]} packages; there are ${packages().length}`,
  );
});

/**
 * The costs a README quotes are the floors the gate measures.
 *
 * Each package README states what it adds over core, and every one of them had drifted. The number
 * is derived here from the same object the size gate asserts against, so a floor that moves makes
 * this fail and names the README to correct — rather than the README quietly describing a build
 * from four releases ago.
 */
const QUOTED = {
  core: { fixture: 'core-only', over: null },
  audio: { fixture: 'core-and-audio', over: 'core-only' },
  animation: { fixture: 'core-and-animation', over: 'core-only' },
  assets: { fixture: 'core-and-assets', over: 'core-only' },
  splats: { fixture: 'core-and-splats', over: 'core-only' },
  terrain: { fixture: 'core-and-terrain', over: 'core-only' },
  ui2d: { fixture: 'core-and-ui2d', over: 'core-only' },
  script: { fixture: 'core-and-script', over: 'core-only' },
  drft: { fixture: 'drft-only', over: null },
  physics: { fixture: 'physics-only', over: null },
  chemistry: { fixture: 'chemistry-only', over: null },
  /* Standalone, like physics and chemistry: it imports `Gizmo` as a value and the rest of core as a
     type, so a bundle of it does not carry the renderer. */
  editor: { fixture: 'editor-only', over: null },
  /* Standalone, and the one package whose *raw* size is the claim: no renderer in the graph. */
  network: { fixture: 'network-only', over: null },
};

export function quotedKb(dir) {
  const entry = QUOTED[dir];
  if (entry === undefined) return null;
  const bytes =
    entry.over === null ? FLOORS[entry.fixture] : FLOORS[entry.fixture] - FLOORS[entry.over];
  return (bytes / 1024).toFixed(1);
}

test('a README that quotes a size quotes the measured one', () => {
  const wrong = [];
  for (const pkg of packages()) {
    const expected = quotedKb(pkg.dir);
    if (expected === null || !existsSync(pkg.readme)) continue;
    const text = readFileSync(pkg.readme, 'utf8');
    if (!text.includes(`${expected} KB gzipped`)) {
      const found = /([0-9.]+) KB gzipped/.exec(text);
      wrong.push(`${pkg.dir}: says ${found?.[1] ?? 'nothing'}, measures ${expected}`);
    }
  }
  assert.deepEqual(wrong, [], `stale sizes:\n  ${wrong.join('\n  ')}`);
});

test('the sizes in the root README table are the measured ones too', () => {
  /*
   * The same assertion one level up, and it needs to be here rather than trusted: the table a
   * stranger reads first is the copy most likely to be left behind, because nobody editing a
   * package thinks to open it. Without this, correcting the package READMEs would simply move the
   * drift into the root.
   */
  const wrong = [];
  for (const pkg of packages()) {
    const expected = quotedKb(pkg.dir);
    if (expected === null) continue;
    const row = rootReadme
      .split('\n')
      .find((line) => line.startsWith('| [`') && line.includes(`${pkg.manifest.name}\`]`));
    if (row === undefined) {
      wrong.push(`${pkg.dir}: no row in the root table`);
      continue;
    }
    if (!row.includes(`${expected} KB`)) {
      wrong.push(
        `${pkg.dir}: root table says "${/([0-9.]+) KB/.exec(row)?.[1] ?? 'nothing'}", measures ${expected}`,
      );
    }
  }
  assert.deepEqual(wrong, [], `stale sizes in the root table:\n  ${wrong.join('\n  ')}`);
});

test('a README claims the size gate measures it only where a fixture exists', () => {
  /*
   * `media` said "measured by scripts/size-gate.test.mjs" and there is no media fixture. A claim to
   * be measured is worth less than no claim when nothing measures it: a reader takes the number on
   * trust precisely because the sentence says something checks it.
   */
  const wrong = [];
  for (const pkg of packages()) {
    if (!existsSync(pkg.readme)) continue;
    const text = readFileSync(pkg.readme, 'utf8');
    /* Quoting a size *and* citing the gate is the claim. Citing the gate alone is a reference —
       `driftscript` mentions it because a runtime-only fixture is what proves the compiler never
       reaches a browser, which is a fact about that gate rather than a measurement of this package. */
    if (
      /[0-9.]+ KB gzipped/.test(text) &&
      text.includes('size-gate.test.mjs') &&
      quotedKb(pkg.dir) === null
    ) {
      wrong.push(pkg.dir);
    }
  }
  assert.deepEqual(wrong, [], `claims to be size-gated with no fixture:\n  ${wrong.join('\n  ')}`);
});

/**
 * **A package that declared no `exports` before 3.51.0 must stay open, and that is a consumer
 * contract rather than a preference.**
 *
 * `exports` does not only route: it *closes* a package. Every path not declared stops resolving,
 * and nothing inside this repository can see that happen — a consumer reaches a deep path, the
 * workspace symlink resolves it, and only their build fails. 3.51.0 shipped exactly that and broke a
 * consumer on three paths it had always used: `core/package.json`, `core/CHANGELOG.json`, and a
 * module under `core/src/`.
 *
 * `"./*": "./*"` restores what the absence of `exports` used to give. `chemistry` and `script`
 * declared `exports` before 3.51.0 and were already closed, so widening them would hand out a
 * surface they never had.
 */
test('a package that was open stays open', () => {
  const WAS_CLOSED = new Set(['chemistry', 'script']);
  const closed = [];
  for (const dir of readdirSync(path.join(ROOT, 'packages'))) {
    if (WAS_CLOSED.has(dir)) continue;
    const manifest = path.join(ROOT, 'packages', dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    if (m.exports?.['./*'] !== './*') closed.push(dir);
  }
  assert.deepEqual(
    closed,
    [],
    `these declare exports without a "./*" passthrough, so every deep path a consumer uses stops ` +
      `resolving:\n  ${closed.join('\n  ')}`,
  );
});

/**
 * **Every public barrel opens with the licence line, and the compiler cannot be trusted to keep it.**
 *
 * Apache-2.0 section 4(d) asks that the NOTICE travel with a derivative work, and the copy a
 * consumer actually reads is the one in the code they bundle: `main` and the default `exports`
 * condition both resolve to `src/index.ts`, so the source barrel is the file that reaches their
 * build. The bang form is the comment a minifier keeps by default, which is what carries the line
 * through a bundler into a shipped game rather than losing it there.
 *
 * The emitted copy is a separate question, and `scripts/build.mjs` answers it: three of the
 * eighteen barrels lost every leading comment on the way through `tsc`, because a first statement
 * that is a re-export carries none with it. `animation`, `entities` and `physics` emitted a
 * `dist/index.js` with no licence and no description while the other fifteen kept both, and
 * nothing failed. The build stamps it back on. This test covers the source, which is the copy
 * no emit can drop.
 */
test('every public barrel carries the licence line', () => {
  const missing = [];
  for (const { dir } of packages()) {
    const barrel = path.join(PACKAGES, dir, 'src', 'index.ts');
    if (!existsSync(barrel)) continue;
    const first = readFileSync(barrel, 'utf8').split('\n', 1)[0];
    if (!first.startsWith('/*!') || !first.includes('Apache-2.0')) missing.push(dir);
  }
  assert.deepEqual(
    missing,
    [],
    `these barrels do not open with the licence line:\n  ${missing.join('\n  ')}`,
  );
});

/**
 * **And every manifest names the licence the LICENSE file actually carries.**
 *
 * A manifest saying `MIT` over an Apache-2.0 tree is not a cosmetic mismatch: it is the field every
 * automated licence scanner reads, and the one a company's policy check believes over the file
 * beside it. Eighteen manifests said `MIT` on the day the tree stopped being MIT, and a scanner
 * would have reported the whole engine permissively licensed under terms it no longer offers.
 */
test('every package declares the licence the tree carries', () => {
  const root = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.ok(root.includes('Apache License'), 'LICENSE is not the Apache licence');
  const wrong = packages()
    .filter(({ manifest }) => manifest.license !== 'Apache-2.0')
    .map(({ dir, manifest }) => `${dir} says ${manifest.license}`);
  assert.deepEqual(wrong, [], `these disagree with LICENSE:\n  ${wrong.join('\n  ')}`);
});
