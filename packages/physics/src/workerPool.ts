/**
 * Islands solved on other threads, and every way that can decline to happen.
 *
 * **The handshake was never the problem.** `executor.ts` measured a fork-join over a
 * `SharedArrayBuffer` at 11.8 microseconds for four workers against 2.6 milliseconds of solve. What
 * stops a pool is that `SharedArrayBuffer` does not exist on a page that is not cross-origin
 * isolated, and that is a header on the consumer's site rather than anything the engine can arrange.
 * So this module's real subject is the four ways it can fail to start and the one way it must never
 * fail: quietly.
 *
 * **Islands are claimed with `Atomics.add` on a cursor, which balances load and costs nothing.**
 * Handing work out in arrival order is normally a determinism hazard. It is not one here, because
 * two islands never write the same body — the property `DisjointExecutor` asserts — so the result
 * does not depend on who solved what or when. A pool of eight and a pool of one produce the same
 * bits, and so does the serial runner.
 *
 * **The caller solves its own share.** That is what keeps the join short on a browser's main thread,
 * where `Atomics.wait` throws and the wait has to be a spin: by the time the caller runs out of
 * islands to claim, the only thing left to wait for is the imbalance.
 */

import { solveIslandInto } from './islandSolve.ts';
import { SolveStage, StagedExecutor } from './stage.ts';
import type { Executor } from './executor.ts';

/**
 * The part of a worker this pool uses.
 *
 * A browser `Worker` satisfies it and so does `node:worker_threads`, which is what lets the gate run
 * the real entry point in Node instead of a stand-in that would prove nothing about threads.
 */
export interface PoolWorker {
  postMessage(value: unknown): void;
  terminate(): void | Promise<number>;
}

/* Slots in the control block, which is its own buffer and outlives every re-plan of the stage. */
export const CTL_EPOCH = 0;
export const CTL_CURSOR = 1;
export const CTL_ISLANDS = 2;
export const CTL_DONE = 3;
export const CTL_ACK = 4;
export const CTL_RELOAD = 5;
export const CTL_STOP = 6;
/** One slot per worker from here, counting the islands it has solved. */
export const CTL_SOLVED = 7;

/** How long a join waits before it gives up on a worker and solves the tick itself. */
const JOIN_DEADLINE_MS = 250;

/** What a consumer asked for. */
export interface PoolRequest {
  workers: number;
  spawn?: () => PoolWorker;
}

/** What they got, and why, in a sentence fit to put on a debug overlay. */
export interface PoolOutcome {
  executor: Executor | null;
  running: number;
  reason: string;
}

function sharedAlloc(bytes: number): ArrayBufferLike {
  return new SharedArrayBuffer(bytes);
}

/**
 * Whether this thread may block.
 *
 * `Atomics.wait` is refused on a browser's main thread and permitted everywhere else, including a
 * worker and Node. Asked by trying it, because the alternative is sniffing for `window` and being
 * wrong in every runtime nobody thought of. The probe waits zero milliseconds on a value that does
 * not match, so it returns `not-equal` immediately and blocks nothing.
 */
