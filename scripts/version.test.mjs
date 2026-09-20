/*
 * One version, in twenty-two places, and nothing was checking that they agreed.
 *
 * A release moves `version` in fourteen manifests and the twenty internal `@driftengine/*` ranges that
 * pin the packages to each other, plus `package-lock.json`.
 *
 * **This header said sixteen, seven and nine until 2026-08-25**, having been written when that was
 * true and left alone while the floors below it were raised twice underneath. That is the drift
 * `AGENTS.md` describes, occurring inside the test written to catch it: a floor passes at the true
 * number and at the stale one, so nothing fails while the prose rots. Correct this paragraph in the
 * commit that raises a floor, or the next reader inherits the same lie.*/
/* Miss one of the ranges and nothing here fails: every package is
 * a workspace link, so `npm test` and `npm run typecheck` are perfectly green locally. What breaks
 * is `npm install` on a machine with no workspace already built — a consumer's CI — where npm reads
 * a range no local package satisfies, goes to the registry for it, and gets a 404, because none of
 * these is published.
 *
 * That is exactly how 2.4.1 shipped: every manifest bumped, every range left at 2.4.0, green
 * everywhere it was run and red the first time anybody installed it. The failure names the
 * registry rather than the bump, so it reads as an infrastructure problem.
 *
 * `AGENTS.md` already carries the neighbouring rule — a version bump is `package.json` and
 * `CHANGELOG.json` together — and says of it that *this package has no test of its own that
 * checks the pair; the consumer does*. It has one now, and it covers both halves, because a rule
 * held by memory is held until the day somebody is doing something else at the same time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

/**
 * Every manifest a release has to move: the workspace root and **every workspace it declares**.
 *
 * **It read `packages/` alone until 2026-09-20, and `editor` is a workspace too.** That manifest
 * carries a version and seven `@driftengine/*` ranges pinned exactly, and not one of them was
 * counted here, quoted in `AGENTS.md`, or checked by any test — so a release that moved the
 * eighty-four places this file knew about would leave the editor asking the registry for an
 * engine version that has never been published, which is the exact failure the paragraph in
 * `AGENTS.md` opens by describing. Read from `workspaces` rather than from a list, so the next
 * workspace anybody adds is counted the day it is added.
 */
