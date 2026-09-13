/**
 * The island solve's state, mirrored into one buffer a worker can see.
 *
 * **This is a copy and not a re-allocation of the live sets, and that is a deliberate reversal of
 * what the design document proposed.** The first plan gave `BodySet`, `ContactConstraints`,
 * `JointSet` and `IslandSet` an injected allocator so their arrays could be `SharedArrayBuffer`
 * directly, with no copy at all. Two things argued against it.
 *
 * The first is arithmetic, and it was measured rather than estimated after this comment first
 * claimed "under a tenth of one per cent" from a back-of-envelope that was wrong by more than an
 * order of magnitude. `StagedExecutor` against `SerialExecutor` on one machine, 2026-09-05:
 *
 * | stacks of ten | serial | staged | copy |
 * |---|---|---|---|
 * | 16 (160 bodies) | 3,202 us | 3,331 us | **4.0%** |
 * | 64 (640 bodies) | 13,381 us | 13,187 us | **within noise, and negative** |
 * | 256 (2,560 bodies) | 60,951 us | 61,987 us | **1.7%** |
 *
 * So the round trip is one to four per cent of a tick and not a tenth of one, which is still small
 * against a pool measured at 1.26x on the same scene but is not nothing, and the 4% at the smallest
 * size is the shape to watch: the copy is `O(capacity)` while the solve is `O(work)`, so a world of
 * many bodies doing little is where this trade is worst.
 *
 * The second is blast radius. The allocator plan edited four classes that 524 tests stand on, for a
 * saving that does not show up. This edits none of them.
 *
 * **Nothing here maintains a list of fields.** `lanesOf` reflects over a set and takes every typed
 * array it finds, so a field added to `BodySet` tomorrow is staged tomorrow with nothing to
 * remember. `stage.test.ts` asserts that reflection against each class, because a mirror that
 * quietly omits a lane would be a defect that ships green: the solve would read a stale value and
 * the world would drift only where that lane mattered.
 */

import { BodySet } from './bodies.ts';
import { IslandSet } from './island.ts';
import { JointSet } from './joints.ts';
import { ContactConstraints } from './solver.ts';
import { DIAL_COUNT, solveIslandInto } from './islandSolve.ts';
import type { IslandSolveState } from './islandSolve.ts';
import type { Executor, IslandSolver } from './executor.ts';

/** Every typed array kind the four sets use. */
type Lane =
  | Float32Array<ArrayBufferLike>
  | Float64Array<ArrayBufferLike>
  | Int32Array<ArrayBufferLike>
  | Uint32Array<ArrayBufferLike>
  | Uint16Array<ArrayBufferLike>
  | Uint8Array<ArrayBufferLike>;

const KINDS = {
  Float32Array,
  Float64Array,
  Int32Array,
  Uint32Array,
  Uint16Array,
  Uint8Array,
} as const;

type KindName = keyof typeof KINDS;

/** Where one typed array sits in the staging buffer. Plain data, so it crosses `postMessage`. */
export interface LanePlan {
  set: string;
  name: string;
  kind: KindName;
  offset: number;
  length: number;
}

/** The whole mirror's shape, posted to a worker once and again whenever a set grows. */
export interface StagePlan {
  lanes: LanePlan[];
  bytes: number;
}

/* Slots in the counts lane, which carries the scalars the solve and its callers read. */
export const COUNT_BODIES = 0;
export const COUNT_CONSTRAINTS = 1;
export const COUNT_POINTS = 2;
export const COUNT_JOINTS = 3;
export const COUNT_ISLANDS = 4;
export const COUNT_SLOTS = 5;

/**
 * Every typed array a set owns, by field name.
 *
 * Reflection and not a written list: `Object.entries` walks own enumerable properties in insertion
 * order, which for these classes is constructor assignment order, and `grow` reassigns rather than
 * adds so the order survives. The object arrays `BodySet` keeps for shapes are not views and drop
 * out here, which is correct — the solve never reads them.
 */
