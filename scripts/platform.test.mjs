/**
 * No package — and no part of the editor — reaches for a platform API a consumer might supply.
 *
 * **The editor joined the scope on 2026-09-15 and was already clean.** It walked
 * `packages/*​/src` alone, which is the third list in this repository found describing less than
 * it was believed to: `tsconfig.json` had left the editor out of typechecking and four workspaces
 * had undeclared dependencies, both on the same day. The rule applies to the editor for a reason
 * of its own — native is a second *host*, so a product that fetched `document` would have to be
 * rewritten rather than re-hosted — and a rule that applies is a rule worth checking.
 *
 * `AGENTS.md` has said so since the beginning and nothing has ever checked it. Wave 5A's first
 * task ran the check: 91 references in 30 files, of which **eleven were defects** — a model
 * fetched through the global in the one package that streams, three deadlines measured with a
 * wall clock that steps, and a media query in a constructor that threw rather than degraded.
 *
 * **A twelfth was invisible to the scanner and is the one worth remembering**: nothing said which
 * timebase a caller-supplied frame time was on, so a caller supplying frames on another one drove
 * the accumulator negative and the simulation did not tick at all until it climbed back to zero.
 *
 * The unit tests come first and are not ceremony, for the reason `determinism.test.mjs` gives: a
 * scanner whose regex is broken passes this file silently, which is the test that cannot fail.
 * They are this gate's perturbation, written down, and one of them is a bug it actually had.
 *
 * ---
 *
 * ## Two exemptions, because there are two different correct answers
 *
 * **A marked line** is a platform call that *is* the documented default of a capability the caller
 * may replace: `localStorage` inside `BrowserStore`, the window's `requestAnimationFrame` inside
 * `LoopOptions.frameSource`'s default, `new Worker` behind `spawn`. The file around it stays
 * scanned, so a second, unrelated call in the same file still fails. That is the point of marking
 * a line rather than a file.
 *
 * **A declared browser module** is a file a runtime without a browser never loads at all:
 * `ui/splash.ts` builds six DOM nodes, `render/imageTexels.ts` decodes through a canvas,
 * `input/input.ts` takes an `HTMLElement` in its constructor. Making those take a capability would
 * mean inventing an abstract DOM, which is a browser engine and not a game engine. What was wrong
 * with them was never the calls — it was that *"the host does not load this file"* was nobody's
 * stated intent. It is stated here now, and the list has a second job: **it is precisely what a
 * native host has to reimplement**, enumerated before a line of one is written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PLATFORM_GLOBALS, violations } from './platform.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Files and directories a runtime without a browser never loads, each with the reason.
 *
 * **A reason per entry, on `determinism.test.mjs`'s argument**: a list that is "the files somebody
 * remembered" drifts, and that gate spent a month describing one package while claiming to scan
 * every one. Every entry here says what the file is for, so a reader can tell whether it is still
 * true, and the test below fails if a path stops existing — a rename cannot silently widen this.
 */
const BROWSER_MODULES = [
  // The seam directory itself: each of these is the `Browser*` half of an interface a host replaces.
  ['packages/core/src/host/display.ts', '`BrowserDisplay`, the browser half of `DisplayControl`'],
  ['packages/core/src/host/lifecycle.ts', '`BrowserLifecycle`, the browser half of `Lifecycle`'],
  ['packages/core/src/host/screen.ts', 'the browser half of `ScreenPresentation`'],

  // Input binds to DOM events by its constructor's signature. A host writes its own.
  ['packages/core/src/input/input.ts', 'takes an `HTMLElement`; a host supplies its own input'],

  // Two backends, both of which are browser graphics APIs by definition.
  ['packages/core/src/render/backend/webgl2/renderer.ts', 'WebGL2 is a browser API'],
  ['packages/core/src/render/backend/webgpu/device.ts', 'the canvas half of `GpuSurface`'],
  ['packages/core/src/render/imageTexels.ts', 'decodes through a canvas and `createImageBitmap`'],

  // Presentation and capture: every one of these builds or reads DOM.
  ['packages/core/src/dev/fpsMeter.ts', 'a DOM debug overlay'],
  ['packages/core/src/ui/exportTarget.ts', 'draws into a canvas to export it'],
  ['packages/core/src/ui/frameOverlay.ts', 'a canvas overlay'],
  ['packages/core/src/ui/frameRecorder.ts', 'the share sheet and a download link'],
  ['packages/core/src/ui/fullscreen.ts', 'the fullscreen API and its events'],
  ['packages/core/src/ui/pixelCursor.ts', 'draws a cursor into a canvas'],
  ['packages/core/src/ui/splash.ts', 'mounts the engine badge into a page'],
  ['packages/core/src/ui/stillFrame.ts', 'holds a canvas copy of the last frame'],
  ['packages/media/src/frameDelivery.ts', 'probes and reads back browser video encoders'],

  /*
   * The whole of `@driftengine/package`, because it *is* a host — the Electron main process and
   * the mobile shell. It is the existing precedent for a host living in a package, and a native
   * host is the second one.
   */
  ['packages/package/src/', 'the desktop and mobile hosts; platform code is what they are'],
  /* And the second host in a package, which is what that precedent was written for. */
  ['packages/native-host/src/', 'the native host: Node, Dawn and SDL are what it is made of'],

  /*
   * **The editor's browser host, which is the same argument one product along.** Wave 2C decided
   * that `editor/src/host/browser/` is the only directory in the editor that may name a browser
   * global, and `main.ts` is the entry that mounts a canvas and drives the frame. A native host
   * replaces exactly these and edits nothing above them — which is what makes the list's second
   * job true here as well: this is the editor's porting worklist, written before the port.
   *
   * **The two host files reach the globals through `globalThis` and the scan does not see that**,
   * which is a gap in this gate rather than a property of those files. They are declared anyway,
   * because what the list records is intent, and an entry that only holds while a file is written
   * one particular way is an entry that stops holding when somebody tidies it.
   */
  ['editor/src/main.ts', 'mounts the canvas, drives the frame, binds the keyboard'],
  ['editor/src/host/browser/', 'the browser halves of `TextHost` and `A11yHost`'],

  // A clip in a browser: a video element decoded into a canvas, which a native host replaces.
  ['packages/capture/src/browserFrames.ts', "a video element and a canvas are the browser's clip"],
];