function manifests() {
  const out = ['package.json'];
  for (const pattern of read('package.json').workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      out.push(`${pattern}/package.json`);
      continue;
    }
    const dir = pattern.slice(0, -2);
    const found = readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}/package.json`);
    out.push(...found.sort());
  }
  return out;
}

const RANGE_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * The language is a published dependency, not a second version line in here.
 *
 * **This used to split the manifests into two lines and assert both.** `driftscript` and
 * `driftscript-language` were vendored packages that had to be kept off the engine's number,
 * because an engine patch announcing a language change that did not occur is the failure the split
 * existed to prevent.
 *
 * They are published now, at a version this repository pins and does not own, so what is left is
 * an ordinary external dependency and the check changes character with it. Two things still have to
 * hold, and neither is about the engine's number:
 *
 * **The pins agree with each other.** Three manifests name `driftscript`, and a partial bump
 * resolves two copies of the language into one tree — at which point `@driftengine/entities` and
 * `@driftengine/script` disagree about what a `Schema` is, silently, because both compile.
 *
 * **The pin does not move with an engine release.** That is the original rule surviving its own
 * mechanism: a release script that bumped every version it found would drag the language's number
 * along and pin a version nobody published.
 */
const LANGUAGE = 'driftscript';

test('every engine manifest carries the workspace version', () => {
  const root = read('package.json').version;
  assert.match(root, /^\d+\.\d+\.\d+$/, 'the root version is not a release version');

  const engine = manifests().map((path) => [path, read(path)]);
  for (const [path, manifest] of engine) {
    assert.equal(
      manifest.version,
      root,
      `${path} is ${manifest.version} where the workspace is ${root}`,
    );
  }

  /* Ten today — the workspace root and nine packages. Nine until `@driftengine/entities` landed
     on 2026-08-26, eight until `@driftengine/splats` on 2026-08-25, and seven before that. Asserted so that a package added without a version is a
     failure rather than a silent omission from the very check that exists to catch omissions —
     and *raised* with each one, because a floor left behind passes at the true number and at the
     stale one, which is how the prose in `AGENTS.md` drifted underneath this test for a whole
     major version.

     **The second count this used to carry is gone with the second line.** It existed because a
     package filed on the wrong line left one number right and the other wrong, and there is only
     one line now. What replaced it is the range check below, which is where an external pin can
     still go wrong. */
  /*
   * **Raised 2026-08-26 to 13 and 20, and both were stale by more than this commit adds.**
   *
   * Counted rather than read: the floors stood at 11 and 16 against an actual 12 and 19, so one
   * manifest and three ranges had landed underneath them without failing anything. That is the drift
   * this file's own header describes, occurring inside the test written to catch it, for the fourth
   * recorded time — and it is exactly why a floor is the wrong instrument on its own: it passes at
   * the true number and at every stale one below it.
   *
   * `@driftengine/physics` is one manifest and one range on top of the true figures, so a release is
   * thirteen manifests, twenty ranges and the lockfile: **thirty-four places**, not the twenty-eight
   * `AGENTS.md` said until this commit.
   *
   * **Raised again 2026-08-26 to 14, by `@driftengine/chemistry`.** One manifest and no range:
   * nothing depends on it, because it imports no other engine package and no other package imports
   * it. So a release was fourteen manifests, twenty ranges and the lockfile: **thirty-five places**.
   *
   * **And the range half went stale the next day**, when CH-8 bound `drift/chemistry` and
   * `@driftengine/script` grew a peer range for it. Twenty-one now, and thirty-six places — see the
   * note on the range floor below for why a range is the harder half to notice.
   *
   * That commit also corrected an off-by-one in `AGENTS.md` that had nothing to do with it.
   * "Thirteen engine packages plus the two on the language's own version line" described fifteen
   * directories where fourteen existed, because the sentence had conflated the manifest count, which
   * includes the workspace root, with the package count, which does not. Adding a package is what
   * made it true — which is the worst way for a wrong number to be corrected, and the reason it is
   * written down here rather than quietly left right.
   *
   * **Raised again 2026-09-03 to 15, by `@driftengine/terrain`, and this is the sixth time.** Track L
   * shipped that package in 3.38.0 and raised neither floor, so a whole release ran with both stale —
   * which is precisely the behaviour the paragraph above predicts and the reason it is written down
   * every time rather than quietly corrected: **a floor passes at the true number and at every stale
   * one below it**, so nothing failed and nothing could have. It was found by running the snippet in
   * `AGENTS.md` rather than by reading it, which is what that snippet says to do. A release is
   * fifteen manifests, twenty-four ranges and the lockfile: **forty places**.
   *
   * **Raised to 16 the same day, by `@driftengine/ui2d`.** Two packages in one session is the shape
   * this floor keeps failing at: only the commit that adds one is looking at this line, and the
   * second one shipped an hour after the first.
   *
   * A release is now sixteen manifests, twenty-six ranges and the lockfile: **forty-three places**.
   *
   * **Raised to 18 on 2026-09-03, by `@driftengine/network`, and this is the eighth time.** One
   * manifest and *three* ranges: its own peer on `@driftengine/entities`, its devDependency on
   * `@driftengine/core` — test-only, and exactly the kind of entry an eye count skips because it is
   * not where anybody looks for a version — and `@driftengine/script`'s peer on it. Eighteen
   * manifests, thirty-three ranges and the lockfile: **fifty-two places**.
   *
   * **Raised to 17 the same day, by `@driftengine/editor`, which was the seventh time.** One
   * manifest and *four* ranges — its own three peers on core, entities and ui2d, and
   * `@driftengine/script`'s peer on it — so a release is now **seventeen manifests, thirty ranges and
   * the lockfile: forty-eight places**. The fourth range is the half that is invisible by eye, which
   * is the finding this paragraph has recorded twice already: the commit that adds a *peer* is as much
   * a correction to this number as the commit that adds a package.
   */
  /*
   * **Raised to 23 on 2026-09-19, by `@driftengine/native-host`, and this is the ninth time — with
   * the floor stale by four before this commit added one.** `nav`, `texture`, `tools` and `xr` had
   * each landed a manifest underneath 18 without failing anything, so the tree stood at twenty-two
   * when the native host made it twenty-three. Found, again, by running the snippet in `AGENTS.md`.
   */
  /*
   * **Raised to 24 on 2026-09-19, by `@driftengine/capture`, at the commit that created it** — the
   * first package in four to move this floor in the same commit, because the snippet was run first.
   */
  /*
   * **Raised to 25 on 2026-09-20 by a workspace that had always been there.** `editor` is the
   * editor application, declared in `workspaces` beside `packages/*` and never walked by this
   * file — see `manifests()`. Nothing was added to the tree; what changed is that the count is
   * now taken from what a release actually has to move.
   */
  assert.ok(engine.length >= 25, `only ${engine.length} engine manifests found`);
});