export function lanesOf(set: object): Record<string, Lane> {
  const out: Record<string, Lane> = {};
  for (const [name, value] of Object.entries(set)) {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) out[name] = value as Lane;
  }
  return out;
}

/**
 * One typed array into another of the same kind.
 *
 * The cast is here and nowhere else. `Lane` is a union, so `into.set(from)` cannot typecheck
 * against it however the two are narrowed; every pair this is called with was planned from one
 * reflected field, so the kinds are equal by construction.
 */
function copyLane(into: Lane, from: Lane): void {
  (into as Float32Array<ArrayBufferLike>).set(from as unknown as Float32Array<ArrayBufferLike>);
}

function kindOf(lane: Lane): KindName {
  const name = lane.constructor.name as KindName;
  if (!(name in KINDS)) throw new Error(`physics: no staging kind for ${name}`);
  return name;
}

/** Round an offset up so every view starts aligned for its element size. Eight covers them all. */
function aligned(at: number): number {
  return (at + 7) & ~7;
}

/**
 * A live world's solve state, and the mirror of it a pool works in.
 *
 * The mirror is authoritative for the length of a tick: `push` fills it, every character solves into
 * it, `pull` takes the result back. The caller solves its own share in the mirror too, so there is
 * one set of views and not a main-thread copy racing a worker's.
 */
export class SolveStage {
  buffer: ArrayBufferLike;
  plan: StagePlan;
  /** Bumped whenever the plan changes, which is how a worker knows its views are stale. */
  generation = 0;

  private views = new Map<string, Lane>();
  private live: IslandSolveState;
  private mirror!: IslandSolveState;
  private counts!: Int32Array<ArrayBufferLike>;

  private readonly alloc: (bytes: number) => ArrayBufferLike;

  constructor(live: IslandSolveState, alloc: (bytes: number) => ArrayBufferLike) {
    this.alloc = alloc;
    this.live = live;
    this.plan = SolveStage.planFor(live);
    this.buffer = alloc(this.plan.bytes);
    this.build();
  }

  /** The state a character solves into. Never the live one. */
  get state(): IslandSolveState {
    return this.mirror;
  }

  /**
   * Re-plan when a set has grown, and report whether anything moved.
   *
   * A grow doubles a capacity, so this is true about `log2(n)` times in a world's life and false on
   * every other tick. `PhysicsWorld` only grows outside `step`, so a plan can never change under a
   * running solve.
   */
  resize(): boolean {
    const next = SolveStage.planFor(this.live);
    if (next.bytes === this.plan.bytes && next.lanes.length === this.plan.lanes.length) {
      let same = true;
      for (let i = 0; i < next.lanes.length && same; i++) {
        const a = next.lanes[i] as LanePlan;
        const b = this.plan.lanes[i] as LanePlan;
        same =
          a.offset === b.offset && a.length === b.length && a.name === b.name && a.set === b.set;
      }
      if (same) return false;
    }
    this.plan = next;
    this.buffer = this.alloc(next.bytes);
    this.generation += 1;
    this.build();
    return true;
  }

  /** Copy the live sets into the mirror, dials and counts included. */
  push(islandCount: number): void {
    const live = this.liveLanes();
    for (const [key, into] of this.views) {
      const from = live.get(key);
      if (from) copyLane(into, from);
    }
    copyLane(this.mirror.dials, this.live.dials);
    this.counts[COUNT_BODIES] = this.live.bodies.count;
    this.counts[COUNT_CONSTRAINTS] = this.live.constraints.count;
    this.counts[COUNT_POINTS] = this.live.constraints.points;
    this.counts[COUNT_JOINTS] = this.live.joints.count;
    this.counts[COUNT_ISLANDS] = islandCount;
    this.applyCounts(islandCount);
  }

