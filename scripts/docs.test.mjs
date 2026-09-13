/**
 * Guards on the documentation set.
 *
 * These are here rather than in vitest because they are facts about the repository
 * rather than about the runtime, and `scripts/*.test.mjs` is where repository-shaped
 * checks already live. CI runs this suite on every push (`npm run test:scripts`).
 *
 * The doctrine: a document's claim that can drift must be asserted somewhere that
 * fails. Prose that went wrong is how a whole documentation set fell a major version
 * behind without anything noticing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
/*
 * Directories this walk must not descend into.
 *
 * **`.claude` is here because it holds git *worktrees*, which are whole checkouts of this
 * repository.** Walking one double-counts every file, and when the guard still had an exempt
 * directory it also moved them: a path under a worktree does not start where the exemption
 * expected, so the guard fired on the one directory that existed to be exempt. Nothing is
 * exempt now, but the double-count is reason enough on its own.
 */
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.superpowers',
  '.claude',
  // Build artifacts, not files that ship. `.vitest/summary.json` records absolute paths,
  // so it carries the machine's own home directory and a maintainer's name with it.
  '.vitest',
]);

/**
 * The archive directory that this exempted is gone, and so is the exemption. It held files that
 * were frozen on the way in and never edited again, so a reference inside one could not be
 * repaired; nothing in the tree is in that position now.
 */
const FROZEN = null;

/**
 * Directories whose whole subject is work not yet done. See `namesFuture`.
 *
 * The plan and spec directories that filled this are gone. What remains is matched by name
 * instead, which is the more durable half of the rule anyway.
 */
const FUTURE_DIRS = [];

/** Strategy documents, matched by name so the rule survives them being moved. */
const FUTURE_NAMES = new Set(['PRIORITY.md', 'ASSESSMENT.md', 'ROADMAP.md']);

export function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

export function repoFiles() {
  return walk(ROOT, (f) => /\.(md|ts|mjs)$/.test(f));
}

/**
 * Markdown with fenced blocks and indented code removed.
 *
 * A document name inside a fence is an example rather than a reference: the plan that
 * introduced this checker carries a deliberately broken one to prove the guard works.
 *
 * Scanned line by line rather than by one regular expression, because a plan quoting a
 * fence inside a fence opens with four backticks and closes with four, and a non-greedy
 * ```…``` match pairs the outer opener with the inner closer and desynchronises every
 * fence after it in the file. That is not hypothetical — it is what the first run of
 * this checker did.
 */
