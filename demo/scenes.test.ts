/**
 * The rules every demo scene obeys, asserted over every scene there is.
 *
 * These were written against the first scene and lived in its own test file, which
 * meant the second scene would have inherited none of them. A boundary that only holds
 * for the file it was written beside is a boundary that lasts exactly one commit, so
 * the corpus is discovered rather than listed: add a scene and it is already covered.
 *
 * What cannot be asserted here is whether the image is any good. That is settled by
 * looking at it, as `AGENTS.md` requires. What is settled here is the part looking
 * cannot catch.
 *
 * Sources arrive through `?raw` rather than `node:fs`, as `shaderComments.test.ts`
 * reads the shader corpus: this repository has no Node typings and does not want them
 * for a test.
 */
import { expect, test } from 'vitest';

import { DRAFT_SCENES, SCENES, isDemoScene } from './index';

/* Vite's, declared minimally rather than by pulling `vite/client` in. See
   `src/build/shaderComments.test.ts` for why the call has to be spelled out. */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/**
 * Every scene module, found by what it exports rather than by a list of what it is not.
 *
 * The filter used to name the files to skip, which meant every module added to this
 * directory for any other reason — a shared control, a helper — arrived as a scene that
 * failed every rule for not having a `frame` method. What makes a file a scene is that
 * it exports one, so that is the question asked.
 */
const SOURCES = Object.entries(
  import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }),
).filter(([id, source]) => !id.endsWith('.test.ts') && /:\s*DemoScene\s*=/.test(source));

test('the corpus is not empty, and every scene module is registered somewhere', () => {
  /*
   * Published and draft together, because the count is here to catch a scene file that
   * exists and is reachable from nothing — not to insist every scene is on the website.
   * A draft is registered in `DRAFT_SCENES`, which the engine's harness shows and no
   * consumer does; that separation is what keeps an unfinished scene off a public page.
   */
  expect(SOURCES.length).toBeGreaterThan(0);
  expect(SCENES.length + DRAFT_SCENES.length).toBe(SOURCES.length);
});

test('a draft is never also published', () => {
  // The one mistake this split exists to prevent, asserted rather than remembered.
  const published = new Set(SCENES.map((scene) => scene.id));
  for (const draft of DRAFT_SCENES) {
    expect(published.has(draft.id), `${draft.id} is in both SCENES and DRAFT_SCENES`).toBe(false);
  }
});

test('every registered scene satisfies the contract', () => {
  const ids = new Set<string>();
  /*
   * Drafts too, and they were not covered until 2026-08-29.
   *
   * A draft that fails the contract fails it silently until the day somebody moves one line to
   * publish it, which is the worst possible moment to find out — `isDemoScene`, the id pattern
   * and the note requirement all exist to be checked before that day rather than on it.
   */
  for (const scene of [...SCENES, ...DRAFT_SCENES]) {
    expect(isDemoScene(scene), `${scene.id} does not satisfy the contract`).toBe(true);
    expect(ids.has(scene.id), `duplicate scene id ${scene.id}`).toBe(false);
    ids.add(scene.id);
    /*
     * A note is what a reader is given to decide whether to look. One that says
     * nothing costs the scene its audience, and "shows off the engine" says nothing.
     */
    expect(scene.note.length, `${scene.id} has a note too short to mean anything`).toBeGreaterThan(
      40,
    );
  }
});

/**
 * A scene's title and note are published copy.
 *
 * They live in the engine and are rendered on a public page, which puts them in an odd
 * position: the site's copy guard reads `content/*.js` and cannot reach a TypeScript
 * module, so without this they would be the one set of reader-facing strings in the
 * whole project that nothing checks. The rules are a house style for reader-facing copy,
 * and the test below is where they are stated.
 */
test('scene copy obeys the house rules for anything a reader sees', () => {
  const defects = /\b(bugs?|broken|faults?|failed|failure|wrong|glitch|regression|stutter)\b/i;
  for (const scene of SCENES) {
    for (const value of [scene.title, scene.note]) {
      expect(value.includes('—'), `an em dash in published copy: "${value}"`).toBe(false);
      expect(defects.test(value), `defect language in a shop window: "${value}"`).toBe(false);
      expect(
        /\bno\b[^.]*\bno\b[^.]*\bno\b/i.test(value),
        `a stacked negative triad: "${value}"`,
      ).toBe(false);
    }
  }
});

