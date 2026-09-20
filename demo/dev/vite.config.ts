import { driftScript } from 'driftscript/vite';

/**
 * The repository root, from this file rather than from the process's working directory.
 *
 * `new URL` rather than `node:path`, because this file is inside the *browser* typecheck's scope —
 * `demo` is one of its roots — and a `node:` import there wants type definitions the browser
 * project does not carry. The URL form needs nothing and says the same thing.
 */
const ROOT = new URL('../../', import.meta.url).pathname;

/**
 * The demo harness's bundler configuration, which exists for exactly one reason.
 *
 * `npm run demo` was `npx vite demo/dev` with no configuration at all, and that was right while
 * every file it served was TypeScript. A `.drs` file is not JavaScript until the DriftScript
 * transform has run, so the harness needs to know about the transform — and this is the first
 * place in the repository where the engine is consumed the way a consumer consumes it, which is
 * what makes it the right place to prove the plugin works.
 *
 * **No manifest is configured**, so nothing links and nothing is refused. That is deliberate for a
 * harness: the demo pages exist to look at behaviour, and a target manifest is a decision a real
 * consumer makes about what its build ships. `driftscript`'s own suite covers the
 * refusal path, and a consumer that wants it passes `{ manifest }`.
 *
 * Everything else stays default. A configuration that grew options would be a configuration the
 * demo harness depends on, and `scripts/shots.mjs` drives this server expecting the plain one.
 */
export default {
  plugins: [driftScript()],
  /**
   * **`drift-source`, so every page here runs the engine in this checkout.**
   *
   * `packages/*` export `./src/index.ts` under this condition and `./dist/index.js` by default,
   * and vite sets neither — so a page importing `@driftengine/core` was served the last build on
   * disk while the page beside it importing `../../packages/core/src/index` was served the source.
   * Two pages in one dev server, running two different engines, with nothing saying so: a fix to
   * the reflection probe changed `showroom` and left `ibl.html` byte-identical, which reads as a
   * fix that does nothing.
   *
   * The demo pages are instruments before they are consumer examples, and an instrument has to
   * measure the thing being edited. `scripts/consumerEntries.test.mjs` is what covers the other
   * claim — that the published entry points resolve for somebody installing the package.
   *
   * **The alias is what actually does it and the condition is belt and braces.** The condition
   * alone worked for one restart and then stopped: a workspace package reached through a symlink
   * is a candidate for dependency pre-bundling, and a cached optimisation resolved it back to
   * `dist` with nothing saying so. An alias to a source path is not a candidate, so there is
   * nothing to cache and nothing to go stale. The failure it prevents is silent by construction —
   * the page still loads, still draws, and is running code nobody is editing.
   */
  resolve: {
    conditions: ['drift-source'],
    alias: [
      {
        find: /^@driftengine\/([a-z0-9-]+)$/,
        replacement: `${ROOT}packages/$1/src/index.ts`,
      },
    ],
  },
};
