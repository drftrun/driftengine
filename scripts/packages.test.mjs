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
import { execFileSync } from 'node:child_process';
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

/**
 * Every package rebuilds `dist/` before it is packed.
 *
 * **`dist/` is gitignored, so a tarball carries whatever was last built on the publishing
 * machine.** Nothing hooked the build to the publish and nothing compared the two, so 3.61.3 went
 * to the registry with `src/` carrying a fix and `dist/` carrying the bug it fixed — and `main`,
 * `types` and the default `exports` condition all resolve to `dist`, so every ordinary consumer
 * installed the defect under a version number that claimed to have cured it. It cannot be undone
 * either: a published version is immutable, so the answer was another release.
 *
 * **Invisible from inside the workspace, like the missing-files defect this sits beside.** A path
 * dependency resolves through a symlink into the tree, where `dist` is whatever the last local
 * build left; only an install from the registry can show it, and by then it is published.
 *
 * `prepack` rather than `prepublishOnly`, because npm runs it for `npm pack` too — so the tarball
 * a gate inspects is built the same way the tarball a consumer installs is.
 */
test('every package builds itself before it is packed', () => {
  const wrong = packages()
    .filter(
      (pkg) =>
        pkg.manifest.scripts?.prepack !== `node ../../scripts/build.mjs ${pkg.manifest.name}`,
    )
    .map((pkg) => `${pkg.manifest.name}: ${pkg.manifest.scripts?.prepack ?? '(none)'}`);
  assert.deepEqual(
    wrong,
    [],
    `packages that would pack a stale \`dist/\`:\n  ${wrong.join('\n  ')}`,
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
  /* A hyphen in the word, because every number word past twenty has one and `[A-Za-z]+` could
     never have matched "twenty-one" — the gate would have failed on the sentence being correct. */
  const match = /\*\*([A-Za-z-]+) packages, and a consumer takes only what it uses:\*\*/.exec(
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
    nineteen: 19,
    twenty: 20,
    'twenty-one': 21,
    'twenty-two': 22,
    'twenty-three': 23,
    'twenty-four': 24,
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
  /*
   * **The five packages of 4.0.0, added 2026-09-20 because this table had gone stale the way a
   * hand-written list of names always does here.** Each has a measured floor and each quotes it in
   * a README, and none of them was in this object — so three were quoting a number from the middle
   * of their own development with nothing to say so. `@driftengine/nav` said 6,336 against a real
   * 8,401 and `@driftengine/capture` said 38,796 against 66,373, which is not drift but a figure
   * from a package half built.
   *
   * **They also quote bytes rather than kilobytes**, which is the right unit at this size and is
   * why they slipped past: the assertion below looked for `KB gzipped` only, so a README with no
   * such string had nothing checked rather than something failing. It takes either now.
   */
  texture: { fixture: 'texture-only', over: null },
  nav: { fixture: 'nav-only', over: null },
  tools: { fixture: 'tools-only', over: null },
  capture: { fixture: 'capture-only', over: null },
};

/** The measured bytes a package's README may quote, or `null` where nothing measures it. */
export function quotedBytes(dir) {
  const entry = QUOTED[dir];
  if (entry === undefined) return null;
  return entry.over === null ? FLOORS[entry.fixture] : FLOORS[entry.fixture] - FLOORS[entry.over];
}

export function quotedKb(dir) {
  const bytes = quotedBytes(dir);
  return bytes === null ? null : (bytes / 1024).toFixed(1);
}

/** Both spellings of one measurement, so a README may choose the unit that suits its size. */
function sizeStrings(dir) {
  const bytes = quotedBytes(dir);
  if (bytes === null) return null;
  return { kb: `${(bytes / 1024).toFixed(1)} KB`, bytes: `${bytes.toLocaleString('en-US')} bytes` };
}

test('a README that quotes a size quotes the measured one', () => {
  const wrong = [];
  for (const pkg of packages()) {
    const expected = sizeStrings(pkg.dir);
    if (expected === null || !existsSync(pkg.readme)) continue;
    const text = readFileSync(pkg.readme, 'utf8');
    if (text.includes(`${expected.kb} gzipped`) || text.includes(`${expected.bytes} gzipped`)) {
      continue;
    }
    const found = /([0-9.,]+) (?:KB|bytes) gzipped/.exec(text);
    wrong.push(`${pkg.dir}: says ${found?.[1] ?? 'nothing'}, measures ${expected.bytes}`);
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
    const expected = sizeStrings(pkg.dir);
    if (expected === null) continue;
    const row = rootReadme
      .split('\n')
      .find((line) => line.startsWith('| [`') && line.includes(`${pkg.manifest.name}\`]`));
    if (row === undefined) {
      wrong.push(`${pkg.dir}: no row in the root table`);
      continue;
    }
    if (!row.includes(expected.kb) && !row.includes(expected.bytes)) {
      wrong.push(
        `${pkg.dir}: root table says "${/([0-9.,]+) (?:KB|bytes)/.exec(row)?.[1] ?? 'nothing'}", ` +
          `measures ${expected.bytes}`,
      );
    }
  }
  assert.deepEqual(wrong, [], `stale sizes in the root table:\n  ${wrong.join('\n  ')}`);
});

/**
 * Every package's cost, in the root table's own column.
 *
 * **The column exists because the prose did not work.** A size used to be a bolded phrase at the
 * end of whichever rows happened to have one, so four packages carried a number, nineteen did not,
 * and a reader could not tell "small" from "nobody measured it". Read as a table it looked like a
 * column somebody had forgotten to fill in, which is exactly what it was.
 *
 * Two packages have no browser payload to state and say so in words instead: `native-host` is a
 * Node process and `package` is a build tool, and a gzipped bundle size for either would be a
 * number with no meaning attached. Everything else is measured, which is what this asserts.
 */
const COLUMN = {
  core: { fixture: 'core-only' },
  drft: { fixture: 'drft-only' },
  texture: { fixture: 'texture-only' },
  nav: { fixture: 'nav-only' },
  tools: { fixture: 'tools-only' },
  capture: { fixture: 'capture-only' },
  xr: { fixture: 'xr-only' },
  physics: { fixture: 'physics-only' },
  entities: { fixture: 'entities-only' },
  network: { fixture: 'network-only' },
  editor: { fixture: 'editor-only' },
  chemistry: { fixture: 'chemistry-only' },
  ai: { fixture: 'ai-only' },
  media: { fixture: 'media-only' },
  audio: { fixture: 'core-and-audio', over: 'core-only' },
  animation: { fixture: 'core-and-animation', over: 'core-only' },
  assets: { fixture: 'core-and-assets', over: 'core-only' },
  splats: { fixture: 'core-and-splats', over: 'core-only' },
  terrain: { fixture: 'core-and-terrain', over: 'core-only' },
  ui2d: { fixture: 'core-and-ui2d', over: 'core-only' },
  script: { fixture: 'core-and-script', over: 'core-only' },
  'native-host': { words: 'a Node host' },
  package: { words: 'a build tool' },
};

test('the root README states a cost for every package, and it is the measured one', () => {
  const wrong = [];
  const names = packages().map((pkg) => pkg.dir);
  for (const name of names) {
    const entry = COLUMN[name];
    if (entry === undefined) {
      wrong.push(`${name}: no entry in COLUMN, so its cost is unstated`);
      continue;
    }
    const row = rootReadme
      .split('\n')
      .find((line) => line.startsWith('| [`') && line.includes(`@driftengine/${name}\`]`));
    if (row === undefined) {
      wrong.push(`${name}: no row in the root table`);
      continue;
    }
    const cells = row.split('|').map((cell) => cell.trim());
    const cost = cells[cells.length - 2];
    const want =
      entry.words !== undefined
        ? `**${entry.words}**`
        : `**${((FLOORS[entry.fixture] - (entry.over ? FLOORS[entry.over] : 0)) / 1024).toFixed(1)} KB${
            entry.over ? ' over core' : ''
          }**`;
    if (cost !== want) wrong.push(`${name}: column says ${cost || 'nothing'}, measures ${want}`);
  }
  assert.deepEqual(wrong, [], `the cost column is wrong:\n  ${wrong.join('\n  ')}`);
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
/**
 * **And every package actually carries the licence and notice its manifest promises.**
 *
 * `@driftengine/nav` shipped without either, for a day, with `files` naming both and nothing to
 * say otherwise. Every gate around it looked: the manifest declared `Apache-2.0`, the barrel
 * carried the banner, and the tracked-files gate above checks that what a package *tracks* reaches
 * the tarball — which says nothing about a file the package does not have. A `files` entry for a
 * file that does not exist is silent in npm and silent in git.
 *
 * What that would have published is a tarball claiming Apache-2.0 with no licence text in it and
 * no NOTICE, which section 4(d) requires to travel with the work. So the twenty-one copies are
 * compared to the root's byte for byte: a licence that has drifted is worse than one that is
 * missing, because nobody re-reads it.
 */
test('every package carries the licence files it promises', () => {
  const wanted = ['LICENSE', 'NOTICE'];
  const root = Object.fromEntries(
    wanted.map((name) => [name, readFileSync(path.join(ROOT, name), 'utf8')]),
  );
  const wrong = [];
  for (const { dir, manifest } of packages()) {
    for (const name of wanted) {
      const listed = (manifest.files ?? []).includes(name);
      const at = path.join(PACKAGES, dir, name);
      if (!existsSync(at)) {
        wrong.push(`${dir}/${name} is ${listed ? 'listed in files and ' : ''}not there`);
        continue;
      }
      if (!listed) wrong.push(`${dir}/${name} exists but files does not list it`);
      else if (readFileSync(at, 'utf8') !== root[name]) wrong.push(`${dir}/${name} differs`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    `these packages do not carry the licence they claim:\n  ${wrong.join('\n  ')}`,
  );
});

test('every package declares the licence the tree carries', () => {
  const root = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.ok(root.includes('Apache License'), 'LICENSE is not the Apache licence');
  const wrong = packages()
    .filter(({ manifest }) => manifest.license !== 'Apache-2.0')
    .map(({ dir, manifest }) => `${dir} says ${manifest.license}`);
  assert.deepEqual(wrong, [], `these disagree with LICENSE:\n  ${wrong.join('\n  ')}`);
});

/**
 * **Every file a package tracks reaches the tarball, unless it is a test or a build config.**
 *
 * This gate exists because three packages shipped broken and nothing noticed. `files` was rewritten
 * when these packages were prepared for the registry and it *replaced* each array rather than
 * extending it: `@driftengine/package` lost `bin/`, `assets/`, `android/` and `ios/`, so the
 * command its own `bin` field declares was not in the tarball; `@driftengine/script` lost
 * `capabilities.json`, which the DriftScript plugin resolves by package path; and
 * `packages/core/scripts/` had never shipped at all, though `AGENTS.md` documents importing
 * `@driftengine/core/scripts/browser.mjs` and a consumer does exactly that in eight files.
 *
 * **None of it was visible from inside the workspace.** A path dependency resolves through a
 * symlink into the tree, where every file exists whatever `files` says. The defect only appears
 * once somebody installs from the registry, which is the worst possible moment to find it.
 *
 * Excluded: tests, snapshots and TypeScript configs, which a consumer never reaches for.
 */
test('a package ships every file it tracks', () => {
  const SKIP = /(\.test\.(ts|mjs)$)|(__snapshots__\/)|(^tsconfig)|(\.tsbuildinfo$)/;
  const missing = [];
  for (const { dir } of packages()) {
    const root = path.join(PACKAGES, dir);
    const tracked = execFileSync('git', ['ls-files', root], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((f) => path.relative(root, path.join(ROOT, f)))
      .filter((f) => !SKIP.test(f) && f !== 'package.json');
    /*
     * **The JSON is sliced out rather than parsed whole, because `prepack` now writes to stdout
     * too.** Every package builds itself before it packs — see the test above for what a stale
     * `dist/` cost — and npm runs that script's output into the same stream as `--json`, so
     * `JSON.parse` on the lot fails with `Unexpected token '@'`. The document starts at the first
     * `[`, which is unambiguous: nothing the build prints contains one.
     */
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    const start = out.indexOf('[');
    assert.notEqual(start, -1, `npm pack printed no JSON for ${dir}:\n${out}`);
    const packed = new Set(JSON.parse(out.slice(start))[0].files.map((f) => f.path));
    for (const f of tracked) if (!packed.has(f)) missing.push(`${dir}: ${f}`);
  }
  assert.deepEqual(
    missing,
    [],
    `these files are tracked but would not reach a consumer:\n  ${missing.join('\n  ')}`,
  );
});

/**
 * Every workspace declares the licence, and the root does too.
 *
 * **The three licence gates above read `packages/` and nothing else**, so the root manifest and the
 * `editor` workspace were outside all of them: the root carried no `license` field at all, and
 * `editor` declared `Apache-2.0` while carrying neither `LICENSE` nor `NOTICE`. Neither publishes —
 * both are `private` — but the root manifest is the first file an automated scanner reads, and a
 * tree whose front door says nothing about its licence is one a policy check will guess about.
 *
 * **This is the same blind spot `AGENTS.md` describes finding in `scripts/version.test.mjs`**, in a
 * second instrument: a gate that walks `packages/*` is a gate that cannot see a workspace added
 * anywhere else, and `editor` had been one for as long as it existed. So this walks `workspaces`
 * from the root manifest, the way the version count does now, and the next workspace is covered
 * the day it is added rather than the day somebody notices.
 */
function workspaceManifests() {
  const root = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dirs = ['.'];
  for (const pattern of root.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      dirs.push(pattern);
      continue;
    }
    const base = pattern.slice(0, -2);
    for (const entry of readdirSync(path.join(ROOT, base), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${base}/${entry.name}`);
    }
  }
  return dirs
    .filter((dir) => existsSync(path.join(ROOT, dir, 'package.json')))
    .map((dir) => ({
      dir,
      manifest: JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8')),
    }));
}

test('EVERY WORKSPACE AND THE ROOT DECLARE THE LICENCE THE TREE CARRIES', () => {
  const wrong = workspaceManifests()
    .filter(({ manifest }) => manifest.license !== 'Apache-2.0')
    .map(({ dir, manifest }) => `${dir} says ${manifest.license ?? 'nothing at all'}`);
  assert.deepEqual(wrong, [], `these do not declare Apache-2.0:\n  ${wrong.join('\n  ')}`);
});

test('every workspace carries the licence text, whether or not it publishes', () => {
  /*
   * **A private workspace is distributed too** — as part of this repository, which is where anybody
   * reads it. `packages/*` carry `LICENSE` and `NOTICE` because their tarballs must; `editor`
   * carries them because a directory declaring a licence and holding no copy of it is a claim with
   * nothing behind it.
   */
  const root = Object.fromEntries(
    ['LICENSE', 'NOTICE'].map((name) => [name, readFileSync(path.join(ROOT, name), 'utf8')]),
  );
  const wrong = [];
  for (const { dir } of workspaceManifests()) {
    if (dir === '.') continue;
    for (const [name, text] of Object.entries(root)) {
      const at = path.join(ROOT, dir, name);
      if (!existsSync(at)) wrong.push(`${dir}/${name} is not there`);
      else if (readFileSync(at, 'utf8') !== text)
        wrong.push(`${dir}/${name} differs from the root`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    `these do not carry the licence they declare:\n  ${wrong.join('\n  ')}`,
  );
});

/**
 * The third-party files this repository actually commits carry their licences.
 *
 * **`CREDITS.md` states the obligation and the tree did not meet it.** Two SDF font atlases are
 * force-added past `.gitignore` and are, in that document's own words, "the only third-party-derived
 * files actually committed to this tree": DejaVu Sans under the Bitstream Vera License, where "the
 * licence text must travel with it", and Noto Sans Arabic under the SIL Open Font License 1.1,
 * which "requires the copyright notice and licence to accompany them". Neither text was anywhere in
 * the repository — `CREDITS.md` named both licences and the tree carried neither.
 *
 * A rasterised, distance-transformed atlas is a derivative of the original outlines, so
 * distributing this repository distributes them. Pointing at `/usr/share/doc/...` is a path on one
 * Debian machine, and a URL is a promise about somebody else's server.
 */
test('A COMMITTED THIRD-PARTY ASSET CARRIES ITS OWN LICENCE TEXT', () => {
  const fonts = path.join(ROOT, 'demo', 'dev', 'public', 'fonts');
  if (!existsSync(fonts)) return;
  const wanted = [
    ['latin', 'LICENSE-DejaVu.txt', 'Bitstream Vera'],
    ['arabic-run', 'LICENSE-NotoSansArabic.txt', 'SIL OPEN FONT LICENSE'],
  ];
  const wrong = [];
  for (const [dir, file, marker] of wanted) {
    if (!existsSync(path.join(fonts, dir, 'atlas.png'))) continue;
    const at = path.join(fonts, dir, file);
    if (!existsSync(at)) wrong.push(`${dir}/${file} is not there`);
    else if (!readFileSync(at, 'utf8').toUpperCase().includes(marker.toUpperCase())) {
      wrong.push(`${dir}/${file} does not contain "${marker}"`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    `these committed atlases have no licence beside them:\n  ${wrong.join('\n  ')}`,
  );
});