test('every engine range pins the workspace version, and the language pin agrees with itself', () => {
  const version = read('package.json').version;

  let engineRanges = 0;
  const languagePins = [];

  for (const path of manifests()) {
    const manifest = read(path);
    for (const field of RANGE_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith('@driftengine/')) {
          engineRanges++;
          assert.equal(
            range,
            version,
            `${path} ${field} pins ${name} at ${range} where the workspace is ${version}. ` +
              'npm resolves that from the registry, which has none of these.',
          );
          continue;
        }
        if (name === LANGUAGE) languagePins.push({ path, field, range });
      }
    }
  }

  /*
   * **Raised 2026-08-27 to 21**, by the `@driftengine/chemistry` peer range `@driftengine/script`
   * grew when Track P's CH-8 bound `drift/chemistry`. A *range* added without a package is the
   * shape of drift this floor is worst at: nothing new appears in `packages/`, so nobody counting by
   * eye sees it, and the floor passes at twenty and at twenty-one alike.
   *
   * So a release is fourteen manifests, twenty-one ranges and the lockfile: **thirty-six places**.
   *
   * **Raised 2026-09-03 to 24**, by `@driftengine/terrain`: one manifest and *three* ranges, since
   * the package depends on core and both the workspace root and another package came to name it.
   * Left behind for the whole of 3.38.0 — see the manifest floor above, which went stale in the
   * same commit and for the same reason.
   *
   * So a release is fifteen manifests, twenty-four ranges and the lockfile: **forty places**.
   *
   * **Raised to 26 the same day**, by `@driftengine/ui2d`: one manifest and *two* ranges — its own
   * peer on core, and `@driftengine/script`'s peer on it when Track F bound `drift/ui`. The second
   * is the invisible half again: nothing new appears in `packages/` for it, because it is a line
   * added to a manifest that was already there.
   *
   * So a release is sixteen manifests, twenty-six ranges and the lockfile: **forty-three places**.
   */
  /*
   * **Raised to 53 on 2026-09-19, by `@driftengine/native-host`, from 33 — fifteen of the difference
   * landed before it.** The host brings five: its peers on core, the packager, texture and ui2d, and
   * a devDependency on audio for a test. The packager names no range on it, and that is the build
   * order rather than an omission: the host depends on the packager, so a range back would be a
   * cycle, and the packager resolves the host from the game's own tree as it does `steamworks.js`,
   * refusing one at another version. The other fifteen came in with `nav`, `texture`, `tools`, `xr`
   * and the peers others grew on them, and passed a floor of 33 at forty-eight exactly as this file
   * says a floor will.
   *
   * So a release is twenty-three manifests, fifty-three ranges and the lockfile: **seventy-seven
   * places**.
   */
  /*
   * **Raised to 55 the same day, by `@driftengine/capture`'s two peers**, on core and texture. So a
   * release is twenty-four manifests, fifty-five ranges and the lockfile: **eighty places**.
   *
   * **Then to 59, as that package grew four more peers** — drft, nav, physics and splats — one per
   * task that needed one, each raised with the commit that added it. Twenty-four manifests,
   * fifty-nine ranges and the lockfile: **eighty-four places**.
   *
   * **Raised to 60 on 2026-09-20, by a *devDependency*: `@driftengine/drft` on
   * `@driftengine/entities`.** The container carries a scene in `ENTS` and must not depend on the
   * entity model to do it — the types agree structurally, which is the same arrangement `DTEX` has
   * with `@driftengine/texture`, and a rule that cannot be shared as code is shared as a test. So
   * the range exists for that test and for nothing at run time. **It is the fourth time a range
   * arrived with no new package in `packages/`**, and the second time the field was one nobody
   * scans. Twenty-four manifests, sixty ranges and the lockfile: **eighty-five places**.
   */
  /*
   * **Raised to 67 the same day, by the same widening**: the editor application's ranges, pinned
   * exactly at the workspace's version and uncounted — so twenty-five manifests, sixty-seven
   * ranges and the lockfile: **ninety-three places**.
   *
   * **That sentence said "seven ranges" and named seven packages, and the manifest carries nine**
   * — `@driftengine/capture` and `@driftengine/drft` were left out of the list while the total
   * above them was right. Worth keeping as the smallest version of this file's subject: a number
   * that is counted stays true and a list written out beside it goes stale on its own, because
   * nothing reads the list. Counted 2026-09-20: capture, core, drft, editor, entities, network,
   * texture, tools, ui2d.
   */
  /*
   * **Raised to 69 on 2026-09-20, and this time by the release itself rather than by a commit that
   * added something.** The snippet was run before bumping 4.0.0, as the rule says to, and answered
   * two ranges more than the paragraph in `AGENTS.md` claimed — a twelfth staleness, found by
   * counting rather than by anything going red. Twenty-five manifests, sixty-nine ranges and the
   * lockfile: **ninety-five places**.
   *
   * **The lockfile is what confirmed it independently.** Bumping every place and regenerating gave
   * a diff of ninety-six insertions against ninety-five deletions: ninety-five versions moved, and
   * one `license` field the root manifest had gained earlier. A count that agrees with itself from
   * two directions is the only kind this paragraph has ever been able to trust.
   */
  assert.ok(engineRanges >= 69, `only ${engineRanges} engine ranges found`);

  /*
   * The language pins, which are now pins on a published package.
   *
   * Three of them: the workspace root, because `scripts/capabilities.ts` imports `serializeRegistry`
   * and a package that imports something declares it; `@driftengine/script`, which describes this
   * engine to the language; and `@driftengine/entities`, which takes `Schema` and `migrate` — 406
   * bytes gzipped — because one description of a component is the spine of the entity model and a
   * second one can drift from it.
   *
   * **They have to agree with each other**, and the reason is sharper than tidiness. npm will
   * happily resolve two versions of `driftscript` into one tree if two manifests disagree, and then
   * `@driftengine/entities` and `@driftengine/script` are compiling against different definitions of
   * the same type. Both succeed. Nothing fails until a component round-trips through storage and
   * comes back not equal to itself.
   */
  assert.ok(languagePins.length >= 3, `only ${languagePins.length} \`${LANGUAGE}\` pins found`);

  const pinned = languagePins[0].range;
  assert.match(
    pinned,
    /^\d+\.\d+\.\d+$/,
    `\`${LANGUAGE}\` is pinned at "${pinned}", not an exact version`,
  );
  for (const { path, field, range } of languagePins) {
    assert.equal(
      range,
      pinned,
      `${path} ${field} pins ${LANGUAGE} at ${range} where the rest pin ${pinned}. ` +
        'npm resolves both, and the entity model and the host then disagree about what a Schema is.',
    );
  }

  /*
   * **And it does not move with an engine release.** The original two-line rule, surviving the
   * mechanism that enforced it: a release that bumped every version it found would drag the
   * language's along and pin something nobody published. An exact pin rather than a caret is
   * deliberate — `driftscript` and `driftscript-language` ship as one release in a fixed order, and
   * the agreement between the compiler and the language server is the property that buys.
   */
  assert.notEqual(
    pinned,
    version,
    `\`${LANGUAGE}\` is pinned at the workspace version. It is a published dependency on its own ` +
      'release line; an engine release does not move it.',
  );

  /* The installed tree is what a build actually reads, so the pin is checked against it rather than
     trusted. A pin nothing installed is a pin npm quietly resolved to something else. */
  const installed = read('node_modules/' + LANGUAGE + '/package.json').version;
  assert.equal(
    installed,
    pinned,
    `${LANGUAGE} is pinned at ${pinned} and installed at ${installed}. Run \`npm install\`.`,
  );
});

