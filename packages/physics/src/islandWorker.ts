/**
 * The worker end of the island pool.
 *
 * **It contains no physics.** It adopts views over the staging buffer, claims islands from a shared
 * cursor, and calls `solveIslandInto` — the same function `PhysicsWorld.solveIsland` calls. A
 * substep loop appearing in this file would be the defect the whole arrangement is shaped to
 * prevent, because a second copy of the solve order drifts from the first the first time either is
 * touched and nothing fails until a consumer's replay does.
 *
 * **It parks rather than polls.** `Atomics.wait` is permitted off a browser's main thread, so an
 * idle worker costs nothing between ticks and wakes on an epoch bump with no message sent.
 *
 * **Two hosts, one file.** A browser module worker delivers messages through `self.onmessage`;
 * `node:worker_threads` delivers them through `parentPort`. The difference is eight lines at the
 * bottom, and paying them is what lets the gate spawn this exact entry point in Node instead of a
 * stand-in that would prove nothing about threads.
 */

import { solveIslandInto } from './islandSolve.ts';
import type { IslandSolveState } from './islandSolve.ts';
import { SolveStage } from './stage.ts';
import type { StagePlan } from './stage.ts';
import {
  CTL_ACK,
  CTL_CURSOR,
  CTL_DONE,
  CTL_EPOCH,
  CTL_ISLANDS,
  CTL_RELOAD,
  CTL_SOLVED,
  CTL_STOP,
} from './workerPool.ts';

/** The only message this worker takes: here is the shared state, and here is who you are. */
interface StageMessage {
  kind: 'stage';
  index: number;
  control: ArrayBufferLike;
  buffer: ArrayBufferLike;
  plan: StagePlan;
}

let control: Int32Array<ArrayBufferLike> | null = null;
let state: IslandSolveState | null = null;
let index = 0;

/**
 * Take the shared buffers, say so, and park.
 *
 * The acknowledgement is an atomic and not a reply message because the caller is waiting on it
 * synchronously — it has just told every worker to come out of `Atomics.wait` and cannot process a
 * message of its own until the tick is over.
 */
function accept(message: StageMessage): void {
  if (message?.kind !== 'stage') return;
  control = new Int32Array(message.control as ArrayBuffer);
  index = message.index;
  state = SolveStage.adopt(message.buffer, message.plan).state;
  /*
   * **The epoch is read before the acknowledgement, and that order is the whole correctness of a
   * re-plan.** The caller parks on `CTL_ACK` and bumps the epoch the moment it completes. Read
   * after acknowledging and this worker can capture the epoch it was meant to wake for, then wait
   * for the one after it — sleeping through the tick, so the join never completes and the pool
   * declares itself dead. Reading first bounds `seen` below the next bump by construction.
   */
  const seen = Atomics.load(control, CTL_EPOCH);
  Atomics.add(control, CTL_ACK, 1);
  Atomics.notify(control, CTL_ACK);
  park(seen);
}

/** Claim islands until there are none, then report what was solved. */
function work(ctl: Int32Array<ArrayBufferLike>, solve: IslandSolveState): void {
  const count = Atomics.load(ctl, CTL_ISLANDS);
  let solved = 0;
  for (;;) {
    const island = Atomics.add(ctl, CTL_CURSOR, 1);
    if (island >= count) break;
    solveIslandInto(solve, island);
    solved += 1;
  }
  Atomics.add(ctl, CTL_SOLVED + index, solved);
  Atomics.add(ctl, CTL_DONE, 1);
  Atomics.notify(ctl, CTL_DONE);
}

/**
 * Sleep until the epoch moves, then either solve, stop, or go back to the event loop.
 *
 * Returning on `CTL_RELOAD` is the whole reason a re-plan works: a parked worker cannot receive a
 * `postMessage`, so the caller lets it out first and the pending message is delivered the moment
 * this function returns.
 */
function park(from: number): void {
  const ctl = control;
  if (ctl === null) return;
  let seen = from;
  for (;;) {
    Atomics.wait(ctl, CTL_EPOCH, seen);
    const epoch = Atomics.load(ctl, CTL_EPOCH);
    if (epoch === seen) continue;
    seen = epoch;
    if (Atomics.load(ctl, CTL_STOP) === 1) return;
    if (Atomics.load(ctl, CTL_RELOAD) === 1) return;
    if (state !== null) work(ctl, state);
  }
}

const scope = globalThis as unknown as {
  postMessage?: unknown;
  onmessage?: ((event: { data: StageMessage }) => void) | null;
};

if (typeof scope.postMessage === 'function') {
  scope.onmessage = (event: { data: StageMessage }): void => accept(event.data);
} else {
  /*
   * **No top-level await here, and that is a consumer's build rather than a preference.**
   *
   * `workerPool.ts` builds this with `new Worker(new URL('./islandWorker.ts', import.meta.url))`,
   * which every bundler detects statically and compiles as a worker whether or not the consumer
   * ever starts a pool. Vite's default worker format is `iife`, and an IIFE cannot carry a
   * top-level await: a consumer's production build answered `Module format "iife" does not support
   * top-level await` on 2026-09-05 and could not build at all. A dev server serves module workers
   * and never sees it, which is why `check:pool` passed over the same code.
   *
   * So the Node branch attaches its listener in a microtask instead. Nothing is missed: a Node
   * `MessagePort` queues messages until `on('message')` attaches, so a `postMessage` issued before
   * this resolves is delivered when it does.
   *
   * A variable specifier so a browser bundler leaves the import alone; this branch never runs in
   * one.
   */
  const nodeWorkers = 'node:worker_threads';
  void import(/* @vite-ignore */ nodeWorkers).then((mod) => {
    const { parentPort } = mod as {
      parentPort: { on(event: 'message', listener: (value: StageMessage) => void): void } | null;
    };
    parentPort?.on('message', accept);
  });
}
