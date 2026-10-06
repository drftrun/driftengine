/**
 * The BC decode worker, behind its own specifier, for the reason `physics/src/workers.ts` gives.
 *
 * **A bundler emits a worker before it decides the code reaching it is unreachable.** The loader's
 * decoder built its worker with `new Worker(new URL('./bcWorker.ts', import.meta.url))` inside the
 * barrel's graph, and Vite rewrites that at transform time, before tree-shaking, so every consumer
 * importing anything from `@driftengine/assets` had the BC decoder's chunk written into its build,
 * whether or not it ever loaded a BC texture. It did so from 4.8.4 to 4.8.6;
 * `scripts/worker-entry.test.mjs` asserts that no barrel names a worker, and it skipped this barrel
 * whenever the packages were not built, which is how the chunk shipped past it.
 *
 * So a loader that should decode BC off the main thread names the factory:
 *
 * ```ts
 * import { DrftLoader } from '@driftengine/assets';
 * import { spawnBcWorker } from '@driftengine/assets/bcWorkers';
 *
 * const loader = new DrftLoader(renderer, { bcWorker: spawnBcWorker });
 * ```
 *
 * **A declared subpath, so it resolves the way the barrel does**: to the build by default and to
 * this file under `drift-source`. The path into `src/` that 4.8.7 documented still resolves, through
 * the manifest's `./*` passthrough, and hands every consumer TypeScript inside `node_modules`, which
 * is the default the 2026-09-13 flip took away from the barrels; a resolver that maps a package's
 * subpaths into `src/` also doubled it, to `src/src/bcWorkers.ts`.
 *
 * Without it BC textures decode on the main thread, and the loader says so once. **What that costs**
 * is the decode of a texture the device cannot take as blocks, which on a phone is every BC texture:
 * a 2048² BC7 image is 262,144 blocks.
 */
import type { BcWorker } from './bcLoad.ts';

/** A BC decode worker, as a bundler understands one. Throws where the runtime has no `Worker`. */
export function spawnBcWorker(): BcWorker {
  // platform: browser default — `DrftLoaderOptions.bcWorker` is the seam a host supplies
  return new Worker(new URL('./bcWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as BcWorker;
}