export function outsideFences(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const opener = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence !== null) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    if (/^ {4,}\S/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Whether this file is allowed to name a document that does not exist.
 *
 * A plan names the documents it intends to create — that is what a plan is — a spec names
 * what a design would add, and a roadmap names deliverables it is scheduling. Holding any
 * of them to "it must exist today" would mean no plan could be written before its own
 * output. The *link* form is still checked everywhere, because a broken clickable path is
 * a broken path whatever the document is.
 */
function namesFuture(file) {
  return FUTURE_DIRS.some((dir) => file.startsWith(dir)) || FUTURE_NAMES.has(path.basename(file));
}

/** Documents that exist and may be named from anywhere. */
function knownDocuments() {
  const names = new Set(
    walk(path.join(ROOT, 'docs'), (f) => f.endsWith('.md')).map((f) => path.basename(f)),
  );
  // The repository root carries README, AGENTS and CONTRIBUTING; scanned rather
  // than listed so a new one does not have to be remembered here.
  for (const entry of readdirSync(ROOT)) if (entry.endsWith('.md')) names.add(entry);
  /*
   * Documentation a package owns, which is a category `driftscript` created.
   *
   * The engine's documents live in `docs/` because they describe the engine. A package that may
   * one day be distributed on its own has to carry its own reference, or extraction leaves the
   * documentation behind — so `packages/driftscript/docs/LANGUAGE.md` is the language's, not this
   * repository's, and `docs/README.md`'s one-job-per-document rule is not violated because the
   * job is a different artefact's.
   *
   * Scanned rather than listed, for the reason the root scan gives: a name that has to be
   * remembered here is a name that will not be. The cost is that a stray `.md` inside a package
   * becomes nameable from anywhere; what would make it wrong is a package documenting the engine,
   * which the proper-noun guard and the capability map would both catch first.
   */
  for (const f of walk(path.join(ROOT, 'packages'), (f) => f.endsWith('.md'))) {
    names.add(path.basename(f));
  }
  /*
   * A demo's own notes, which is a category the voxel sandbox created.
   *
   * `demo/voxelSandbox/GAPS.md` records what that port could not reach through the public
   * surface, and the modules that hit each gap say so in a comment beside the workaround — which
   * is the only place a reader of the workaround will look. Scanned rather than listed, for the
   * reason the root scan gives.
   */
  for (const f of walk(path.join(ROOT, 'demo'), (f) => f.endsWith('.md'))) {
    names.add(path.basename(f));
  }
  names.add('CHANGELOG.json');
  return names;
}

/**
 * Every `SOMETHING.md` named anywhere in the repository resolves to a real file.
 *
 * Two forms are checked because the repository uses both: a markdown link
 * `[text](path/to/DOC.md)`, and a bare mention in prose or in a source comment,
 * which is how `src/asset/*.ts` refers to the format specification.
 */
test('every document named in the repository exists', () => {
  const docs = knownDocuments();

  const broken = [];
  for (const file of repoFiles()) {
    // This file necessarily contains example document names in the comments that
    // explain what it matches.
    if (file === import.meta.filename) continue;
    if (FROZEN !== null && file.startsWith(FROZEN)) continue;

    const raw = readFileSync(file, 'utf8');
    const text = file.endsWith('.md') ? outsideFences(raw) : raw;
    const rel = path.relative(ROOT, file);

    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) broken.push(`${rel} -> ${target} (link)`);
    }

    if (namesFuture(file)) continue;
    // Not `\b` on the left: a dated archive name such as `2026-08-20-STATUS.md` would then
    // match at `STATUS.md`, because a hyphen is not a word character, and report a document
    // that is genuinely there under its full name.
    for (const [, name] of text.matchAll(/(?<![-\w])([A-Z][A-Za-z0-9_-]*\.md)\b/g)) {
      if (!docs.has(name)) broken.push(`${rel} -> ${name} (mention)`);
    }
  }

  assert.deepEqual(broken, [], `documents named but not found:\n${broken.join('\n')}`);
});

/** Source with comments removed, so a word in prose is not read as a symbol. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function sentinels() {
  const doc = readFileSync(path.join(ROOT, 'docs', 'CAPABILITIES.md'), 'utf8');
  const block = doc.match(/```sentinels\n([\s\S]*?)```/);
  assert.ok(block, 'CAPABILITIES.md must carry a ```sentinels block');
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(/\s+/);
      return { name, pattern: new RegExp(rest.join(' ')) };
    });
}

/**
 * Every capability CAPABILITIES.md calls absent is still absent.
 *
 * This is the guard that stops the document going quietly wrong. It fails on the day
 * the capability is built, which is exactly the day the document needs editing.
 */
test('every absent capability is still absent', () => {
  const sources = walk(
    path.join(ROOT, 'packages'),
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  ).map((f) => ({ rel: path.relative(ROOT, f), code: stripComments(readFileSync(f, 'utf8')) }));

  const arrived = [];
  for (const { name, pattern } of sentinels()) {
    const hit = sources.find((s) => pattern.test(s.code));
    if (hit) arrived.push(`${name} now exists (${hit.rel}) — correct CAPABILITIES.md`);
  }
  assert.deepEqual(arrived, [], arrived.join('\n'));
});