/** Every non-test `.ts` under the `src` of every package, and of the editor. */
function packageSources() {
  const walk = (dir, out = []) => {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
    return out;
  };
  const roots = readdirSync(path.join(ROOT, 'packages')).map((name) =>
    path.join(ROOT, 'packages', name, 'src'),
  );
  roots.push(path.join(ROOT, 'editor', 'src'));
  return roots
    .flatMap((root) => walk(root))
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
    .sort();
}

const declared = (file) =>
  BROWSER_MODULES.some(([entry]) =>
    entry.endsWith('/') ? file.startsWith(entry) : file === entry,
  );

test('the scanner finds a direct call', () => {
  assert.deepEqual(violations('const r = await fetch(url);'), [
    { line: 1, name: 'fetch', group: 'network' },
  ]);
  assert.deepEqual(violations('document.createElement("div");'), [
    { line: 1, name: 'document', group: 'dom' },
  ]);
});

test('the scanner finds every name on the list', () => {
  for (const [group, names] of Object.entries(PLATFORM_GLOBALS)) {
    for (const name of names) {
      const source = name.endsWith('Worker') ? `new ${name}(u)` : `x = ${name}.y`;
      const found = violations(source);
      assert.equal(found.length, 1, `${name} was not caught`);
      assert.equal(found[0].group, group);
    }
  }
});

/** A property of something else. Three packages had one, and none of them is a platform call. */
test('a name owned by something else is not a reference to the global', () => {
  assert.deepEqual(violations('this.window.length'), []);
  assert.deepEqual(violations('return manifest.window.width;'), []);
  assert.deepEqual(violations('session.requestAnimationFrame(cb);'), []);
});

/** A local binding, including an imported one. `main/ipc.ts` imports Electron's `screen`. */
test('a local of that name is a local', () => {
  assert.deepEqual(violations('let window = map.get(k);\nwindow.count++;'), []);
  assert.deepEqual(violations("import { fetch } from 'undici';\nfetch(url);"), []);
});

/**
 * A member declaration is not a call, and this is the shape that produced the gate's one bug.
 *
 * The first attempt asked whether a colon appeared anywhere before the closing parenthesis, which
 * is true of `fetch(url, { cache: 'no-store' })` — so the audit's headline finding passed its own
 * gate in silence. The rule is now the *first* parameter being typed, and the last case here is
 * the regression test.
 */
test('an interface member is a declaration, and a call with an object argument is a call', () => {
  assert.deepEqual(violations('  requestAnimationFrame(cb: (t: number) => void): number;'), []);
  assert.deepEqual(violations('  cancelAnimationFrame(handle: number): void;'), []);
  assert.deepEqual(violations('  requestAnimationFrame(callback) {'), []);
  assert.deepEqual(violations('  readonly window: Float64Array;'), []);
  assert.deepEqual(violations('  matchMedia: () => ({ matches: false }),'), []);
  assert.deepEqual(violations("  const r = await fetch(url, { cache: 'no-store' });"), [
    { line: 1, name: 'fetch', group: 'network' },
  ]);
});