function canBlock(): boolean {
  try {
    const probe = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(probe, 0, 1, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a pool, or say why there is none.
 *
 * Never throws. Every path out sets a reason, because a consumer who asked for four workers and got
 * none is owed the difference between "your browser will not let me" and "your bundler could not
 * find the worker". A silent fallback here is a frame rate nobody can attribute, which is the exact
 * complaint `capabilityClamp` exists to answer elsewhere in this engine.
 */
export function createIslandPool(request: PoolRequest): PoolOutcome {
  const wanted = Math.max(0, Math.floor(request.workers));
  if (wanted === 0) return { executor: null, running: 0, reason: '' };

  if (typeof SharedArrayBuffer === 'undefined') {
    return {
      executor: null,
      running: 0,
      reason:
        'this page is not cross-origin isolated, so SharedArrayBuffer is undefined. Serve it with ' +
        'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp ' +
        '(or credentialless) to enable the pool.',
    };
  }

  const spawn = request.spawn ?? defaultSpawn;
  if (spawn === null) {
    return {
      executor: null,
      running: 0,
      reason: 'this runtime has no Worker, and no spawn was given.',
    };
  }

  const workers: PoolWorker[] = [];
  try {
    for (let i = 0; i < wanted; i++) workers.push(spawn());
  } catch (error) {
    for (const worker of workers) worker.terminate();
    const message = String((error as Error)?.message ?? error);
    return {
      executor: null,
      running: 0,
      reason:
        `the worker entry failed to load: ${message}. Pass a spawn option building the worker ` +
        'with your own bundler if it does not understand a worker entry point.',
    };
  }

  return { executor: new WorkerPoolExecutor(workers), running: workers.length, reason: '' };
}

/**
 * The worker this package ships, built the way a bundler understands.
 *
 * Vite, webpack 5 and Parcel all resolve `new URL('./x.ts', import.meta.url)` inside a `new Worker`.
 * A build that does not throws, which becomes a reason and serial physics — and `spawn` is the way
 * out, which is why this is a default and not the only path. Null where there is no `Worker` at all.
 */
const defaultSpawn: (() => PoolWorker) | null =
  typeof Worker === 'undefined'
    ? null
    : (): PoolWorker =>
        new Worker(new URL('./islandWorker.ts', import.meta.url), { type: 'module' }) as PoolWorker;

/**
 * The pool itself: `StagedExecutor` with the serial solve replaced by a fork and a join.
 *
 * Everything about mirroring the state is inherited, which is what lets `stage.test.ts` hold the
 * mirror to bit-identical physics with no threads in the picture and leaves this class responsible
 * for one question only.
 */
export class WorkerPoolExecutor extends StagedExecutor implements Executor {
  override readonly name = 'workers';

  /** Set when the pool has given up. Read by `PhysicsWorld` so `parallelism` stops claiming workers. */
  failure: string | null = null;

  private readonly control: Int32Array<ArrayBufferLike>;
  private readonly blocking = canBlock();
  private posted = -1;
  private started = false;

  private readonly workers: PoolWorker[];

  constructor(workers: PoolWorker[]) {
    super(sharedAlloc);
    this.workers = workers;
    this.control = new Int32Array(new SharedArrayBuffer((CTL_SOLVED + workers.length) * 4));
  }

  /** How many islands each worker has solved since the pool started. The engagement evidence. */
  get solvedPerWorker(): number[] {
    return this.workers.map((_, i) => Atomics.load(this.control, CTL_SOLVED + i));
  }

  /** Stop every worker. Idempotent, because a consumer may dispose a world twice. */
  dispose(): void {
    if (this.workers.length === 0) return;
    Atomics.store(this.control, CTL_STOP, 1);
    Atomics.add(this.control, CTL_EPOCH, 1);
    Atomics.notify(this.control, CTL_EPOCH);
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
  }

  /**
   * Fork, take a share, join. Returns false when the pool failed, which sends the tick back to the
   * live state and a serial solve.
   */
  protected override solve(count: number, stage: SolveStage): boolean {
    if (this.failure !== null || this.workers.length === 0) return false;
    const ctl = this.control;

    if (!this.started || stage.generation !== this.posted) {
      if (!this.reload(stage)) return false;
    }

    Atomics.store(ctl, CTL_CURSOR, 0);
    Atomics.store(ctl, CTL_ISLANDS, count);
    Atomics.store(ctl, CTL_DONE, 0);
    Atomics.add(ctl, CTL_EPOCH, 1);
    Atomics.notify(ctl, CTL_EPOCH);

    /* The caller's own share, from the same cursor, so what is left to wait for is the imbalance
       and not the solve. */
    for (;;) {
      const island = Atomics.add(ctl, CTL_CURSOR, 1);
      if (island >= count) break;
      solveIslandInto(stage.state, island);
    }

    return this.join();
  }

  /**
   * Wait for every worker to finish this epoch, and give up rather than freeze.
   *
   * **A worker that dies mid-island is the failure this deadline exists for.** Without it the join
   * spins until the tab is closed, which is a frozen game and the worst outcome available. With it
   * the tick is re-solved from the live state, which is untouched until `pull`, and the pool is
   * marked dead so every later tick is serial with a reason attached.
   */
  private join(): boolean {
    const ctl = this.control;
    const wanted = this.workers.length;
    const deadline = Date.now() + JOIN_DEADLINE_MS;
    for (;;) {
      const done = Atomics.load(ctl, CTL_DONE);
      if (done >= wanted) return true;
      if (Date.now() > deadline) {
        this.failure =
          'a worker stopped answering, so island solving went back to this thread. The world is ' +
          'correct and serial from here.';
        return false;
      }
      if (this.blocking) Atomics.wait(ctl, CTL_DONE, done, 50);
    }
  }

  /**
   * Hand the workers a new staging buffer and wait for them to adopt it.
   *
   * A worker parked in `Atomics.wait` cannot process a message, so it has to be let out first:
   * `CTL_RELOAD` is set, the epoch is bumped, and a woken worker returns to its event loop instead
   * of solving. It adopts the buffer in its message handler, acknowledges through `CTL_ACK`, and
   * parks again. Rare by construction — a re-plan happens when a set doubles, which is about
   * `log2(n)` times in a world's life and never inside a tick.
   */
  private reload(stage: SolveStage): boolean {
    const ctl = this.control;
    Atomics.store(ctl, CTL_ACK, 0);
    Atomics.store(ctl, CTL_RELOAD, 1);
    Atomics.add(ctl, CTL_EPOCH, 1);
    Atomics.notify(ctl, CTL_EPOCH);

    for (let i = 0; i < this.workers.length; i++) {
      (this.workers[i] as PoolWorker).postMessage({
        kind: 'stage',
        index: i,
        control: ctl.buffer,
        buffer: stage.buffer,
        plan: stage.plan,
      });
    }

    const deadline = Date.now() + JOIN_DEADLINE_MS;
    while (Atomics.load(ctl, CTL_ACK) < this.workers.length) {
      if (Date.now() > deadline) {
        this.failure =
          'the workers did not take the shared buffer, so island solving stayed on this thread.';
        return false;
      }
    }
    Atomics.store(ctl, CTL_RELOAD, 0);
    this.posted = stage.generation;
    this.started = true;
    return true;
  }
}
