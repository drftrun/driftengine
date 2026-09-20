/**
 * The repository root, from this file rather than from the process's working directory.
 *
 * `new URL` rather than `node:path`, for the reason `demo/dev/vite.config.ts` gives: this file is
 * inside the browser typecheck's scope, and a `node:` import there wants type definitions the
 * browser project does not carry.
 */
const ROOT = new URL('../', import.meta.url).pathname;

/**
 * **`npm run editor` had no configuration at all, and so ran a different engine from the one in
 * this checkout** (2026-09-20).
 *
 * `packages/*` export `./src/index.ts` under the `drift-source` condition and `./dist/index.js` by
 * default, and vite sets neither. So `editor/src/**` was served live from source while every
 * `@driftengine/*` it imports — core, ui2d, tools, entities, texture — came from whatever
 * `npm run build` last left on disk. The editor's own files were the thing being edited and the
 * engine underneath them was frozen at some previous commit.
 *
 * **It fails in the quietest direction there is.** The page loads, draws and behaves; a fix made in
 * a package simply does not appear, which reads as a fix that does nothing. It was found by a
 * panel reporting `No timings yet` while holding sixty frame samples — the panel had been fixed in
 * `packages/tools/src/profiler.ts` minutes earlier, and the page was running the build.
 * `demo/dev/vite.config.ts` has carried this same paragraph since the same thing happened there.
 *
 * **The alias does the work and the condition is belt and braces.** A workspace package reached
 * through a symlink is a candidate for dependency pre-bundling, and a cached optimisation resolves
 * it back to `dist` with nothing saying so; an alias to a source path is not a candidate, so there
 * is nothing to cache and nothing to go stale.
 *
 * No DriftScript plugin: the editor loads no `.drs`. The day it does, this grows one, exactly as
 * the demo harness's did.
 */
export default {
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