/**
 * The modules this host refuses: specified by the language, and described by nothing here.
 *
 * **This used to grep `packages/driftscript/src/registry/link.ts` for a map literal**, which was
 * the only option while that file was in this repository, and it was a fragile one: the pattern
 * once used `[a-z]` and silently dropped `drift/2d`, so the guard read its input wrongly and passed
 * anyway. Then `driftscript` exported the list and this read it.
 *
 * **In 1.7.0 the list stopped existing**, and the reason is worth carrying: it named one host's
 * unshipped tracks from inside the language, so it had to shrink every time this repository shipped
 * one — a language release standing between a track and the binding that ends it. What the language
 * exports now is `SPECIFIED_MODULES`, the surfaces it *designed*, built or not; whether anything
 * implements one is a question for a registry, and the registry here is this host's own.
 *
 * So the set is derived rather than read, from the two halves the linker itself uses. It corrects
 * itself the moment a binding lands, which is exactly what the assertions below want and what
 * neither list could do alone.
 */
async function refusedModules() {
  const { SPECIFIED_MODULES } = await import('driftscript/compiler');
  /*
   * Through the generated snapshot rather than by importing the host, because **this file is a
   * plain Node process and the host cannot be imported by one** — engine packages use extensionless
   * relative imports, which a bundler resolves and Node does not. That is the whole reason
   * `capabilities.json` exists, and `capabilities.test.mjs` is what keeps it current, so reading it
   * here is reading the registry through the only door Node has.
   */
  const snapshot = JSON.parse(
    readFileSync(path.join(ROOT, 'packages/script/capabilities.json'), 'utf8'),
  );
  const described = new Set(snapshot.capabilities.map((capability) => capability.module));
  return SPECIFIED_MODULES.filter((module) => !described.has(module));
}

/**
 * The four DriftScript refusals name modules the linker still refuses.
 *
 * **Two lists of what is missing, maintained separately, is how a project ends up advertising a
 * hole it filled.** `link.ts` tells a script author which track a module waits on;
 * `CAPABILITIES.md` tells a reader the same thing in prose. A binding that landed without both
 * being corrected leaves the linker sending authors away from a surface that works.
 *
 * The sentinel above catches the *symbol* arriving. This catches the two documents disagreeing
 * about which modules the sentinels are for, which the symbol check cannot see.
 */
test('the DriftScript refusals name modules the linker still refuses', async () => {
  const unshipped = new Set(await refusedModules());

  const named = sentinels()
    .filter((entry) => entry.name.startsWith('driftscript-'))
    .map((entry) => entry.name.slice('driftscript-'.length));

  /*
   * **Two, and the floor nearly emptied.** It existed so the list could not silently empty, and on
   * 2026-08-28 navigation and behaviour were both provided in one session, which left exactly one
   * refusal — `drift/network`, waiting on Track J. `drift/2d` joined it for a day on 2026-09-03 and
   * left again the same day: its provider existed and the language could not spell its name, which
   * DriftScript 1.11.0 fixed with an import alias. **That is the shortest a row has ever sat here,
   * and it is the mechanism working**: a refusal was recorded rather than papered over, and the
   * thing that resolved it was a release of the language rather than an edit to this list.
   *
   * **Track J then took the floor's only subject, on 2026-09-03**, and the honest answer was not to
   * lower the floor. `refusedModules()` still returns `drift/xr` and `drift/render` — two real
   * refusals waiting on real work, neither of which had ever carried a `driftscript-*` sentinel,
   * which is the defect the floor was detecting rather than a reason to relax it. Both are named
   * now and the floor stays where it is: an empty list means either every surface is bound or the
   * sentinels were deleted, and those want telling apart.
   *
   * `drift/core` is deliberately not among them and never will be — its provider is `startLoop`,
   * which *drives* a script rather than being called by one.
   */
  /*
   * **The floor is gone, because on 2026-09-05 the list legitimately emptied.** It read
   * `named.length >= 1` and existed so the set could not silently drain, and the comment above said
   * an empty list means either every surface is bound or the sentinels were deleted, and that those
   * want telling apart. Track I bound `drift/xr`, which was the last one, and every module the
   * language specifies is now described by this host.
   *
   * So the two are told apart by comparing them rather than by requiring one to be non-empty, which
   * is what the floor was standing in for while there was always something to point at. An empty
   * `named` beside a non-empty `unshipped` is a deleted sentinel and fails below; an empty
   * `unshipped` beside a non-empty `named` is a stale one and fails above. Both empty is the state
   * this engine is now in and is the only reading of it that is not a defect.
   */
  /* `drift/core` is excluded for the reason the note above gives: its provider is `startLoop`,
     which drives a script rather than being called by one, so it is specified, never described, and
     never a refusal anybody should act on. */
  assert.deepEqual(
    [...unshipped]
      .filter((module) => module !== 'drift/core')
      .filter((module) => !named.includes(module.slice('drift/'.length))),
    [],
    'the linker refuses a module CAPABILITIES.md carries no sentinel for — add one',
  );

  /* `entities` and `prefabs` were here until Track M shipped on 2026-08-26, `navigation` until it
     was provided on 2026-08-28, `networking` until Track J bound `drift/network` and
     `drift/rollback` on 2026-09-03, and `xr` until Track I bound the last of them on 2026-09-05. A
     name removed from this map is a refusal that ended; a name left in it after its module was
     bound is what the assertion below catches. */
  const modules = {};
  for (const name of named) {
    const module = modules[name];
    assert.ok(module, `no module is recorded for the \`driftscript-${name}\` sentinel`);
    assert.ok(
      unshipped.has(module),
      `CAPABILITIES.md calls ${module} unwired but link.ts no longer does — correct both`,
    );
  }
});