  /**
   * Copy the mirror back over the live sets.
   *
   * Every lane and not a list of the ones the solve writes. A whitelist would be faster by the
   * width of the read-only lanes and would be wrong the first time somebody made a read-only lane
   * writable, silently and only in the pool. The copy is already beneath the noise floor.
   */
  pull(): void {
    const live = this.liveLanes();
    for (const [key, from] of this.views) {
      const into = live.get(key);
      if (into) copyLane(into, from);
    }
  }

  /** The live sets' arrays, keyed the way the plan keys them. Rebuilt per call because `grow`
      replaces the arrays and a cached view would then write into a buffer nothing reads. */
  private liveLanes(): Map<string, Lane> {
    const out = new Map<string, Lane>();
    const sets: [string, object][] = [
      ['bodies', this.live.bodies],
      ['constraints', this.live.constraints],
      ['joints', this.live.joints],
      ['islands', this.live.islands],
    ];
    for (const [set, owner] of sets) {
      for (const [name, lane] of Object.entries(lanesOf(owner))) out.set(`${set}.${name}`, lane);
    }
    return out;
  }

  private applyCounts(islandCount: number): void {
    const m = this.mirror;
    m.bodies.count = this.live.bodies.count;
    m.constraints.count = this.live.constraints.count;
    m.constraints.points = this.live.constraints.points;
    m.joints.count = this.live.joints.count;
    m.islands.count = islandCount;
  }

  private build(): void {
    const built = SolveStage.adopt(this.buffer, this.plan);
    this.views = built.views;
    this.mirror = built.state;
    this.counts = built.counts;
  }

  /** Lay out every lane of every set, plus the dial and count blocks the worker reads. */
  static planFor(live: IslandSolveState): StagePlan {
    const lanes: LanePlan[] = [];
    let at = 0;
    const take = (set: string, name: string, kind: KindName, length: number): void => {
      at = aligned(at);
      lanes.push({ set, name, kind, offset: at, length });
      at += length * KINDS[kind].BYTES_PER_ELEMENT;
    };
    const sets: [string, object][] = [
      ['bodies', live.bodies],
      ['constraints', live.constraints],
      ['joints', live.joints],
      ['islands', live.islands],
    ];
    for (const [name, set] of sets) {
      for (const [field, lane] of Object.entries(lanesOf(set))) {
        take(name, field, kindOf(lane), lane.length);
      }
    }
    take('meta', 'dials', 'Float64Array', DIAL_COUNT);
    take('meta', 'counts', 'Int32Array', COUNT_SLOTS);
    return { lanes, bytes: aligned(at) };
  }

  /**
   * Rebuild the mirror's views over a buffer. The worker's whole share of the layout question.
   *
   * The sets are real instances with their arrays swapped, so `solveIslandInto` takes them without
   * a cast and without a structural type that would have to be kept in step with four classes.
   * **They are solve-only**: their private capacities describe the throwaway allocation the
   * constructor made, so `add` and `grow` must never be called on one. Nothing in the solve path
   * reads a capacity, which is what makes that safe.
   */
  static adopt(
    buffer: ArrayBufferLike,
    plan: StagePlan,
  ): {
    state: IslandSolveState;
    views: Map<string, Lane>;
    counts: Int32Array<ArrayBufferLike>;
    dials: Float64Array<ArrayBufferLike>;
  } {
    const views = new Map<string, Lane>();
    let dials: Float64Array<ArrayBufferLike> = new Float64Array(DIAL_COUNT);
    let counts: Int32Array<ArrayBufferLike> = new Int32Array(COUNT_SLOTS);
    for (const lane of plan.lanes) {
      const view = new KINDS[lane.kind](buffer as ArrayBuffer, lane.offset, lane.length) as Lane;
      if (lane.set === 'meta') {
        if (lane.name === 'dials') dials = view as Float64Array<ArrayBufferLike>;
        else counts = view as Int32Array<ArrayBufferLike>;
        continue;
      }
      views.set(`${lane.set}.${lane.name}`, view);
    }

    const state: IslandSolveState = {
      bodies: new BodySet(1),
      constraints: new ContactConstraints(1),
      joints: new JointSet(1),
      islands: new IslandSet(1),
      dials,
    };
    for (const [key, view] of views) {
      const [set, name] = key.split('.') as [string, string];
      const owner =
        set === 'bodies'
          ? state.bodies
          : set === 'constraints'
            ? state.constraints
            : set === 'joints'
              ? state.joints
              : state.islands;
      /* One cast, at the one place a field name is a string. Every name came from reflecting over
         the same class this is writing back to, so there is no name here that class does not have. */
      (owner as unknown as Record<string, Lane>)[name] = view;
    }
    state.bodies.count = counts[COUNT_BODIES] ?? 0;
    state.constraints.count = counts[COUNT_CONSTRAINTS] ?? 0;
    state.constraints.points = counts[COUNT_POINTS] ?? 0;
    state.joints.count = counts[COUNT_JOINTS] ?? 0;
    state.islands.count = counts[COUNT_ISLANDS] ?? 0;
    return { state, views, counts, dials };
  }
}