test('the lockfile moved with the manifests', () => {
  /*
   * **The nineteenth place, and it had been stale since 2.10.0.** Every release from then to
   * 3.3.0 moved the eight manifests and the ten ranges and left `package-lock.json` behind, and
   * nothing here noticed: every local command reads `node_modules` rather than the lockfile, and
   * `npm ci` tolerates a workspace whose recorded version is old.
   *
   * What it does not tolerate is a workspace it has never heard of, so adding a package turned
   * five releases of quiet drift into a red CI on the release commit — reported as a missing
   * package rather than as a lockfile. `npm install --package-lock-only` writes it.
   *
   * Both halves are asserted, because they fail differently: a stale *version* is invisible until
   * somebody reads the file, and a missing *workspace entry* is what actually stops `npm ci`.
   */
  const version = read('package.json').version;
  const lock = read('package-lock.json');
  assert.equal(
    lock.version,
    version,
    `package-lock.json is ${lock.version} where the workspace is ${version}. ` +
      'Run `npm install --package-lock-only` and commit it.',
  );
  assert.equal(lock.packages?.['']?.version, version, 'the lockfile root entry is stale');

  /*
   * Each workspace is checked against *its own* line's version.
   *
   * The missing-entry half is unchanged and is the half that actually stops `npm ci`; the version
   * half now asks which line the package is on, because `driftscript` at the engine's number
   * would be the drift this file exists to prevent, recorded in the lockfile as though it were
   * correct.
   */
  /* Every workspace is on the engine's line now, so the expected version is the same for all of
     them. This used to build a map because two lines meant two answers. */
  const expected = new Map(manifests().map((path) => [path, version]));

  for (const path of manifests()) {
    if (path === 'package.json') continue;
    const dir = path.replace('/package.json', '');
    assert.ok(
      lock.packages?.[dir] !== undefined,
      `${dir} is a workspace with no entry in package-lock.json, so \`npm ci\` cannot resolve it. ` +
        'Run `npm install --package-lock-only` and commit it.',
    );
    const want = expected.get(path);
    assert.equal(
      lock.packages[dir].version,
      want,
      `package-lock.json has ${dir} at ${lock.packages[dir].version} where its line is ${want}`,
    );
  }
});