/**
 * The extraction still finds names where there are names.
 *
 * **Every assertion above compares two sets, and both are satisfied by an extraction that returns
 * nothing.** While there was always a refusal to point at, the floor covered that; there is none
 * now. So the parser is watched producing a value from a sample instead, and an empty answer about
 * the real document means an empty document rather than a broken reader. The AI manifest gate took
 * the same repair on the same day and for the same reason.
 */
test('the sentinel reader finds names where there are names', () => {
  const sample = ['alpha    Foo|Bar', 'beta     Baz'].join('\n');
  const parsed = sample
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  assert.deepEqual(parsed, ['alpha', 'beta']);

  /* And the real block parses to something, or every sentinel assertion in this file is vacuous. */
  assert.ok(sentinels().length > 4, 'no sentinels were extracted from CAPABILITIES.md');
});

/**
 * Every module the linker refuses is named in README's paragraph about them.
 *
 * **That paragraph said "two" while `link.ts` refused ten**, and it had the linker's own wording
 * for what the two lists mean, so the disagreement was not a matter of interpretation. The test
 * above asserts that a sentinel names a module still refused, which is one direction; this is the
 * other, and the one that was wrong: a module refused by the linker and absent from the public
 * document is a surface a script author is sent away from with no public record of why.
 *
 * The names rather than the count, because a count in prose is a claim that goes stale unread and
 * a list is a claim that cannot: adding a module to `UNSHIPPED` fails this until the paragraph
 * carries it, and removing one fails nothing, which is correct, since the public list may always
 * be shorter than the map.
 */
test('README names every DriftScript module the linker refuses', async () => {
  const refused = await refusedModules();
  /*
   * **The floor is gone here too, for the reason its neighbour's is.** It read `>= 2` so the list
   * could not silently drain while there was always something in it; Track I bound `drift/xr` on
   * 2026-09-05 and the list is now `drift/core` alone, which is specified, never described, and
   * never a refusal a script author acts on.
   *
   * What replaces it is the direction that was always the point: whatever the linker refuses has to
   * be named in the README. An empty list passes that trivially and correctly, and the extraction
   * behind it is watched producing a value in `the sentinel reader finds names where there are
   * names`.
   */

  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const unnamed = refused.filter((module) => !readme.includes(module));
  assert.deepEqual(
    unnamed,
    [],
    `the linker refuses ${unnamed.join(', ')} and README.md names neither the module nor the ` +
      'track it waits on',
  );
});

/**
 * Every text file a consumer receives, rather than the three extensions the documentation
 * set happens to use.
 *
 * `repoFiles()` walks `.md`, `.ts` and `.mjs`, which is the right set for the reference
 * checker above and the wrong one for this rule, because a name hides wherever text does.
 * That walk never opened the changelog the engine ships (`.json`), the Windows packaging
 * script (`.ps1`), or any `.mts` module — `\.ts$` does not match `.mts` — and six real
 * leaks sat in those gaps while this test was green. A guard that passes for the wrong
 * reason is worse than no guard, because it gets quoted as evidence that the rule holds.
 */
