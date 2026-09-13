import { driftScript } from 'driftscript/vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Tests are colocated as `*.test.ts` beside the module they cover, in whichever package
 * owns them, and are
 * typechecked by `npm run typecheck`. Node environment: we test simulation,
 * math, geometry and collision — never rendering or DOM, which are verified by
 * hand (see AGENTS.md "Testing").
 *
 * `demo/` is included as well as `src/`. The demos are not part of the engine's
 * public surface and are deliberately outside the barrel, but they are the one
 * place the engine is consumed the way a consumer consumes it — so a test that
 * they still build, and that they name nothing belonging to a game, protects the
 * boundary `AGENTS.md` opens with.
 */
/**
 * **The run writes a summary, so nothing has to run the suite twice.**
 *
 * `scripts/docs-counts.mjs` puts the test count into `docs/CAPABILITIES.md`, and it used to get
 * that number by running the whole suite itself — so a session that ran the suite and then
 * refreshed the counts paid for it twice: 74 seconds of wall clock and about five CPU-minutes
 * each, measured 2026-08-28. The number exists only in the runner, so the fix is for the runner to
 * write it down where a cheap tool can read it.
 *
 * `json` beside `default` rather than instead of it: the console output is what a person reads and
 * the file is what a script reads. About a megabyte for this suite, gitignored, rewritten by every
 * run.
 *
 * **A partial or a red run must not be mistaken for the current truth**, and the reader checks
 * rather than trusting: `success`, the suite count against a walk of the tree, and the run's own
 * start time against the newest test file. See `docs-counts.mjs` for what each catches.
 */
export const SUMMARY_FILE = '.vitest/summary.json';

/**
 * The DriftScript transform, minus the files that are being *read* rather than run.
 *
 * `packages/script/src/corpus.test.ts` imports every corpus `.drs` with `?raw`, because it asserts
 * about their text. The plugin does not check for that suffix, so adding it to this config
 * compiled the corpus instead of handing it over and failed a suite that had nothing to do with
 * the change. Skipping `?raw` here is narrower than excluding a directory and says what it means.
 */
function rawSafeDriftScript(): Plugin {
  const inner = driftScript() as Plugin;
  const transform = inner.transform;
  return {
    ...inner,
    transform(code: string, id: string, options?: unknown) {
      if (id.includes('?raw')) return null;
      return (transform as (this: unknown, c: string, i: string, o?: unknown) => unknown).call(
        this,
        code,
        id,
        options,
      );
    },
  } as Plugin;
}

export default defineConfig({
  /*
   * The DriftScript transform, because a demo scene now imports a `.drs`.
   *
   * `demo/scenes.test.ts` reaches every scene through `demo/index.ts`, so the moment one of them
   * used the language the whole demo suite failed to parse — not on an assertion but on a module
   * graph, which reads as a broken test file rather than as a missing plugin. The bundler that
   * serves the demos has had this plugin since the language landed; the runner that tests them
   * had not, and nothing needed it until now.
   */
  plugins: [rawSafeDriftScript()],
  /*
   * **The suite reads this repository's source, not its build output.**
   *
   * Every package's `exports` names `node` so that a consumer's Node script gets compiled
   * JavaScript, which is the whole point of that field — and the runner is Node, so without this
   * line it takes the same branch and the suite tests `dist`. Measured before it was added: a test
   * importing a sibling package failed with *"Failed to resolve entry for package
   * `@driftengine/entities`"*, because no build had run.
   *
   * `drift-source` is first in every conditions object and is this repository's own name for its
   * own source. Node ignores it unless asked, so nothing outside here sees it. The rejected
   * alternative was removing `node` from the conditions, which changes how every *other* dependency
   * resolves rather than only ours.
   */
  ssr: { resolve: { conditions: ['drift-source', 'module', 'node'] } },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'demo/**/*.test.ts'],
    reporters: ['default', ['json', { outputFile: SUMMARY_FILE }]],
  },
});
