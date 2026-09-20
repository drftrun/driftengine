/**
 * The module loading a published scene needs that Node does not do by itself, installed with
 * `--import` before any of the engine's code is read.
 *
 * **A scene can import a DriftScript module**, and the voxel sandbox does (`mobs.drs`). The dev
 * harness and the test runner compile `.drs` through the language's own Vite plugin; Node has no
 * bundler, so this runs the same plugin's transform from a loader hook. Its context asks for one
 * method, `addWatchFile`, which only a bundler watching for edits needs.
 *
 * Plain JavaScript, because it is what makes the host's TypeScript loadable and so has to load
 * without it. `registerHooks` rather than `register`: it runs on this thread, so nothing crosses to a
 * loader worker, and hooks added after tsx's run first.
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { driftScript } from 'driftscript/vite';

const plugin = driftScript();
const context = { addWatchFile() {} };

registerHooks({
  load(url, hookContext, nextLoad) {
    if (!url.endsWith('.drs')) return nextLoad(url, hookContext);
    const path = fileURLToPath(url);
    const compiled = plugin.transform.call(context, readFileSync(path, 'utf8'), path);
    if (compiled === null) throw new Error(`[driftengine] ${path} did not compile`);
    return { format: 'module', source: compiled.code, shortCircuit: true };
  },
});