function scannableFiles() {
  return walk(ROOT, (f) =>
    /\.(md|markdown|ts|mts|cts|tsx|js|mjs|cjs|jsx|json|ps1|sh|bat|kts|gradle|swift|java|xml|html|css|wgsl|glsl|yml|yaml|toml|properties)$/.test(
      f,
    ),
  );
}

/**
 * The nouns that belong to one consumer rather than to the engine.
 *
 * **The list is not in this file, and that is the point.** A public repository whose guard names
 * the four nouns it forbids has published all four, which is the leak the guard exists to stop,
 * committed by the guard. `scripts/private-nouns.local.json` is gitignored and holds them.
 *
 * Absent, the guard is a no-op, and that is the right answer rather than a hole: a contributor
 * who has never seen those nouns cannot paste one. The risk is entirely on the side of whoever
 * has the other repositories open, and that is exactly who has the file.
 *
 * Case-insensitive, because the rule is about the noun and not about how it was typed. The
 * version this replaced was case-sensitive and let every lowercase spelling through: a global on
 * `window`, a URL host, a folder in an example path. Those are the ones that matter most, because
 * they are the ones a newcomer copies and runs.
 */
const NOUNS_FILE = path.join(ROOT, 'scripts', 'private-nouns.local.json');
const FORBIDDEN_NOUNS = existsSync(NOUNS_FILE)
  ? JSON.parse(readFileSync(NOUNS_FILE, 'utf8')).forbidden.map((n) => new RegExp(`\\b${n}\\b`, 'i'))
  : [];

/**
 * The one file that necessarily contains what the rule forbids: the list itself.
 *
 * This set used to hold `docs.test.mjs` and `demo/scenes.test.ts`, the two files that spelled the
 * nouns out in order to forbid them. Both read the gitignored list now, so neither needs an
 * exemption — but the scan walks the directory rather than the git index, so it reaches the
 * ignored list and reports it. Exempting the source of the patterns is not a hole: it is not a
 * file that ships, which is the whole property the rule is about.
 */
const STATES_THE_RULE = new Set([NOUNS_FILE]);

/**
 * No proper noun from a consumer's world appears anywhere in this repository.
 *
 * **There is no quarantine directory any more, and that is the change.** The rule used to be that
 * such documents stayed in a quarantine directory, with archived files and plans exempt because
 * they were frozen or recorded decisions about named consumers. All three directories are gone,
 * so the exemption has nothing left to cover and the rule is now the simpler one: nowhere, at all.
 *
 * `AGENTS.md` stated this from the beginning and relied on memory to keep it. The engine's
 * documents are quotable by anyone who ever uses it, and the failure mode is a single paste of a
 * proper noun into a file that ships.
 */
/**
 * No maintainer is named, and no private conversation is quoted, in a file that ships.
 *
 * **This is the rule the tree broke hardest.** Eight comments quoted a maintainer by name — the
 * requirement each recorded was real and worth keeping, but the wording was a private message and
 * the attribution was a person's name in shipped engine source. `CONTRIBUTING.md` already asked
 * contributors not to do exactly this, which is how long a rule lasts when nothing checks it.
 *
 * The nouns list above catches a consumer's proper nouns. This catches the other half: the people.
 * Both read the same gitignored file and both no-op without it.
 */
const PERSONAL_NAMES = existsSync(NOUNS_FILE)
  ? (JSON.parse(readFileSync(NOUNS_FILE, 'utf8')).personal ?? []).map(
      (n) => new RegExp(`\\b${n}\\b`, 'i'),
    )
  : [];

test('no maintainer is named in a file that ships', () => {
  const offences = [];
  for (const file of scannableFiles()) {
    if (STATES_THE_RULE.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const rule of PERSONAL_NAMES) {
      if (rule.test(text)) offences.push(`${path.relative(ROOT, file)} names ${rule}`);
    }
  }
  assert.deepEqual(offences, [], offences.join('\n'));
});