/**
 * The standing test of the engine boundary.
 *
 * A demo exists to show that something worth looking at can be built out of the engine
 * alone. The moment one reaches for a noun that only means anything inside a single
 * game, it has stopped demonstrating the engine and started demonstrating that game,
 * and the boundary has moved without anybody deciding to move it.
 *
 * **The nouns live in a gitignored file**, because listing them here would publish the
 * thing the rule exists to keep unpublished. Absent, this is a no-op: a contributor with
 * no private nouns cannot paste one.
 */
const NOUN_LIST = Object.values(
  import.meta.glob('../scripts/private-nouns.local.json', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
) as string[];
const GAME_NOUNS: string[] = NOUN_LIST.length > 0 ? JSON.parse(NOUN_LIST[0]).sceneNouns : [];

test('no scene names anything belonging to one game rather than to the engine', () => {
  for (const [id, source] of SOURCES) {
    for (const noun of GAME_NOUNS) {
      expect(
        new RegExp(`\\b${noun}\\b`, 'i').test(source),
        `${id} names "${noun}", which belongs to a game rather than to the engine`,
      ).toBe(false);
    }
  }
});

/**
 * A demo that deep-imports is a demo doing something no consumer can do.
 *
 * The barrel is the whole of what anybody installing this package receives, so a scene
 * reaching past it into `src/render/…` would be an impressive picture built with
 * privileged access — which argues for an engine nobody else has.
 */
/**
 * Every module in this directory, scene or not, because the rule below is about all of them.
 *
 * A scene may lean on a sibling here — the gesture binder, the orbit view, the load bar — and
 * that is not a hole in the rule, because a consumer copying `demo/` gets the siblings too. What
 * would be a hole is a sibling reaching *past* the barrel into `src/`, since the scene would then
 * be demonstrating something a consumer cannot reach. So the rule applies transitively.
 */
const MODULES = [
  ...Object.entries(import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true })),
  /*
   * A scene's own subdirectory, added 2026-08-29 when the first scene grew one.
   *
   * Until then this glob was one directory deep and the allowed-specifier pattern below only
   * matched a same-directory sibling, so a scene with a subdirectory was both forbidden and, had
   * it existed anyway, unchecked — the rule would have stopped applying at exactly the point it
   * says it applies transitively.
   *
   * `dev/` is deliberately not here. Those are diagnostic rigs rather than demonstrations, they
   * reach into `src/` on purpose to instrument it, and holding them to a rule about the public
   * surface would be holding the wrong files to it.
   *
   * **Nor is `native/`, for the same reason**, since 2026-09-19 when the native host became a
   * package and its harness moved here: the scene runner, the editor runner and the device check
   * drive the host's readback and replay and the renderer's feature probe, which is instrumenting.
   * The program the host's start is measured with sits a level deeper and uses the barrels only.
   */
  ...Object.entries(
    import.meta.glob('./*/*.ts', { query: '?raw', import: 'default', eager: true }),
  ).filter(([id]) => !id.startsWith('./dev/') && !id.startsWith('./native/')),
].filter(([id]) => !id.endsWith('.test.ts'));

test('every scene reaches the engine through the public barrel alone', () => {
  for (const [id, source] of MODULES) {
    const specifiers = [...source.matchAll(/ from '([^']+)';/g)].map(([, specifier]) => specifier);
    /*
     * A *scene* importing nothing means the match above found nothing it should have, and the
     * loop below would then check a file by checking none of it. A leaf helper legitimately
     * imports nothing — `voxelSandbox/constants.ts` is four numbers and two functions — so the
     * guard is aimed at the files it was written for rather than at every module here.
     */
    if (SOURCES.some(([sceneId]) => sceneId === id)) {
      expect(specifiers.length, `${id} imports nothing at all`).toBeGreaterThan(0);
    }
    for (const specifier of specifiers) {
      /*
       * A published package's barrel, or a sibling in this directory. Anything else reaching
       * into a package's `src/` is the failure: `../packages/core/src/render/mesh` compiles
       * perfectly here and is not part of the public surface, so a scene built on one would be
       * demonstrating an engine nobody else has.
       *
       * `@driftengine/*` rather than one barrel, since the workspace split: a consumer has as
       * many barrels as it installs packages, and a scene reaching one of those is reaching
       * exactly what a consumer has.
       */
      const allowed =
        /* The core barrel, from whatever depth the importing module sits at. */
        /^(\.\.\/)+packages\/core\/src\/index$/.test(specifier) ||
        /* A sibling package's barrel, installed the same way a consumer installs it. */
        /^@driftengine\/[a-z]+$/.test(specifier) ||
        /*
         * `driftscript` is a published package too, and the rule's own reason covers it: a
         * consumer has as many barrels as it installs packages. It is named rather than
         * pattern-matched, so this stays a list of what a demo may reach rather than a hole.
         */
        specifier === 'driftscript' ||
        /* A sibling, a scene's own subdirectory, or back up out of one. */
        /^\.\.?\/[A-Za-z]+(\/[A-Za-z]+)?$/.test(specifier) ||
        /* A DriftScript module beside the file that hosts it. */
        /^\.\.?\/[A-Za-z]+\.drs$/.test(specifier);
      expect(allowed, `${id} imports "${specifier}"; a consumer only has package barrels`).toBe(
        true,
      );
    }
  }
});

