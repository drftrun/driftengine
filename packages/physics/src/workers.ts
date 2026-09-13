/**
 * The island worker pool, behind its own specifier.
 *
 * **Because a bundler emits the worker before it decides the pool is unreachable.** `workerPool.ts`
 * builds its worker with `new Worker(new URL('./islandWorker.ts', import.meta.url))`, and Vite's
 * `vite:worker-import-meta-url` rewrites that at *transform* time, which happens before
 * tree-shaking. So a barrel that merely re-exported `createIslandPool` put the worker in the module
 * graph, and the chunk was written to disk whether or not anything could ever fetch it.
 *
 * Reported by a consumer on 2026-09-05 and reproduced on a second the same day: **37,913 bytes raw
 * and 12,259 gzipped**, in a build where `WorkerPoolExecutor`, `StagedExecutor`, `createIslandPool`
 * and `SolveStage` were all absent from every other chunk and nothing under `dist/` named the
 * worker. Tree-shaking had done its half and the asset was already on disk.
 *
 * **This is the same decision 3.54.0 made and half of it was missed.** That release moved the pool
 * factory to the call site rather than have `PhysicsWorld` reach it, to avoid *"2,629 bytes gzipped
 * into every consumer's bundle, including everyone who never asks for a worker"*. The measured
 * weight of the half that was missed is 4.7 times the one that was caught, landing on exactly the
 * consumer that reasoning was written to protect.
 *
 * A caller already had to name the factory for that reason, so the cost of the fix is the specifier
 * and nothing else:
 *
 * ```ts
 * import { PhysicsWorld } from '@driftengine/physics';
 * import { createIslandPool } from '@driftengine/physics/src/workers.ts';
 *
 * const world = new PhysicsWorld({ workers: 4, pool: createIslandPool });
 * ```
 *
 * `scripts/worker-entry.test.mjs` bundles the barrel and asserts it names no worker, because every
 * gate in this repository passed while the chunk was shipping.
 */

export type { PoolOutcome, PoolRequest, PoolWorker } from './workerPool.ts';
export { WorkerPoolExecutor, createIslandPool } from './workerPool.ts';
export type { LanePlan, StagePlan } from './stage.ts';
export { SolveStage, StagedExecutor } from './stage.ts';
