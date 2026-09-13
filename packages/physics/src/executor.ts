/**
 * Who runs the islands, and the gate that proves it does not matter.
 *
 * **No two islands share a body.** That is the definition, so solving them in any order, or
 * simultaneously, produces bit-identical state provided each island's internal order is fixed —
 * which it is, by body index. Parallelism across islands therefore carries no determinism risk at
 * all, and the deployment constraint that gates a worker pool decides only *which character runs*.
 *
 * `ShuffledExecutor` exists to assert exactly that. It solves in reverse order, and a gate runs one
 * scene through both characters and compares the state. One `solveIsland`, two characters, and a test
 * proving they agree — which is what the rule about two implementations drifting actually asks for,
 * since it forbids two implementations of one decision rather than two characters of one.
 *
 * **A worker pool over `SharedArrayBuffer` shipped 2026-09-05**, and what it measured is not what
 * the plan for it predicted. `workerPool.ts` is the pool, `stage.ts` is the mirror it works in, and
 * `islandWorker.ts` is the far end. A consumer opts in with `new PhysicsWorld({ workers: 4, pool:
 * createIslandPool })` and gets serial physics with a sentence in `parallelism.reason` wherever that
 * cannot be honoured.
 *
 * **The deployment constraint is real and unchanged.** On a page that is not cross-origin isolated
 * `SharedArrayBuffer` is not defined at all; with `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` it exists, and `Atomics.wait` still answers
 * `TypeError: Atomics.wait cannot be called in this context` on the main thread. So the caller
 * blocks where it may and spins where it may not, deciding by trying it rather than by sniffing for
 * `window`, and it claims its own share first so the spin covers the imbalance and not the solve.
 * `require-corp` still lands on the consumer's whole site, which is why this is a switch they throw.
 *
 * **What the pool is worth, measured on a 24-core desktop, 256 islands of ten boxes:**
 *
 * | workers | 1 | 2 | 4 | 8 |
 * |---|---|---|---|---|
 * | speedup | 1.05x | 1.22x | 1.26x | 1.39x |
 *
 * The old note here predicted 2x to 4x from Amdahl and the solve share. **It is 1.4x at eight
 * workers**, and the staging copy accounts for 1.7% of that gap and no more. Nothing has measured
 * what accounts for the rest, so nothing here names a cause. Two bounds do hold and both are
 * scene-dependent: Amdahl's, from the solve share `island-bench.ts` prints, and `total island cost /
 * largest island cost`, which is why a hundred jointed boxes gain nothing at any worker count.
 *
 * **`DisjointExecutor` below is the reason any of this is safe**, and it is worth more than the pool:
 * it fails when two islands write one body, which is the assumption a pool cannot survive losing and
 * which no other test in this package would notice.
 */

import type { BodySet } from './bodies.ts';
import type { IslandSolveState } from './islandSolve.ts';

/** Something that can advance one island through a whole tick. */
export interface IslandSolver {
  solveIsland(island: number): void;
  /**
   * The same solve as flat state, for a character that works somewhere else.
   *
   * `SerialExecutor` and `ShuffledExecutor` call `solveIsland` and never read this. A staged or
   * pooled character cannot: it solves a mirror of this state in shared memory, so it needs the state
   * and not the method that closes over the live one. Optional because `Executor` is a seam a
   * consumer may implement, and a character of their own owes nothing here.
   */
  readonly solveState?: IslandSolveState;
}

export interface Executor {
  /** A name, so a figure taken from a benchmark says which character produced it. */
  readonly name: string;
  run(count: number, solver: IslandSolver): void;
  /**
   * Release whatever the character holds. A pool terminates its workers.
   *
   * Optional, and declared here rather than tested for with `instanceof`, because reaching the pool
   * class from `world.ts` would put the whole pool in every consumer's bundle — including the ones
   * that never ask for a worker. Measured at 2,629 bytes gzipped, which is the difference between
   * this seam being a seam and being a static dependency.
   */
  dispose?(): void;
  /**
   * Set once a character has given up and gone serial, with a sentence saying why. Null while healthy.
   */
  readonly failure?: string | null;
}

export class SerialExecutor implements Executor {
  readonly name = 'serial';

  run(count: number, solver: IslandSolver): void {
    for (let i = 0; i < count; i++) solver.solveIsland(i);
  }
}

/**
 * Reverse order, and it is a gate rather than a character anybody should choose.
 *
 * Reversal rather than a random permutation because `Math.random` is banned on this path and a
 * seeded generator would be one more thing whose sequence has to be frozen. Reversal is the
 * strongest single permutation available for free: it moves every element.
 */