test('the version and the changelog moved together', () => {
  const version = read('package.json').version;
  const releases = read('packages/core/CHANGELOG.json');
  assert.ok(Array.isArray(releases) && releases.length > 0, 'the changelog is empty');
  assert.equal(
    releases[0].version,
    version,
    `the changelog's newest release is ${releases[0].version} and the package is ${version}`,
  );
  assert.match(releases[0].date, /^\d{4}-\d{2}-\d{2}$/, 'a release needs a date');
  assert.ok(releases[0].entries.length > 0, `${version} has no entries`);
});

/*
 * The consumer's rule, brought back to where the data is.
 *
 * `short` is what a running application shows in a menu and `text` is what the public release
 * pages carry. The game's own suite has asserted this since the field existed, which means the
 * repository that writes the entry finds out about a bad one from another repository's CI.
 */
test('every entry written since the short field carries a usable one', () => {
  const REQUIRED_FROM = '2026-08-08';
  for (const release of read('packages/core/CHANGELOG.json')) {
    if (release.date < REQUIRED_FROM) continue;
    for (const entry of release.entries) {
      const where = `${release.version} ${entry.kind}`;
      assert.equal(typeof entry.short, 'string', `${where} has no short`);
      assert.equal(entry.short.trim(), entry.short, `${where} short is not trimmed`);
      assert.ok(entry.short.length > 0, `${where} short is empty`);
      assert.ok(entry.short.length <= 200, `${where} short is ${entry.short.length} characters`);
      assert.ok(
        entry.short.length < entry.text.length,
        `${where} short is not shorter than the text it summarises`,
      );
    }
  }
});

/*
 * No em dash in the one string a menu shows.
 *
 * A `short` is read in a panel over a running world, where the punctuation that carries a clause
 * in a paragraph reads as filler. `text` is deliberately not held to this: it is prose on a page
 * somebody chose to open, and the em dash earns its place there.
 *
 * **Grandfathered from 2026-08-10, and the five entries before it stay as written.** The rule was
 * written down after 0.11.0 shipped, so `0.5.0`, `0.5.1`, `0.6.0`, `0.7.0` and `0.11.0` each carry
 * one. Those notes are published, on the site and in a menu, and rewriting a shipped sentence to
 * satisfy a rule it predates changes the record to flatter the rule. This is the same shape as the
 * `short` field's own grandfathering above, for the same reason.
 */
test('a short form carries no em dash, from the release the rule arrived at', () => {
  const HELD_FROM = '2026-08-10';
  for (const release of read('packages/core/CHANGELOG.json')) {
    if (release.date < HELD_FROM) continue;
    for (const entry of release.entries) {
      assert.ok(
        !entry.short.includes('—'),
        `${release.version} ${entry.kind} short carries an em dash: ${entry.short}`,
      );
    }
  }
});