test('no proper noun from a consumer world appears anywhere', () => {
  const offences = [];
  for (const file of scannableFiles()) {
    if (STATES_THE_RULE.has(file)) continue;
    // Fences are not stripped here, unlike the reference checker above. A document name
    // inside a fence is an example; `--url=https://<a real site>/` inside a fence is a
    // command a reader pastes into a terminal, which is the leak this rule exists to stop.
    const text = readFileSync(file, 'utf8');
    for (const rule of FORBIDDEN_NOUNS) {
      if (rule.test(text)) offences.push(`${path.relative(ROOT, file)} contains ${rule}`);
    }
  }
  assert.deepEqual(offences, [], offences.join('\n'));
});

/**
 * The numbers CAPABILITIES.md quotes about the renderer are still the numbers.
 *
 * The document this replaced quoted `renderer.ts` at 3,574 lines and was 556 wrong within a
 * week, with nothing to notice. A line count in a document is a claim like any other, and
 * this one carries an argument: that the pass order is too large to keep holding by hand.
 */
test('the renderer line counts CAPABILITIES.md quotes are current', () => {
  const doc = readFileSync(path.join(ROOT, 'docs', 'CAPABILITIES.md'), 'utf8');
  let total = 0;
  for (const [file, key] of [
    ['packages/core/src/render/backend/webgl2/renderer.ts', 'renderer.ts'],
    ['packages/core/src/render/backend/webgpu/renderer.ts', 'webgpu/renderer.ts'],
  ]) {
    const actual = readFileSync(path.join(ROOT, file), 'utf8').split('\n').length - 1;
    const quoted = doc.match(
      new RegExp(`\`${key.replace('.', '\\.')}\`[^\\n]*?\\*\\*([\\d,]{3,})`),
    );
    assert.ok(quoted, `CAPABILITIES.md must quote a line count for ${key}`);
    assert.equal(
      Number(quoted[1].replace(/,/g, '')),
      actual,
      `${key} is ${actual} lines; CAPABILITIES.md says ${quoted[1]} — run \`npm run docs:counts\``,
    );
    total += actual;
  }

  /*
   * **And the number the sentence adds them up to**, which was not asserted and was therefore the
   * one that went stale: correcting a comment in one renderer moved its count, the two quoted
   * figures were updated, and the total three words later kept the old sum. A derived figure is a
   * claim exactly as much as a measured one, and this one is the claim the paragraph is making.
   */
  const sum = doc.match(/for ([\d,]{3,}) lines of pass order/);
  assert.ok(sum, 'CAPABILITIES.md must quote the two renderers added together');
  assert.equal(
    Number(sum[1].replace(/,/g, '')),
    total,
    `the two renderers are ${total} lines; CAPABILITIES.md says ${sum[1]} — run \`npm run docs:counts\``,
  );
});

/**
 * The test-file count CAPABILITIES.md quotes is still the count.
 *
 * The same argument the renderer line counts make, and the same history: the document said 141
 * files against 146 on disk, having drifted twice without anything noticing. A count in a
 * document is a claim, and this one is the evidence for the sentence it sits in.
 *
 * **Files and not tests.** A file is a thing this script can count without running anything; the
 * assertion count belongs to the character and pinning it here would mean a second, slower source
 * of truth for a number that moves every time a case is added.
 */
/**
 * The point-shadow filter cap `CAPABILITIES.md` quotes is the cap in the source.
 *
 * **It was prose, and it was prose about a number that had already moved once.** §3 named
 * `MAX_FILTER_RADIUS = 0.07` as a measured limit; the octahedral maps removed the reason for it
 * and the value changed, and nothing in the suite would have noticed the document going on
 * saying 0.07. That is exactly the drift the renderer line counts are asserted against, applied
 * to the other number §3 quotes.
 */