/** One line can be both, which is why the judgement is per occurrence and not per line. */
test('a key naming the default and the call that is the default are told apart', () => {
  assert.deepEqual(violations('  requestAnimationFrame: (cb) => requestAnimationFrame(cb),'), [
    { line: 1, name: 'requestAnimationFrame', group: 'frames' },
  ]);
});

test('a name inside a comment or a string is prose, not a call', () => {
  assert.deepEqual(violations('// localStorage is the case that caught us.'), []);
  assert.deepEqual(
    violations('/**\n * `document.body` is not available here.\n */\nconst d = 1;'),
    [],
  );
  assert.deepEqual(violations("throw new Error('no fetch(url) in this runtime');"), []);
});

test('line numbers survive comment removal', () => {
  assert.deepEqual(violations('/*\n * a block comment\n */\nlocalStorage.getItem(k);'), [
    { line: 4, name: 'localStorage', group: 'storage' },
  ]);
});

test('a type annotation allocates nothing', () => {
  assert.deepEqual(violations('let pool: Worker | null = null;'), []);
  assert.deepEqual(violations('const w = new Worker(url);'), [
    { line: 1, name: 'Worker', group: 'threads' },
  ]);
});

test('the marker exempts the next line and requires a reason', () => {
  const withReason =
    '// platform: browser default — `KeyValueStore` is the seam\nlocalStorage.x();';
  assert.deepEqual(violations(withReason), []);
  const bare = '// platform: browser default —\nlocalStorage.x();';
  assert.equal(violations(bare).length, 1, 'a marker with no reason must not exempt');
});

test('the marker exempts one line, not the file', () => {
  const source = '// platform: browser default — first only\nlocalStorage.a();\nlocalStorage.b();';
  assert.deepEqual(violations(source), [{ line: 3, name: 'localStorage', group: 'storage' }]);
});

/**
 * `performance.now` is not on the list, and that is a decision rather than an omission.
 *
 * It is monotonic and present in every runtime that matters, so it is the *fix* for the wall-clock
 * deadlines this audit found rather than another instance of them. Banning it would have sent
 * three call sites back to `Date.now`.
 */
test('the monotonic clock is allowed and the wall clock is not', () => {
  assert.deepEqual(violations('const t = performance.now();'), []);
  assert.deepEqual(violations('const t = Date.now();'), [
    { line: 1, name: 'Date.now', group: 'clock' },
  ]);
  /* A wall-clock `Date` that is not a reading of the clock stays untouched. */
  assert.deepEqual(violations('const epoch = new Date(0);'), []);
});

test('no package and no editor module calls a platform API directly', () => {
  const offences = [];
  for (const file of packageSources()) {
    if (declared(file)) continue;
    for (const { line, name, group } of violations(readFileSync(path.join(ROOT, file), 'utf8'))) {
      offences.push(`${file}:${line} reaches for ${name} (${group})`);
    }
  }
  assert.deepEqual(
    offences,
    [],
    'AGENTS.md: take the capability as a parameter, ship a browser implementation as the ' +
      'default. Mark the line if it *is* that default:\n  ' +
      offences.join('\n  '),
  );
});

/** A rename must not silently widen the exemption by emptying an entry. */
test('every declared browser module exists', () => {
  const missing = BROWSER_MODULES.filter(([entry]) => !existsSync(path.join(ROOT, entry)));
  assert.deepEqual(
    missing.map(([entry]) => entry),
    [],
    'a declared path that no longer exists exempts nothing and fails nothing',
  );
});

/**
 * And a declared module must still be one.
 *
 * An entry that no longer contains a platform call is an entry somebody could delete, and leaving
 * it is how the list becomes folklore. The directory form is exempt from this: `package/src/` is
 * declared as a whole because the package is a host, not because every file in it touches the DOM.
 */
test('every declared browser module still reaches for the platform', () => {
  const idle = BROWSER_MODULES.filter(([entry]) => {
    if (entry.endsWith('/')) return false;
    const full = path.join(ROOT, entry);
    if (!existsSync(full) || !statSync(full).isFile()) return false;
    return violations(readFileSync(full, 'utf8')).length === 0;
  });
  assert.deepEqual(
    idle.map(([entry]) => entry),
    [],
    'these no longer call a platform API, so the declaration is stale and should be removed',
  );
});

/* The scope really is every package, which is the thing `determinism.test.mjs` learned late.
   719 source files across nineteen packages on 2026-09-15; a floor, so adding one cannot fail it. */
test('the scan covers every package', () => {
  const files = packageSources();
  const packages = new Set(files.map((file) => file.split('/')[1]));
  assert.ok(packages.size >= 19, `${packages.size} packages scanned`);
  assert.ok(files.length > 650, `${files.length} files scanned`);
});
