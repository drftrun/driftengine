import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { HostWorker, installThreads } from './threads.ts';

/**
 * **What this file is for: real threads, and a simulation that does not care.** A browser gives a
 * page shared memory only when it is served with cross-origin isolation headers, which is a
 * constraint on every consumer's deployment. This host has no such rule, so the engine's own worker
 * pools run on real threads here with nothing asked of anybody. And the constraint that matters is
 * checked where it lives: the physics pool, stepped on threads, lands on the serial solver's bits at
 * every tick, so the simulation never consults the scheduling that threads bring.
 */

let dirs: string[] = [];
let undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A worker module on disk, as a file a browser would load by URL. */
function module(source: string): URL {
  const dir = mkdtempSync(join(tmpdir(), 'drift-thread-'));
  dirs.push(dir);
  const path = join(dir, 'worker.mjs');
  writeFileSync(path, source);
  return pathToFileURL(path);
}

function started(url: URL): HostWorker {
  const worker = new HostWorker(url);
  undo.push(() => worker.terminate());
  return worker;
}

describe('a thread, as a page’s Worker', () => {
  test('A WORKER TAKES A SHARED BUFFER, and what it writes is seen here through an atomic', async () => {
    const worker = started(
      module(`
        self.onmessage = (event) => {
          const view = new Int32Array(event.data);
          Atomics.store(view, 0, 42);
          Atomics.notify(view, 0);
        };
      `),
    );
    const view = new Int32Array(new SharedArrayBuffer(4));
    worker.postMessage(view.buffer);
    /* ES2024's, which this configuration's library predates; Node has had it since 16. */
    const waitAsync = (
      Atomics as unknown as {
        waitAsync(
          view: Int32Array,
          at: number,
          value: number,
          ms: number,
        ): { value: Promise<string> };
      }
    ).waitAsync;
    const waited = waitAsync(view, 0, 0, 5000);
    expect(await waited.value).toBe('ok');
    expect(Atomics.load(view, 0)).toBe(42);
  });

  test('A MESSAGE SENT BEFORE THE WORKER LISTENS IS HELD FOR IT, as a browser holds one', async () => {
    const worker = started(
      module(`
        await new Promise((resolve) => setTimeout(resolve, 50));
        self.addEventListener('message', (event) => postMessage(event.data * 2));
      `),
    );
    const answer = new Promise((resolve) => {
      worker.onmessage = (event) => resolve(event.data);
    });
    worker.postMessage(21);
    expect(await answer).toBe(42);
  });

  test('A WORKER THAT THROWS IS REPORTED, not lost', async () => {
    const worker = started(module(`throw new Error('the worker gave up');`));
    const said = await new Promise<string>((resolve) => {
      worker.addEventListener('error', (event) => resolve((event as ErrorEvent).message));
    });
    expect(said).toContain('the worker gave up');
  });

  test('THE PHYSICS POOL RUNS ON THREADS BY ITS OWN DEFAULT, with no isolation, and lands on the serial bits', async () => {
    /*
     * Installed before the engine's modules load, as a page's `Worker` exists before its scripts
     * run: the pool decides whether it has a default worker once, when it is imported.
     */
    undo.push(installThreads());
    vi.resetModules();
    const { BODY_DYNAMIC, BODY_STATIC } = await import('../../../packages/physics/src/bodies.ts');
    const { fingerprintBodies } = await import('../../../packages/physics/src/fingerprint.ts');
    const { boxShape } = await import('../../../packages/physics/src/shape.ts');
    const { PhysicsWorld } = await import('../../../packages/physics/src/world.ts');
    const { createIslandPool } = await import('../../../packages/physics/src/workerPool.ts');
    const serial = new PhysicsWorld({ allowSleep: false });
    /* No `spawn`: the pool builds its worker the way it does in a page, with `new Worker(...)`. */
    const pooled = new PhysicsWorld({ allowSleep: false, workers: 2, pool: createIslandPool });
    undo.push(() => pooled.dispose());
    expect(pooled.parallelism.running, pooled.parallelism.reason).toBeGreaterThanOrEqual(1);

    for (const world of [serial, pooled]) {
      world.addBody({ type: BODY_STATIC, shape: boxShape(200, 1, 200), y: -1, friction: 0.8 });
      for (let stack = 0; stack < 8; stack += 1) {
        for (let level = 0; level < 4; level += 1) {
          world.addBody({
            type: BODY_DYNAMIC,
            shape: boxShape(0.5, 0.5, 0.5),
            x: stack * 6,
            y: 0.5 + level * 1.02,
            density: 500,
            friction: 0.8,
          });
        }
      }
    }
    for (let tick = 0; tick < 120; tick += 1) {
      serial.step(1 / 60);
      pooled.step(1 / 60);
      expect(fingerprintBodies(pooled.bodies), `tick ${tick}`).toBe(
        fingerprintBodies(serial.bodies),
      );
    }
    /* And the threads did the work, rather than the pool falling back and agreeing by default. */
    const solved = (pooled.executor as unknown as { solvedPerWorker: number[] }).solvedPerWorker;
    expect(solved.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(120);
  }, 60_000);
});