test('the point-shadow filter cap CAPABILITIES.md quotes is the one in the source', () => {
  const doc = readFileSync(path.join(ROOT, 'docs', 'CAPABILITIES.md'), 'utf8');
  const quoted = doc.match(/MAX_FILTER_RADIUS = ([0-9.]+)/);
  assert.ok(quoted, 'CAPABILITIES.md must quote the point-shadow filter cap');

  const source = readFileSync(
    path.join(ROOT, 'packages/core/src/render/shaders/flat/lobes.ts'),
    'utf8',
  );
  const actual = source.match(/const float MAX_FILTER_RADIUS = ([0-9.]+);/);
  assert.ok(actual, 'lobes.ts must declare MAX_FILTER_RADIUS');

  assert.equal(quoted[1], actual[1], `the cap is ${actual[1]}; CAPABILITIES.md says ${quoted[1]}`);
});

test('the test-file count CAPABILITIES.md quotes is current', () => {
  const doc = readFileSync(path.join(ROOT, 'docs', 'CAPABILITIES.md'), 'utf8');
  const quoted = doc.match(/([\d,]+) test files/);
  assert.ok(quoted, 'CAPABILITIES.md must quote a test-file count');

  let actual = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) actual += 1;
    }
  };
  for (const root of ['packages', 'demo']) walk(path.join(ROOT, root));

  assert.equal(
    Number(quoted[1].replace(/,/g, '')),
    actual,
    `there are ${actual} test files; CAPABILITIES.md says ${quoted[1]} — run \`npm run docs:counts\``,
  );
});

/**
 * The two versions CAPABILITIES.md opens with are the ones it kept getting wrong.
 *
 * Both are generated by `docs-counts.mjs` and neither was asserted, which is the weaker tier and
 * is why both drifted: generation only helps somebody who runs it, where an assertion fails for
 * somebody who did not. The container version went stale three times — 1.4 while the format was
 * at 1.5, then 1.5 while it went to 1.6 and 1.7 — and the engine version went stale the day after
 * Track A shipped, alone in a sentence whose other three claims had just been generated.
 *
 * Asserted together because they fail together: a release moves one, a container chunk moves the
 * other, and the sentence claiming the document is true is where both are read.
 */
test('the versions CAPABILITIES.md opens with are current', () => {
  const doc = readFileSync(path.join(ROOT, 'docs', 'CAPABILITIES.md'), 'utf8');

  const quotedEngine = doc.match(/True against engine (\d+\.\d+\.\d+)/);
  assert.ok(quotedEngine, 'CAPABILITIES.md must quote the engine version');
  const engine = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.equal(
    quotedEngine[1],
    engine,
    `the engine is ${engine}; CAPABILITIES.md says ${quotedEngine[1]} — run \`npm run docs:counts\``,
  );

  const quotedFormat = doc.match(/container format (\d+)\.(\d+)/);
  assert.ok(quotedFormat, 'CAPABILITIES.md must quote the container version');
  const format = readFileSync(path.join(ROOT, 'packages/drft/src/drftFormat.ts'), 'utf8');
  const major = format.match(/DRFT_VERSION_MAJOR = (\d+)/);
  const minor = format.match(/DRFT_VERSION_MINOR = (\d+)/);
  assert.ok(major && minor, 'drftFormat.ts must declare both container version parts');
  assert.equal(
    `${quotedFormat[1]}.${quotedFormat[2]}`,
    `${major[1]}.${minor[1]}`,
    `the container is ${major[1]}.${minor[1]}; CAPABILITIES.md says ` +
      `${quotedFormat[1]}.${quotedFormat[2]} — run \`npm run docs:counts\``,
  );
});

/**
 * README's public gap list agrees with CAPABILITIES.md.
 *
 * Two lists of what is missing, maintained separately, is how an engine ends up advertising a
 * hole it filled. The public list may be shorter and plainer than the map, but it may not name
 * something the map does not, because then the map is not the map.
 */
