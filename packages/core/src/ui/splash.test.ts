import { expect, test } from 'vitest';
import {
  SPLASH_HARD_CAP_MS,
  SPLASH_MIN_MS,
  SplashState,
  forcedSplash,
  holdSplash,
  splashDecision,
  splashWanted,
} from './splash.ts';

/** A game served from a web page, having asked for nothing: the case that says yes. */
const WEB = {
  enabled: true,
  packagedShell: false,
  search: '',
  document: true,
} as const;

test('a web page that asked for nothing is the case that shows a badge', () => {
  expect(splashWanted(WEB)).toBe(true);

  /*
   * Each refusal is a different promise:
   *
   * - `enabled` false is the opt-out. It is the whole reason this is a decision rather than
   *   a statement, and it has to win against everything except an explicit `?splash=1`.
   * - `packagedShell` is a game running inside `drift-package`, where the shell already shows
   *   the same badge in its own window before the game's first paint. Two of them in a row is
   *   not twice the branding; it is a boot that looks stuck.
   * - `document` false is a test, a bake or any other headless run. There is nothing to mount
   *   on, and a splash that throws during boot is worse than no splash by a wide margin.
   */
  expect(splashWanted({ ...WEB, enabled: false })).toBe(false);
  expect(splashWanted({ ...WEB, packagedShell: true })).toBe(false);
  expect(splashWanted({ ...WEB, document: false })).toBe(false);
});

test('the query string overrides in both directions, and never invents a third state', () => {
  expect(splashWanted({ ...WEB, search: '?splash=0' })).toBe(false);
  expect(splashWanted({ ...WEB, enabled: false, search: '?splash=1' })).toBe(true);

  /*
   * `?splash=1` beats the shell too. That is the only way to look at the web badge inside a
   * packaged build, which is where its worst failure — a black plate that outlives the boot —
   * would otherwise be invisible.
   */
  expect(splashWanted({ ...WEB, packagedShell: true, search: '?splash=1' })).toBe(true);

  /*
   * It does not beat a missing document, because that is not a preference. Overriding a
   * capability check with a query parameter is how a flag becomes a crash.
   */
  expect(splashWanted({ ...WEB, document: false, search: '?splash=1' })).toBe(false);

  /* Anything that is not the two values is absent, exactly as `forcedBackend` reads its own. */
  expect(forcedSplash('')).toBe(null);
  expect(forcedSplash('?splash=yes')).toBe(null);
  expect(forcedSplash('?backend=webgl2')).toBe(null);
  expect(forcedSplash('?splash=0')).toBe(false);
  expect(forcedSplash('?splash=1')).toBe(true);
});

/**
 * The same three rules the packaged shell decides by, in the runtime that cannot import them.
 *
 * `@driftengine/package`'s `splashTiming.ts` runs in Electron's main process, which is a plain
 * Node process and cannot import this engine at all — engine packages use extensionless relative
 * imports, which a bundler resolves and Node does not. So the rule exists twice on purpose, and
 * the agreement below is asserted rather than assumed.
 */
test('a badge holds until the game has painted, and never past the cap', () => {
  /* Painted, but too early: a badge that vanishes the instant a fast machine paints is a
     flicker, and the machines that boot fastest are the ones a developer tests on. */
  expect(splashDecision(200, SPLASH_MIN_MS, true)).toBe('hold');
  expect(splashDecision(SPLASH_MIN_MS, SPLASH_MIN_MS, true)).toBe('swap');

  /*
   * The default minimum is a hold and not merely an anti-flicker guard, so a game that has
   * painted still waits it out. Asserted against the constant rather than beside it, because a
   * decision function that quietly stopped honouring the number is the failure this catches.
   */
  expect(SPLASH_MIN_MS).toBe(3_000);
  expect(splashDecision(2_999, SPLASH_MIN_MS, true)).toBe('hold');

  /* The minimum has passed and nothing has painted. Swapping here shows the empty canvas the
     badge exists to cover. */
  expect(splashDecision(5_000, SPLASH_MIN_MS, false)).toBe('hold');

  /* The cap overrides both, because a boot that never finishes must not leave a logo as the
     whole product. A broken game that can be seen is better than a brand that cannot be
     dismissed. */
  expect(splashDecision(SPLASH_HARD_CAP_MS, SPLASH_MIN_MS, false)).toBe('swap');
  expect(splashDecision(SPLASH_HARD_CAP_MS + 1, 60_000, false)).toBe('swap');

  /* A minimum longer than the cap is a caller error that must not be able to pin the screen,
     so the cap is checked first rather than last. */
  expect(splashDecision(19_999, 60_000, true)).toBe('hold');
  expect(splashDecision(20_000, 60_000, true)).toBe('swap');
});

/*
 * **A game can keep the badge up until its own load settles, under a cap of its own.** The first
 * frame alone is ready no longer once a hold is asked for: ready waits for every promise the game
 * handed over, a rejected one included — a load that failed must not pin the logo — and the cap
 * becomes the game's where it names one, longer or shorter than the engine's, the longest of several.
 */
test('A BADGE HELD BY THE GAME IS READY WHEN EVERY HOLD HAS SETTLED, UNDER THE LONGEST CAP ASKED', async () => {
  const state = new SplashState();
  expect(state.capMs).toBe(SPLASH_HARD_CAP_MS);
  let finish = (): void => {};
  let fail = (): void => {};
  const loaded = new Promise<void>((resolve) => (finish = resolve));
  const broken = new Promise<void>(
    (_, reject) => (fail = () => reject(new Error('a load failed'))),
  );
  let settled = 0;
  state.hold(loaded, 45_000, () => settled++);
  state.hold(broken, 30_000, () => settled++);
  expect(state.capMs, 'the longest cap asked').toBe(45_000);
  state.painted = true;
  expect(state.ready, 'painted, still loading').toBe(false);
  finish();
  await loaded;
  expect(state.ready, 'one hold left').toBe(false);
  fail();
  await broken.catch(() => {});
  await Promise.resolve();
  expect(state.ready, 'a failed load settles too').toBe(true);
  expect(settled).toBe(2);
  /* And the clock reads it: held past the engine's twenty seconds, gone at the game's own cap. */
  expect(splashDecision(SPLASH_HARD_CAP_MS + 1, SPLASH_MIN_MS, false, state.capMs)).toBe('hold');
  expect(splashDecision(45_000, SPLASH_MIN_MS, false, state.capMs)).toBe('swap');
  /* A cap that is not a positive number leaves the engine's; a shorter one is the game's to ask. */
  const plain = new SplashState();
  plain.hold(Promise.resolve(), Number.NaN, () => {});
  expect(plain.capMs).toBe(SPLASH_HARD_CAP_MS);
  const brief = new SplashState();
  brief.hold(Promise.resolve(), 8_000, () => {});
  expect(brief.capMs, 'the game’s own, shorter than the engine’s').toBe(8_000);
});

/* With no badge on the page — a test, a worker, `splash: false` — holding is nothing, and says so. */
test('HOLDING WITH NO BADGE UP DOES NOTHING AND SAYS SO', () => {
  expect(holdSplash(Promise.resolve())).toBe(false);
});