/** The default allocator. A pool replaces it with one that returns a `SharedArrayBuffer`. */
export const heapAlloc = (bytes: number): ArrayBufferLike => new ArrayBuffer(bytes);

/**
 * The pool, minus the threads.
 *
 * **This exists to split one question into two.** A pooled tick does four things: mirror the state,
 * hand islands out, solve them somewhere else, copy the result back. Three of those are the mirror
 * and one is the threading, and a divergence in a pooled world is otherwise a bug report that could
 * be either. This character does everything the pool does except the part that needs a worker, so
 * `stage.test.ts` can hold the mirror to bit-identical physics with nothing concurrent in the
 * picture, and a later failure in `workerPool.test.ts` is threading by elimination.
 *
 * It is also what a runtime with no `Worker` gets when a consumer asked for one and there is none,
 * which makes the fallback path a tested path instead of an untested one.
 */
export class StagedExecutor implements Executor {
  readonly name: string = 'staged';

  private stage: SolveStage | null = null;

  private readonly alloc: (bytes: number) => ArrayBufferLike;

  constructor(alloc: (bytes: number) => ArrayBufferLike = heapAlloc) {
    this.alloc = alloc;
  }

  /** The mirror, once a tick has built one. A pool subclassing this reads its buffer to post it. */
  protected get staged(): SolveStage | null {
    return this.stage;
  }

  run(count: number, solver: IslandSolver): void {
    const live = solver.solveState;
    if (!live) {
      /* A consumer's own `IslandSolver` owes us no flat state, and correct physics beats staged
         physics. Nothing here warns: `PhysicsWorld` always provides it, so this is unreachable
         from the engine and is a courtesy to anybody implementing the seam themselves. */
      for (let i = 0; i < count; i++) solver.solveIsland(i);
      return;
    }
    const stage = this.mirror(live);
    stage.push(count);
    if (this.solve(count, stage)) {
      stage.pull();
      return;
    }
    /*
     * The mirror is abandoned rather than copied back, and the tick is re-run against the live
     * state. That is only sound because `pull` has not happened: the live sets still hold what they
     * held before `push`, so a half-finished mirror is discarded whole and nothing partial reaches
     * the world. A pool whose worker died takes this path once and then reports itself serial.
     */
    for (let i = 0; i < count; i++) solver.solveIsland(i);
  }

  /**
   * Where a pool forks instead. Serial here, so the mirror can be judged on its own.
   *
   * Returns whether the mirror holds a finished tick. False sends the caller back to the live state,
   * so a character that cannot complete must say so instead of leaving a partial result to be copied.
   */
  protected solve(count: number, stage: SolveStage): boolean {
    for (let i = 0; i < count; i++) solveIslandInto(stage.state, i);
    return true;
  }

  private mirror(live: IslandSolveState): SolveStage {
    if (this.stage === null) {
      this.stage = new SolveStage(live, this.alloc);
      return this.stage;
    }
    this.stage.resize();
    return this.stage;
  }
}