test('README names no gap the capability map does not', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const section = readme.match(/## What does not exist yet\n([\s\S]*?)\n## /);
  assert.ok(section, 'README.md must keep a "What does not exist yet" section');

  const names = sentinels().map((s) => s.name.replace(/-/g, ' '));
  const claimed = section[1]
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) =>
      l
        .replace(/^\s*-\s*/, '')
        .replace(/[;.]$/, '')
        .toLowerCase(),
    );

  /*
   * **Anchored at a word start rather than matched anywhere in the line.** A plain `includes`
   * treats `ai` as present in `chain` and `maintain`, so a sentinel with a short name could be
   * satisfied by a bullet that has nothing to do with it. The anchor is one-sided on purpose:
   * `collider` still has to match `colliders`, which a closing `\b` would refuse.
   */
  const backs = (bullet, name) =>
    bullet.includes(name) ||
    name
      .split(' ')
      .every((word) =>
        new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(bullet),
      );

  const unbacked = claimed.filter((c) => !names.some((n) => backs(c, n)));
  assert.deepEqual(
    unbacked,
    [],
    `README lists gaps CAPABILITIES.md does not:\n${unbacked.join('\n')}`,
  );

  /*
   * **And exactly one, which is the half that was missing.**
   *
   * The check above passes a bullet that names five capabilities while four of them are still
   * absent, so the one that shipped leaves the list unchanged and nothing fails. That is what
   * happened: the post-processing bullet read *depth of field, temporal aa, screen-space
   * reflection, colour grading, decals and order-independent transparency*, colour grading
   * shipped on 2026-08-27, and this guard stayed green because `temporal aa` still matched. It is
   * the same shape as a sentinel guarding two capabilities, which `ambisonics` did until it was
   * split, and as a sentinel naming a symbol nobody wrote, which hid skinned shadow casting for a
   * fortnight. A guard that can be satisfied by a neighbour is a guard with a blind spot.
   *
   * So a bullet answers to one sentinel and a sentinel is what makes a bullet removable.
   */
  const overlapping = claimed
    .map((c) => ({ claim: c, hits: names.filter((n) => backs(c, n)) }))
    .filter((row) => row.hits.length > 1)
    .map((row) => `"${row.claim.slice(0, 70)}" answers to ${row.hits.join(' and ')}`);
  assert.deepEqual(
    overlapping,
    [],
    'a bullet names more than one gap, so the day one of them ships this list will not notice:\n' +
      overlapping.join('\n'),
  );
});

/**
 * Every binding the documentation imports from an engine package is one that package exports.
 *
 * **The cheap check that was missing, found the expensive way.** The handbook told a consumer to
 * write `import { localiseNodes } from '@driftengine/assets'` for two releases; the barrel did not
 * export it, and the consumer reached the module by sub-path — the exception the rules reserve for
 * one library — because the documented import does not compile and nothing said so. A documented
 * import is a promise the type system can check in milliseconds, and this is where it gets checked.
 *
 * `docs/PORTING.md` is exempt by name and for one reason: a porting guide's whole job is to print
 * the import that stopped working, beside the one that replaced it. Every other document is
 * telling somebody what to write today.
 */
test('every import the docs print names something the package exports', () => {
  const barrels = new Map();
  const exportsOf = (pkg) => {
    if (barrels.has(pkg)) return barrels.get(pkg);
    const barrel = path.join(ROOT, 'packages', pkg, 'src', 'index.ts');
    assert.ok(existsSync(barrel), `docs import from @driftengine/${pkg}, which has no barrel`);
    const text = readFileSync(barrel, 'utf8');
    const names = new Set();
    for (const block of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of block[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name) names.add(name);
      }
    }
    for (const declared of text.matchAll(
      /export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
    )) {
      names.add(declared[1]);
    }
    barrels.set(pkg, names);
    return names;
  };

  const missing = [];
  for (const file of walk(ROOT, (f) => /\.md$/.test(f))) {
    if (path.basename(file) === 'PORTING.md') continue;
    for (const statement of readFileSync(file, 'utf8').matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@driftengine\/([a-z]+)'/g,
    )) {
      const pkg = statement[2];
      for (const part of statement[1].split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name && !exportsOf(pkg).has(name)) {
          missing.push(
            `${path.relative(ROOT, file)} imports ${name} from @driftengine/${pkg}, which does not export it`,
          );
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});
