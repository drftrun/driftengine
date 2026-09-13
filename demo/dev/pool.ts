/**
 * The island pool, in the place it is actually for.
 *
 * **Node proves the pool is correct; only a browser proves it can exist.** `workerPool.test.mjs`
 * compares bits across real threads, and it runs in a runtime where `SharedArrayBuffer` is always
 * defined and `Atomics.wait` is always allowed on the calling thread. Neither is true on a page, and
 * the two facts that decide whether a consumer can have this at all are exactly the two Node cannot
 * be asked about.
 *
 * So this page answers them out loud: whether the document is cross-origin isolated, which
 * `Cross-Origin-Embedder-Policy` got it there, whether `Atomics.wait` throws on the main thread, and
 * then whether a four-worker pool reaches the same bits as the serial runner while demonstrably
 * doing the work. `scripts/physics-pool-check.mjs` reads the result off `globalThis`.
 *
 * The worker is built by the package default here — `new Worker(new URL('./islandWorker.ts',
 * import.meta.url), { type: 'module' })` — because a page served by Vite is the case that default
 * exists for, and a check that passed a `spawn` of its own would be testing the escape hatch.
 */
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  PhysicsWorld,
  boxShape,
  fingerprintBodies,
} from '@driftengine/physics';
/* A second specifier, deliberately: the barrel names no worker, so importing `PhysicsWorld` does
   not put one in a consumer's bundle. `workers.ts` carries the measurement. */
import { createIslandPool } from '@driftengine/physics/src/workers.ts';

const DT = 1 / 60;

function scene(world: PhysicsWorld, stacks: number, high: number): void {
  world.addBody({ type: BODY_STATIC, shape: boxShape(2000, 1, 2000), y: -1, friction: 0.8 });
  for (let s = 0; s < stacks; s++) {
    for (let i = 0; i < high; i++) {
      world.addBody({
        type: BODY_DYNAMIC,
        shape: boxShape(0.5, 0.5, 0.5),
        x: s * 6,
        y: 0.5 + i * 1.02,
        density: 500,
        friction: 0.8,
      });
    }
  }
}

/** Whether this thread may block, asked the same way `workerPool.ts` asks it. */
function mainThreadCanBlock(): boolean {
  try {
    if (typeof SharedArrayBuffer === 'undefined') return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
    return true;
  } catch {
    return false;
  }
}

async function run(): Promise<Record<string, unknown>> {
  const environment = {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    atomicsWaitOnMainThread: mainThreadCanBlock(),
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
  };

  const serial = new PhysicsWorld({ allowSleep: false });
  const pooled = new PhysicsWorld({ allowSleep: false, workers: 4, pool: createIslandPool });
  scene(serial, 40, 5);
  scene(pooled, 40, 5);

  /* A worker takes a moment to spawn and adopt; the first ticks would otherwise be solved entirely
     on this thread and the engagement figure would understate what a running page does. */
  await new Promise((done) => setTimeout(done, 300));

  let agreed = true;
  let firstDisagreement = -1;
  for (let tick = 0; tick < 120; tick++) {
    serial.step(DT);
    pooled.step(DT);
    if (fingerprintBodies(pooled.bodies) !== fingerprintBodies(serial.bodies)) {
      agreed = false;
      if (firstDisagreement < 0) firstDisagreement = tick;
    }
  }

  const executor = pooled.executor as { solvedPerWorker?: number[]; failure?: string | null };
  const solved = executor.solvedPerWorker ?? [];
  const result = {
    ...environment,
    requested: pooled.parallelism.requested,
    running: pooled.parallelism.running,
    reason: pooled.parallelism.reason,
    solvedPerWorker: solved,
    islandsOffThisThread: solved.reduce((a, b) => a + b, 0),
    failure: executor.failure ?? null,
    agreed,
    firstDisagreement,
  };
  pooled.dispose();
  return result;
}

run().then(
  (result) => {
    (globalThis as { __poolCheck?: unknown }).__poolCheck = result;
    const out = document.getElementById('out');
    if (out) out.textContent = JSON.stringify(result, null, 2);
  },
  (error: unknown) => {
    const failed = { error: String((error as Error)?.message ?? error) };
    (globalThis as { __poolCheck?: unknown }).__poolCheck = failed;
    const out = document.getElementById('out');
    if (out) out.textContent = JSON.stringify(failed, null, 2);
  },
);