export class ShuffledExecutor implements Executor {
  readonly name = 'shuffled';

  run(count: number, solver: IslandSolver): void {
    for (let i = count - 1; i >= 0; i--) solver.solveIsland(i);
  }
}

/** Which body two islands both wrote, and which two they were. */
export interface IslandOverlap {
  body: number;
  first: number;
  second: number;
}

/**
 * The premise, turned into something that fails.
 *
 * **A worker pool is safe here because two islands never write the same body**, and that is an
 * argument about four guards rather than a property anything checks. `applyImpulse` and
 * `applyLinear` write only where `invMass > 0`; `applyAngular` writes only where the body is
 * dynamic; `integrateVelocities` and `integratePositions` walk `bodyOrder`, which `island.ts` fills
 * with dynamic indices alone. A static floor under two towers is read by both and written by
 * neither.
 *
 * **One unguarded write to a static body would break the pool and nothing else.** Serial physics
 * would stay correct, every existing test would stay green, and the pool would produce a state that
 * depends on which worker got there first — on some ticks, on some machines. That is a defect that
 * ships green, so this character exists to make it a red test instead of a bug report.
 *
 * It compares **bits** and not values, because the question is whether a write happened at all and
 * `-0` over `0` is a write. It needs no threads and no timing, so it cannot be flaky in either
 * direction: the overlap it reports is a real one and its silence is a real absence.
 *
 * **A gate and not a character.** Cost is one pass over every body per island, so a scene of a thousand
 * singletons costs a million lane compares a tick. `SerialExecutor` remains the default.
 */
export class DisjointExecutor implements Executor {
  readonly name = 'disjoint';

  /** Set by `run` when two islands wrote one body. Null after a clean tick. */
  overlap: IslandOverlap | null = null;

  private lanes: Uint32Array[] = [];
  private snapshot = new Uint32Array(0);
  private owner = new Int32Array(0);

  private readonly bodies: BodySet;

  constructor(bodies: BodySet) {
    this.bodies = bodies;
  }

  run(count: number, solver: IslandSolver): void {
    const n = this.bodies.count;
    this.bind(n);
    this.owner.fill(-1, 0, n);
    this.overlap = null;

    for (let island = 0; island < count; island++) {
      this.capture(n);
      solver.solveIsland(island);
      this.claim(island, n);
    }
  }

  /**
   * Rebuild the bit views, every run.
   *
   * `BodySet.grow` replaces the arrays outright, so a view held from a previous tick can be over a
   * buffer nothing writes any more — which would read as a tick where no island wrote anything, the
   * one failure this class must not have. Thirteen typed-array constructions a tick is nothing a
   * gate needs to avoid.
   */
  private bind(n: number): void {
    const b = this.bodies;
    const bits = (a: Float32Array): Uint32Array =>
      new Uint32Array(a.buffer, a.byteOffset, a.length);
    this.lanes = [
      bits(b.posX),
      bits(b.posY),
      bits(b.posZ),
      bits(b.rotX),
      bits(b.rotY),
      bits(b.rotZ),
      bits(b.rotW),
      bits(b.velX),
      bits(b.velY),
      bits(b.velZ),
      bits(b.angX),
      bits(b.angY),
      bits(b.angZ),
    ];
    const wanted = this.lanes.length * n;
    if (this.snapshot.length < wanted) this.snapshot = new Uint32Array(wanted);
    if (this.owner.length < n) this.owner = new Int32Array(n);
  }

  private capture(n: number): void {
    for (let l = 0; l < this.lanes.length; l++) {
      const lane = this.lanes[l] as Uint32Array;
      const at = l * n;
      for (let i = 0; i < n; i++) this.snapshot[at + i] = lane[i] as number;
    }
  }

  /**
   * Whoever changed a body's bits owns it, and a second owner is the finding.
   *
   * The first overlap is kept rather than the last, so a run reports where the invariant broke
   * first instead of wherever the scan happened to end.
   */
  private claim(island: number, n: number): void {
    for (let i = 0; i < n; i++) {
      let wrote = false;
      for (let l = 0; l < this.lanes.length && !wrote; l++) {
        const lane = this.lanes[l] as Uint32Array;
        if (lane[i] !== this.snapshot[l * n + i]) wrote = true;
      }
      if (!wrote) continue;
      const held = this.owner[i] ?? -1;
      if (held >= 0 && held !== island) {
        this.overlap ??= { body: i, first: held, second: island };
        continue;
      }
      this.owner[i] = island;
    }
  }
}
