/**
 * `npm run examples` serves this directory against the engine in this checkout.
 *
 * Without it every `@driftengine/*` import resolved through the package's `exports` to `dist/`,
 * which a fresh clone does not have until somebody runs the build, so the shortest path from
 * nothing to a frame on screen started with an unexplained module-not-found. The alias is the
 * demo harness's, for the same reason: an example is the engine in this tree demonstrating
 * itself.
 *
 * A folder copied out of here into a project imports the package by name and gets the build, and
 * needs none of this.
 */
import { driftScript } from 'driftscript/vite';
import type { Plugin } from 'vite';

const ROOT = new URL('../', import.meta.url).pathname;

/**
 * The engine modules an example's script may import. Most need no host service; the ones that do
 * are handed theirs by the example that uses them: `drift/navigation` its graph, `drift/ecs` its
 * components and prefabs, `drift/chemistry` its world, `drift/behavior` and `drift/ai` the
 * routines and agents they act on, `drift/audio` its mix and sounds, `drift/xr` the session it
 * reads, and `drift/persistence` the store it writes to.
 */
const SCRIPTED = [
  'drift/render',
  'drift/scene',
  'drift/random',
  'drift/terrain',
  'drift/physics',
  'drift/input',
  'drift/animation',
  'drift/navigation',
  'drift/ecs',
  'drift/chemistry',
  'drift/behavior',
  'drift/ai',
  'drift/audio',
  'drift/camera',
  'drift/2d',
  'drift/ui',
  'drift/xr',
  'drift/persistence',
];

export default {
  plugins: [
    /*
     * Several examples keep their behaviour in a `.drs` file, compiled here and hot-patched. The
     * engine's capability file is what tells the compiler what `drift/render` and the rest declare,
     * and the manifest is what the examples may import from it.
     */
    driftScript({
      capabilities: `${ROOT}packages/script/capabilities.json`,
      manifest: { name: 'driftengine-examples', provides: SCRIPTED },
    }),
    {
      /* No page here has a favicon, and the browser's own request for one would otherwise be the
         only console error an example prints. */
      name: 'examples-favicon',
      configureServer(server) {
        server.middlewares.use('/favicon.ico', (_request, response) => {
          response.statusCode = 204;
          response.end();
        });
      },
    } satisfies Plugin,
  ],
  server: { host: true },
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