/**
 * Nothing allocates while a frame is running.
 *
 * The engine's central claim, and the one a demo is in the best position to break: a
 * scene is small enough that building a matrix or a colour per frame never shows up in
 * a profile, and a hero canvas printing "0 allocations" over geometry that allocates
 * would be the site lying about the engine on the engine's own page.
 *
 * A source grep is a blunt instrument, and it is aimed at the exact constructs that
 * cause this. Every method a frame reaches is covered, not only `frame` itself, because
 * the allocation that matters is the one three calls down.
 */
/*
 * **The `{` is load-bearing**: without it this matches an interface member as well as a method,
 * and `types.ts` declares `frame(dtSec: number): DemoStats;` with no body at all. The body lookup
 * then finds nothing and reports the corpus as stale, which is the widening above meeting a regex
 * that was only ever pointed at classes.
 */
const FRAME_METHODS =
  /\n {2}(?:private )?(frame|drawWorld|drawScene|step|simulate)\([^)]*\)[^{;]*\{/g;

test('the frame path of every scene allocates nothing', () => {
  /*
   * **Every module here, not only the ones that declare a scene**, and the widening is a gate
   * scope that had shrunk against the directory. A scene's frame path may live in a rig its module
   * imports — three GPU-driven drafts share one — and the old corpus was the scene modules, so a
   * shared frame path was checked by nothing while the rule read as though it covered everything.
   * Found by a scene whose own module has no `frame` at all, which the staleness guard reported as
   * itself having gone stale.
   */
  let found = 0;
  for (const [id, source] of MODULES) {
    if (id.endsWith('.test.ts')) continue;
    const names = [...source.matchAll(FRAME_METHODS)].map(([, name]) => name);
    if (names.includes('frame')) found += 1;

    for (const name of new Set(names)) {
      const body = methodBody(source, name);
      expect(body.length, `${id}: ${name} was not found`).toBeGreaterThan(0);
      expect(/\bnew [A-Z]/.test(body), `${id}: ${name} constructs an object`).toBe(false);
      expect(/=\s*\[/.test(body), `${id}: ${name} builds an array`).toBe(false);
      expect(/\.(map|filter|slice|concat)\(/.test(body), `${id}: ${name} builds an array`).toBe(
        false,
      );
    }
  }
  /* What the old shape got from insisting every scene file had one: a regex that matches nothing
     passes every assertion inside the loop, which is the second explanation for a surviving
     perturbation and is worth one line to refuse. */
  expect(found, 'no frame method was found at all; this test has gone stale').toBeGreaterThan(0);
});

test('every scene module reaches a frame path, its own or one it imports', () => {
  /*
   * The half of the old staleness guard that was about the scenes rather than about the regex. A
   * scene whose handle has no `frame` draws nothing, and the module that owns the handle is either
   * the scene's own or a sibling it imports by relative path — there is no third place in this
   * directory for it to be.
   */
  for (const [id, source] of SOURCES) {
    const siblings = [...source.matchAll(/from '(\.\/[a-zA-Z0-9]+)'/g)].map(([, at]) => at);
    const reachable = [id, ...siblings.map((at) => `${at}.ts`)];
    const byId = new Map(MODULES);
    const has = reachable.some((at) => /\n {2}(?:private )?frame\(/.test(byId.get(at) ?? ''));
    expect(has, `${id} has no frame method and imports no module that has one`).toBe(true);
  }
});

/** A class method's body, from its signature to the closing brace at method indent. */
function methodBody(source: string, name: string): string {
  const match = new RegExp(
    `\\n {2}(?:private )?${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n {2}\\}`,
  ).exec(source);
  return match?.[1] ?? '';
}
