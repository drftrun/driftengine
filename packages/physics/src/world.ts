import { BODY_DYNAMIC, BODY_SENSOR, BODY_STATIC, BodySet } from './bodies.ts';
import type { BodyDesc } from './bodies.ts';
import { shapeBounds } from './shape.ts';
import type { Aabb } from './collide/index.ts';
import { collideShapes, createManifold } from './manifold.ts';
import { MAX_MESH_MANIFOLDS, collideMesh, isMesh } from './meshContact.ts';
import {
  MAX_BODY_PARTS,
  MAX_PAIR_MANIFOLDS,
  collideCompound,
  partsBoundRadius,
} from './compoundContact.ts';

import type { Manifold, ShapePose } from './manifold.ts';
import { MAX_BODIES, PairSet, pairA, pairB, pairKey } from './pairs.ts';
import {
  ContactConstraints,
  applyRestitution,
  prepareContact,
  solveContacts,
  warmStart,
} from './solver.ts';
import type { FrictionModel } from './solver.ts';
import { DynamicTree } from './tree.ts';
import { overlapWorld, raycastWorld, shapecastWorld } from './query.ts';
import type { QueryFilter, RayHit } from './query.ts';
import type { ConvexShape } from './shape.ts';
import { ContactEvents } from './events.ts';
import { IslandSet } from './island.ts';
import { JointSet, resetJointImpulses, solveJoints } from './joints.ts';
import type { JointDesc } from './joints.ts';
import { SerialExecutor } from './executor.ts';
import type { Executor, IslandSolver } from './executor.ts';
import {
  DIAL_ALLOW_SLEEP,
  DIAL_ANGULAR_DAMPING,
  DIAL_CONTACT_DAMPING,
  DIAL_CONTACT_HERTZ,
  DIAL_COUNT,
  DIAL_DT,
  DIAL_FRICTION_MODEL,
  DIAL_GRAVITY_X,
  DIAL_GRAVITY_Y,
  DIAL_GRAVITY_Z,
  DIAL_ITERATIONS,
  DIAL_JOINT_DAMPING,
  DIAL_JOINT_HERTZ,
  DIAL_LINEAR_DAMPING,
  DIAL_SUBSTEPS,
  SLEEP_TICKS,
  bodyAsleep,
  frictionDial,
  solveIslandInto,
} from './islandSolve.ts';
import type { IslandSolveState } from './islandSolve.ts';
import type { PoolOutcome, PoolRequest, PoolWorker } from './workerPool.ts';

/**
 * A rigid body world, stepped on a fixed clock.
 *
 * **The tick order is the design, and every stage exists to keep the next one honest**: refresh the
 * broadphase, collect pairs *sorted by body index* so nothing carries tree shape forward, build
 * manifolds, then run N substeps of integrate-and-solve, one relax pass, and restitution once.
 *
 * **Substeps move a body inside a tick.** Only the state at the end of a tick is what a renderer's
 * `alpha` interpolates against; anything sampling mid-tick sees substep state, which is why contact
 * events are drained after the tick rather than raised during it.
 */

/** Options a consumer sets once. Every one of them is a quality or feel dial, not a contract. */
export interface WorldOptions {
  /** How many integrate-and-solve passes per tick. A quality dial: raising it changes nothing. */
  substeps?: number;
  /** Iterations per substep. */
  iterations?: number;
  gravityX?: number;
  gravityY?: number;
  gravityZ?: number;
  /** Contact stiffness as a frequency, which is what makes `substeps` a dial. */
  contactHertz?: number;
  contactDamping?: number;
  /** Joint stiffness, higher than a contact's because a joint is a structural relationship. */
  jointHertz?: number;
  jointDamping?: number;
  linearDamping?: number;
  angularDamping?: number;
  /** How far apart two shapes may be and still get a constraint. */
  speculativeMargin?: number;
  /** Whether settled islands stop being solved. On by default; off for a test isolating something. */
  allowSleep?: boolean;
  /**
   * How the two friction axes are bounded against each other. `box` by default. See `solver.ts`.
   *
   * **`elliptical` is the correct one and is not the default**, because every stacking result moves
   * under it — `fingerprintBodies`, both baselines, and any golden fingerprint or stored replay a
   * consumer has kept. A production engine does not silently invalidate those. What a
   * consumer gets by asking for it is friction that is the same in every direction, which is what
   * friction physically is; what a box gives instead is up to `sqrt(2)` more grip along the
   * diagonal of a tangent basis built from the contact normal, which is an artefact rather than a
   * fact about the world.
   */
  frictionModel?: FrictionModel;
  /**
   * How many workers solve islands. 0, the default, is the serial runner and changes nothing.
   *
   * **It needs a cross-origin isolated page.** Without one `SharedArrayBuffer` is undefined and the
   * pool cannot start; physics stays correct and serial and `parallelism.reason` says so. See
   * `workerPool.ts` for what the headers cost a consumer, which is why this is a switch and not a
   * default. Clamped to `hardwareConcurrency - 1` where the runtime reports one.
   */
  workers?: number;
  /**
   * Build one worker yourself.
   *
   * The default is `new Worker(new URL('./islandWorker.ts', import.meta.url), { type: 'module' })`,
   * which Vite, webpack 5 and Parcel resolve. Supply this when your build does not, or to point at
   * an entry of your own that imports `@driftengine/physics/src/islandWorker.ts`.
   */
  spawn?: () => PoolWorker;
  /**
   * What builds the pool. `createIslandPool` is the one this package ships.
   *
   * **Passed in rather than imported here, and the reason is a measurement made twice.** A
   * `PhysicsWorld` that reaches the pool on its own puts it in every consumer's bundle: 2,629 bytes
   * gzipped charged to everyone who never asks for a worker, in a package whose promise is that you
   * pay only for what you import.
   *
   * **That was half the problem and the other half cost 4.7 times as much.** Naming the factory at
   * the call site let tree-shaking drop the pool, and a bundler had already emitted the *worker* —
   * `new Worker(new URL(...))` is rewritten at transform time, before anything decides what is
   * reachable. Measured on two consumers on 2026-09-05: 12,259 bytes gzipped of worker chunk that
   * nothing in either bundle could fetch. So the factory left the barrel too; see `workers.ts`.
   *
   * ```ts
   * import { PhysicsWorld } from '@driftengine/physics';
   * import { createIslandPool } from '@driftengine/physics/src/workers.ts';
   *
   * const world = new PhysicsWorld({ workers: 4, pool: createIslandPool });
   * ```
   *
   * Asking for workers without it is not silent: `parallelism.reason` says exactly this.
   */
  pool?: (request: PoolRequest) => PoolOutcome;
}

/** What a world's island solving is actually doing, and why. */
export interface Parallelism {
  /** Workers the consumer asked for. */
  requested: number;
  /** Workers running. Zero with a non-empty `reason` is a working fallback, not a failure. */
  running: number;
  /** Empty when `running` matches `requested`. A whole sentence otherwise. */
  reason: string;
}

const IMPULSE_I = new Float32Array(6);
const SLEEP_LINEAR = 0.05;
const SLEEP_ANGULAR = 0.05;

export class PhysicsWorld implements IslandSolver {
  readonly bodies = new BodySet();
  readonly joints = new JointSet();
  /** What touched what during the last tick, ordered by pair key. Drain it after `step`. */
  readonly events = new ContactEvents();

  /**
   * Pairs that never collide, whatever their layers say.
   *
   * **The mask says what a body is; this says who two bodies are to each other.** See `pairKey`
   * for why the two are not the same question and why a ragdoll can only be expressed by the
   * second one.
   *
   * Kept as a set of packed keys and consulted only when it holds something, so a world that
   * never calls `ignorePair` pays one integer compare per candidate pair.
   */
  private readonly ignoredPairs = new Set<number>();
  readonly substeps: number;
  readonly iterations: number;
  gravityX: number;
  gravityY: number;
  gravityZ: number;
  contactHertz: number;
  contactDamping: number;
  jointHertz: number;
  jointDamping: number;
  linearDamping: number;
  angularDamping: number;
  speculativeMargin: number;
  allowSleep: boolean;
  /** Read at every substep, so a consumer may switch it between ticks. See `WorldOptions`. */
  frictionModel: FrictionModel;

  /** Who runs the islands. Swappable, and a gate asserts two characters agree. */
  executor: Executor = new SerialExecutor();

  /**
   * What the island solving is actually doing.
   *
   * **Read it rather than assuming the `workers` option took.** A pool needs a cross-origin isolated
   * page and a bundler that understands a worker entry, and when either is missing this says which
   * in a sentence fit to put on a debug overlay. `createSplatSortWorker` warns once on the console
   * for the same reason; this is the same fact as data, because a console warning is not something a
   * consumer can show a player or assert in a test.
   */
  readonly parallelism: Parallelism;

  /**
   * The scalars an island's solve reads, in the layout `islandSolve.ts` names.
   *
   * Written once a tick by `step` so a consumer may change gravity or the friction model between
   * ticks and have every character see it, including one reading them out of shared memory.
   */
  private dials = new Float64Array(DIAL_COUNT);

  private tree = new DynamicTree();
  private islands = new IslandSet();
  private stepDt = 1 / 60;
  private leafOf = new Int32Array(64);
  private pairs = new PairSet();
  private constraints = new ContactConstraints();
  private manifold: Manifold = createManifold();
  private box: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  private poseA: ShapePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private poseB: ShapePose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  /** Previous tick's impulses, by pair key then feature id. */
  /**
   * One manifold per contact plane a mesh pair produced. Allocated once; the tick may not.
   *
   * `MAX_MESH_MANIFOLDS` planes is a body wedged in a corner with room to spare. A pair that fills
   * it drops the rest, which for a convex body against a mesh means dropping the shallowest planes
   * — the tree returns candidates in its own order, so what is kept is the first eight it met.
   */
  /**
   * The manifold set a compound pair fills, sized so a compound against one convex shape cannot
   * overflow: one plane per part, and `MAX_PAIR_MANIFOLDS` is `MAX_BODY_PARTS`.
   *
   * Separate from `meshManifolds` rather than one larger set shared by both, because `collideMesh`
   * fills up to the length it is given — handing it thirty-two would change how many contact planes
   * a shipped mesh pair produces, which is a behaviour change nobody asked for.
   */
  private readonly pairManifolds: readonly Manifold[] = Array.from(
    { length: MAX_PAIR_MANIFOLDS },
    createManifold,
  );

  private readonly meshManifolds: readonly Manifold[] = Array.from(
    { length: MAX_MESH_MANIFOLDS },
    () => createManifold(),
  );
  private warm = new Map<number, Float32Array>();
  private nextWarm = new Map<number, Float32Array>();
  private warmN = new Float32Array(4);
  private warmT1 = new Float32Array(4);
  private warmT2 = new Float32Array(4);

  constructor(options: WorldOptions = {}) {
    this.substeps = Math.max(1, options.substeps ?? 4);
    this.iterations = Math.max(1, options.iterations ?? 1);
    this.gravityX = options.gravityX ?? 0;
    this.gravityY = options.gravityY ?? -9.81;
    this.gravityZ = options.gravityZ ?? 0;
    this.contactHertz = options.contactHertz ?? 30;
    this.contactDamping = options.contactDamping ?? 10;
    this.jointHertz = options.jointHertz ?? 60;
    this.jointDamping = options.jointDamping ?? 2;
    this.linearDamping = options.linearDamping ?? 0;
    this.angularDamping = options.angularDamping ?? 0.05;
    this.speculativeMargin = options.speculativeMargin ?? 0.04;
    this.allowSleep = options.allowSleep ?? true;
    this.frictionModel = options.frictionModel ?? 'box';

    /*
     * **What was asked for and what this machine will give are two numbers, and this used to
     * report the second under the first's name.**
     *
     * `Parallelism.requested` is documented as "workers the consumer asked for" and `reason` as
     * "empty when `running` matches `requested`" — and a world asked for four on a two-core machine
     * reported `requested: 1, running: 1, reason: ''`. Every field agreed with every other and none
     * of them said that three quarters of the request had been dropped. That is the silent clamp
     * this whole surface exists to avoid: `parallelism`'s own note says to read it *rather than
     * assuming the `workers` option took*, and on the most common shortfall there is it had nothing
     * to say.
     *
     * Found by CI rather than here, which is the other half of it: a character has two cores and this
     * machine has twenty-four, so the clamp never bit locally and the tests that assert the
     * documented meaning were red on every push.
     */
    const asked = Math.max(0, Math.floor(options.workers ?? 0));
    const granted = clampWorkers(asked);
    this.parallelism = { requested: asked, running: 0, reason: '' };
    if (granted > 0) {
      if (options.pool === undefined) {
        this.parallelism.reason =
          'workers were asked for but no pool was given. Import createIslandPool from ' +
          '@driftengine/physics/src/workers.ts and pass it as the pool option; it is behind its ' +
          'own specifier so that importing PhysicsWorld does not put a worker in your bundle.';
      } else {
        const pool = options.pool({ workers: granted, spawn: options.spawn });
        if (pool.executor !== null) this.executor = pool.executor;
        this.parallelism.running = pool.running;
        this.parallelism.reason = pool.reason;
      }
    }
    /*
     * The clamp, said out loud — but only where nothing else already explained the shortfall. A
     * pool that could not start has a better sentence than this one and keeps it.
     */
    if (this.parallelism.reason === '' && this.parallelism.running < asked) {
      const cores = coreCount();
      this.parallelism.reason =
        `${asked} workers were asked for and ${this.parallelism.running} run: this machine ` +
        `reports ${cores === undefined ? 'an unknown number of' : String(cores)} cores, and one ` +
        'is kept for the thread that steps the world.';
    }
  }

  /**
   * Stop the worker pool, if there is one. Safe to call twice, and safe on a world without one.
   *
   * **A world with a pool must be disposed.** Its workers hold the staging `SharedArrayBuffer`, so
   * a consumer replacing a world between levels leaks both the threads and every body's state with
   * them.
   */
  dispose(): void {
    this.executor.dispose?.();
    this.parallelism.running = 0;
  }

  /** Join two bodies. The relative pose they are in now becomes the one the joint holds. */
  addJoint(desc: JointDesc): number {
    return this.joints.add(this.bodies, desc);
  }

  addBody(desc: BodyDesc): number {
    /*
     * **A triangle mesh may only be static, and this is where that is enforced.** A moving one
     * needs its tree refitted every tick and needs a mass tensor a triangle soup does not have;
     * the usual answer to a moving concave thing is convex decomposition, which is a row of its
     * own. Refused at `add` rather than left to produce a body that falls through the world, which
     * is what a mesh with no volume and no inertia would do.
     */
    if (desc.shape?.triangles !== undefined && desc.type !== BODY_STATIC) {
      throw new Error(
        'addBody: a triangle mesh shape may only be static. A moving concave body wants convex ' +
          'decomposition into hulls, which `decomposeConvex` produces and `shapes` accepts.',
      );
    }
    /*
     * **Both, or neither, is refused at the call rather than resolved in the tick.** There is no
     * sensible reading of a body carrying a single shape and a list of them: the narrow phase would
     * have to pick one, and either pick is a body that collides as something nobody described.
     */
    if ((desc.shape === undefined) === (desc.shapes === undefined)) {
      throw new Error(
        'addBody: a body is built from exactly one of `shape` or `shapes`, and this one has ' +
          (desc.shape === undefined ? 'neither' : 'both'),
      );
    }
    if (desc.shapes !== undefined) {
      if (desc.shapes.length === 0) throw new Error('addBody: `shapes` is empty');
      /*
       * **A cap is a refusal here and not a truncation in the tick.** The manifold set is sized to
       * `MAX_PAIR_MANIFOLDS`, and a dropped part is a limb of the body that stops colliding — one
       * leg of a chair sinking through a floor while the other three hold. Failing at construction
       * is this engine's "fail fast at init, never throw in the frame loop" applied where it can be.
       */
      if (desc.shapes.length > MAX_BODY_PARTS) {
        throw new Error(
          `addBody: ${desc.shapes.length} parts exceeds MAX_BODY_PARTS of ${MAX_BODY_PARTS} — ` +
            'ask decomposeConvex for fewer hulls',
        );
      }
      for (const part of desc.shapes) {
        if (part.triangles !== undefined) {
          throw new Error('addBody: a triangle mesh cannot be a part of a compound body');
        }
      }
    }
    const i = this.bodies.add(desc);
    if (i >= this.leafOf.length) {
      const wider = new Int32Array(this.leafOf.length * 2);
      wider.set(this.leafOf);
      this.leafOf = wider;
    }
    this.leafOf[i] = this.tree.insert(i, this.boundsOf(i));
    return i;
  }

  /**
   * Never collide these two, whichever order they are given in and whatever their layers say.
   *
   * Both indices are followed through `removeBody`, so an exclusion cannot outlive the body it
   * was made about and cannot be inherited by whatever takes its slot.
   */
  ignorePair(a: number, b: number): void {
    if (a === b) return;
    this.ignoredPairs.add(pairKey(a, b));
  }

  /** Undo one `ignorePair`. Doing it to a pair that was never excluded is not an error. */
  allowPair(a: number, b: number): void {
    this.ignoredPairs.delete(pairKey(a, b));
  }

  /** Whether these two are excluded. */
  pairIgnored(a: number, b: number): boolean {
    return this.ignoredPairs.has(pairKey(a, b));
  }

  /**
   * Follow the exclusions through a swap-remove.
   *
   * **A body index is a slot and not an identity**, which is the same fact `removeBody` clears the
   * warm cache and the contact events for: removing one moves the last body into the hole, so a
   * remembered index is either gone or now names somebody else. An exclusion left alone would
   * quietly stop the newcomer colliding with whatever the departed was jointed to.
   */
  private followRemoval(index: number, moved: number): void {
    if (this.ignoredPairs.size === 0) return;
    const kept: number[] = [];
    for (const key of this.ignoredPairs) {
      const a = Math.floor(key / MAX_BODIES);
      const b = key % MAX_BODIES;
      /* The body that left takes its exclusions with it. */
      if (a === index || b === index) continue;
      if (moved >= 0 && (a === moved || b === moved)) {
        kept.push(pairKey(a === moved ? index : a, b === moved ? index : b));
        continue;
      }
      kept.push(key);
    }
    this.ignoredPairs.clear();
    for (const key of kept) this.ignoredPairs.add(key);
  }

  removeBody(index: number): void {
    this.tree.remove(this.leafOf[index] ?? 0);
    const moved = this.bodies.remove(index);
    this.followRemoval(index, moved);
    if (moved >= 0) {
      this.leafOf[index] = this.leafOf[moved] ?? 0;
      // The tree stores the body index it was inserted with, so it has to learn the new one.
      this.tree.proxy[this.leafOf[index] ?? 0] = index;
    }
    this.warm.clear();
    // Every index past the removed one may have moved, so a remembered pair is a lie.
    this.events.clear();
  }

  /** Advance one fixed tick. */
  step(dt: number): void {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.count; i++) {
      if (bodies.type[i] === BODY_STATIC) continue;
      this.tree.move(this.leafOf[i] ?? 0, this.boundsOf(i));
    }

    const pairCount = this.pairs.build(bodies, this.tree, this.leafOf, this.ignoredPairs);
    this.constraints.clear();
    this.nextWarm.clear();
    this.events.begin();
    let awake = 0;
    for (let i = 0; i < pairCount; i++) {
      const key = this.pairs.keys[i] ?? 0;
      const a = pairA(key);
      const b = pairB(key);
      const shapeA = bodies.shape[a];
      const shapeB = bodies.shape[b];
      const partsA = bodies.shapes[a];
      const partsB = bodies.shapes[b];
      if ((!shapeA && !partsA) || (!shapeB && !partsB)) continue;
      /*
       * A sleeping pair still builds its constraint, and that is deliberate. Skipping it drops the
       * contact, which drops the edge, which dissolves the island into singletons — so waking one
       * box of a sleeping stack could no longer reach the boxes above it. The *solve* is what gets
       * skipped, in `solveIsland`, which is the expensive half.
       *
       * **What this costs** is narrowphase for a sleeping stack, which sleeping was partly meant to
       * save. **What would make it wrong** is a world of tens of thousands of sleeping bodies where
       * that cost shows; the answer then is to persist island membership across sleep rather than
       * to re-derive it from contacts, which is a larger change than this one.
       */
      this.readPose(a, this.poseA);
      this.readPose(b, this.poseB);
      /*
       * **A mesh pair fills a set of manifolds where every other pair fills one.** A body in the
       * corner of a mesh room has two or three contact planes, and reducing them to one picks a
       * wall and lets the body through the others. The solver already supports it: `prepareContact`
       * appends a constraint rather than replacing one, and `storeWarm` accumulates by pair.
       */
      /*
       * **A compound pair fills a set too, for the same reason and by the same machinery.** One
       * manifold per touching part, with the part pair folded into every feature id — the fold
       * `collideMesh` already does with a triangle index, and for the identical reason: a body
       * resting across two parts must not hand one part's accumulated impulse to the other on the
       * tick a contact moves between them.
       */
      const compoundPair = partsA !== undefined || partsB !== undefined;
      const meshPair = !compoundPair && (isMesh(shapeA) || isMesh(shapeB));
      const set = compoundPair ? this.pairManifolds : this.meshManifolds;
      const manifolds = compoundPair
        ? collideCompound(
            shapeA,
            partsA,
            this.poseA,
            shapeB,
            partsB,
            this.poseB,
            this.speculativeMargin,
            this.pairManifolds,
          )
        : meshPair
          ? collideMesh(
              shapeA as ConvexShape,
              this.poseA,
              shapeB as ConvexShape,
              this.poseB,
              this.speculativeMargin,
              this.meshManifolds,
            )
          : collideShapes(
                shapeA as ConvexShape,
                this.poseA,
                shapeB as ConvexShape,
                this.poseB,
                this.speculativeMargin,
                this.manifold,
              )
            ? 1
            : 0;
      if (manifolds === 0) continue;
      /*
       * Deliberately no wake here. Waking every body that has a contact resets the counter on every
       * tick, so a resting stack can never accumulate one and nothing in the world ever sleeps —
       * which is what this did. A sleeping body touched by a moving one is woken by its *island*
       * instead: they share one, the island is not all still, and every counter in it resets.
       */
      awake++;
      this.events.touching(key);
      /*
       * A sensor is reported and never resolved. Building its constraint would push it out of the
       * thing it is meant to notice, which is the whole of what a sensor is not.
       */
      if ((bodies.flags[a] ?? 0) & BODY_SENSOR || (bodies.flags[b] ?? 0) & BODY_SENSOR) continue;
      const stored = this.warm.get(key);
      for (let m = 0; m < manifolds; m++) {
        const manifold = compoundPair || meshPair ? (set[m] as Manifold) : this.manifold;
        this.loadWarm(stored, manifold);
        prepareContact(
          bodies,
          a,
          b,
          manifold,
          this.constraints,
          this.warmN,
          this.warmT1,
          this.warmT2,
        );
      }
    }

    /*
     * Integrate velocities, warm start, solve, integrate positions, relax — in that order, every
     * substep.
     *
     * **The accumulated impulse is a per-substep quantity**, so warm starting only on the first
     * substep hands a resting contact a quarter of the impulse it needs to hold anything up. A
     * single box on static ground survived that, because the bias alone could carry it; a stack of
     * ten collapsed completely.
     *
     * **And positions are integrated after the biased solve, not before it**, so the solve corrects
     * the positions it is about to produce rather than ones already advanced past it. The relax
     * pass then runs against the new positions with the bias off, which is what takes back the
     * energy the bias added.
     */
    /*
     * Islands are built here and each is advanced through the *whole* substep loop by the executor,
     * rather than integration being a global pass with only the solve split. That is the shape a
     * worker pool needs: one island, one character, no shared state — and a body with no contacts is a
     * singleton island so nothing falls outside it.
     */
    this.stepDt = dt;
    this.writeDials();
    resetJointImpulses(this.joints);
    const islandCount = this.islands.build(bodies, this.constraints, this.joints);
    this.executor.run(islandCount, this);

    const failure = this.executor.failure;
    if (failure !== undefined && failure !== null && this.parallelism.running > 0) {
      this.parallelism.running = 0;
      this.parallelism.reason = failure;
    }
    this.events.end(pairA, pairB);
    this.storeWarm();
    this.updateSleep();
    void awake;
  }

  /**
   * Advance one island through every substep. The executor calls this; nothing else should.
   *
   * Integration is over this island's bodies only, which is what makes the call independent of
   * every other island rather than merely ordered against them.
   */
  solveIsland(island: number): void {
    solveIslandInto(this.solveState, island);
  }

  /**
   * The flat view of this world an island's solve needs, and the only view a worker could hold.
   *
   * Built fresh because `grow` replaces the arrays underneath it; the object is five references and
   * one allocation, which the solve that follows dwarfs.
   *
   * **Public because a character off this thread needs it.** `SerialExecutor` calls `solveIsland`;
   * a staged or pooled character mirrors this state into shared memory and solves that instead, which
   * it cannot do through a method closed over the live arrays.
   */
  get solveState(): IslandSolveState {
    return {
      bodies: this.bodies,
      constraints: this.constraints,
      joints: this.joints,
      islands: this.islands,
      dials: this.dials,
    };
  }

  /** Copy the dials into the block every character reads. Called once a tick, before the islands run. */
  private writeDials(): void {
    const d = this.dials;
    d[DIAL_SUBSTEPS] = this.substeps;
    d[DIAL_ITERATIONS] = this.iterations;
    d[DIAL_DT] = this.stepDt;
    d[DIAL_GRAVITY_X] = this.gravityX;
    d[DIAL_GRAVITY_Y] = this.gravityY;
    d[DIAL_GRAVITY_Z] = this.gravityZ;
    d[DIAL_LINEAR_DAMPING] = this.linearDamping;
    d[DIAL_ANGULAR_DAMPING] = this.angularDamping;
    d[DIAL_CONTACT_HERTZ] = this.contactHertz;
    d[DIAL_CONTACT_DAMPING] = this.contactDamping;
    d[DIAL_JOINT_HERTZ] = this.jointHertz;
    d[DIAL_JOINT_DAMPING] = this.jointDamping;
    d[DIAL_ALLOW_SLEEP] = this.allowSleep ? 1 : 0;
    d[DIAL_FRICTION_MODEL] = frictionDial(this.frictionModel);
  }

  /** A body's world bounds, grown by the speculative margin so a contact is seen before it is made. */
  private boundsOf(i: number): Aabb {
    const shape = this.bodies.shape[i];
    const parts = this.bodies.shapes[i];
    if (!shape && !parts) {
      this.box.minX = this.bodies.posX[i] ?? 0;
      this.box.minY = this.bodies.posY[i] ?? 0;
      this.box.minZ = this.bodies.posZ[i] ?? 0;
      this.box.maxX = this.box.minX;
      this.box.maxY = this.box.minY;
      this.box.maxZ = this.box.minZ;
      return this.box;
    }
    /*
     * The bound radius rather than the rotated hull: a sphere about the centre encloses the shape
     * in every orientation, so a turning body never needs its bounds recomputed from its vertices.
     * What this gives up is tightness for a long thin body; what would make it wrong is a
     * measurement showing the broadphase reporting far more candidates than it should.
     */
    /*
     * A compound's radius is the largest of its parts' and not their sum, because every part is
     * already in the body's frame: one built off to a side carries that offset in its own radius.
     */
    const r =
      (parts ? partsBoundRadius(parts) : (shape as ConvexShape).boundRadius) +
      this.speculativeMargin;
    const x = this.bodies.posX[i] ?? 0;
    const y = this.bodies.posY[i] ?? 0;
    const z = this.bodies.posZ[i] ?? 0;
    this.box.minX = x - r;
    this.box.minY = y - r;
    this.box.minZ = z - r;
    this.box.maxX = x + r;
    this.box.maxY = y + r;
    this.box.maxZ = z + r;
    return this.box;
  }

  private readPose(i: number, out: ShapePose): void {
    out.x = this.bodies.posX[i] ?? 0;
    out.y = this.bodies.posY[i] ?? 0;
    out.z = this.bodies.posZ[i] ?? 0;
    out.qx = this.bodies.rotX[i] ?? 0;
    out.qy = this.bodies.rotY[i] ?? 0;
    out.qz = this.bodies.rotZ[i] ?? 0;
    out.qw = this.bodies.rotW[i] ?? 1;
  }

  private loadWarm(stored: Float32Array | undefined, m: Manifold): void {
    for (let i = 0; i < m.count; i++) {
      this.warmN[i] = 0;
      this.warmT1[i] = 0;
      this.warmT2[i] = 0;
      if (!stored) continue;
      // Matched by feature id, never by proximity: a tolerance would be order-dependent.
      for (let k = 0; k + 3 < stored.length; k += 4) {
        if (stored[k] === (m.featureIds[i] ?? 0)) {
          this.warmN[i] = stored[k + 1] ?? 0;
          this.warmT1[i] = stored[k + 2] ?? 0;
          this.warmT2[i] = stored[k + 3] ?? 0;
          break;
        }
      }
    }
  }

  private storeWarm(): void {
    const c = this.constraints;
    for (let k = 0; k < c.count; k++) {
      const key = (c.bodyA[k] ?? 0) * MAX_BODIES + (c.bodyB[k] ?? 0);
      const start = c.pointStart[k] ?? 0;
      const n = c.pointCount[k] ?? 0;
      /*
       * **Appended rather than replaced, because a mesh pair produces several constraints.** Every
       * other pair produces one and the two are the same code path; a `set` here would keep the
       * last of a mesh pair's planes and throw the rest away, which is a floor that warm-starts
       * and a wall that does not. `loadWarm` matches by feature id and `meshContact.ts` folds the
       * triangle into every id, so one array per pair stays unambiguous.
       */
      const before = this.nextWarm.get(key);
      const at = before?.length ?? 0;
      const store = new Float32Array(at + n * 4);
      if (before) store.set(before);
      for (let i = 0; i < n; i++) {
        store[at + i * 4] = c.featureId[start + i] ?? 0;
        store[at + i * 4 + 1] = c.normalImpulse[start + i] ?? 0;
        store[at + i * 4 + 2] = c.tangent1Impulse[start + i] ?? 0;
        store[at + i * 4 + 3] = c.tangent2Impulse[start + i] ?? 0;
      }
      this.nextWarm.set(key, store);
    }
    const swap = this.warm;
    this.warm = this.nextWarm;
    this.nextWarm = swap;
  }

  /**
   * Islands sleep, not bodies.
   *
   * A box that slept while its neighbour was still moving would be woken by that neighbour on the
   * very next tick and never rest — so a body accumulates its counter only when **every** body in
   * its island is below both thresholds, and the whole island resets together when one is not.
   *
   * Tick-counted and never time-based, because sleeping changes results and results have to replay.
   */
  private updateSleep(): void {
    const bodies = this.bodies;
    for (let island = 0; island < this.islands.count; island++) {
      const from = this.islands.bodyStart[island] ?? 0;
      const to = this.islands.bodyStart[island + 1] ?? from;
      let allStill = true;
      for (let at = from; at < to && allStill; at++) {
        const i = this.islands.bodyOrder[at] ?? 0;
        if (bodies.type[i] !== BODY_DYNAMIC) continue;
        const vx = bodies.velX[i] ?? 0;
        const vy = bodies.velY[i] ?? 0;
        const vz = bodies.velZ[i] ?? 0;
        const wx = bodies.angX[i] ?? 0;
        const wy = bodies.angY[i] ?? 0;
        const wz = bodies.angZ[i] ?? 0;
        if (
          vx * vx + vy * vy + vz * vz >= SLEEP_LINEAR * SLEEP_LINEAR ||
          wx * wx + wy * wy + wz * wz >= SLEEP_ANGULAR * SLEEP_ANGULAR
        ) {
          allStill = false;
        }
      }
      for (let at = from; at < to; at++) {
        const i = this.islands.bodyOrder[at] ?? 0;
        if (bodies.type[i] !== BODY_DYNAMIC) continue;
        bodies.sleepTicks[i] = allStill
          ? Math.min(SLEEP_TICKS, (bodies.sleepTicks[i] ?? 0) + 1)
          : 0;
      }
    }
  }

  /** Wake a body and everything sharing its island, which is what an external impulse must do. */
  wakeIsland(index: number): void {
    const island = this.islands.islandOf[index] ?? -1;
    if (island < 0) {
      this.bodies.sleepTicks[index] = 0;
      return;
    }
    const from = this.islands.bodyStart[island] ?? 0;
    const to = this.islands.bodyStart[island + 1] ?? from;
    for (let at = from; at < to; at++) {
      this.bodies.sleepTicks[this.islands.bodyOrder[at] ?? 0] = 0;
    }
  }

  /** Whether every body in an island has been still long enough to stop being solved. */
  /** The nearest body a ray meets. Fills `out` and allocates nothing. */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: RayHit,
    filter?: QueryFilter,
  ): boolean {
    return raycastWorld(this.bodies, this.tree, ox, oy, oz, dx, dy, dz, maxDistance, out, filter);
  }

  /** The first body a swept shape touches. */
  shapecast(
    shape: ConvexShape,
    pose: ShapePose,
    dx: number,
    dy: number,
    dz: number,
    out: RayHit,
    filter?: QueryFilter,
  ): boolean {
    return shapecastWorld(this.bodies, this.tree, shape, pose, dx, dy, dz, out, filter);
  }

  /** Every body overlapping a shape, filling `out` to its length. Returns how many were written. */
  overlap(shape: ConvexShape, pose: ShapePose, out: Int32Array, filter?: QueryFilter): number {
    return overlapWorld(this.bodies, this.tree, shape, pose, out, filter);
  }

  /**
   * Apply an impulse at a world-space point.
   *
   * **The point is not optional**, and `bindings/core.ts` makes it required at the language boundary
   * for the reason `AGENTS.md`'s step four gives: a caller who omits it gets an impulse through the
   * centre of mass, which produces no rotation at all. That is a wrong *result* rather than an
   * error, and it reads as a broken impulse rather than as a missing argument.
   */
  applyImpulse(
    body: number,
    px: number,
    py: number,
    pz: number,
    atX: number,
    atY: number,
    atZ: number,
  ): void {
    const im = this.bodies.invMass[body] ?? 0;
    if (im === 0) return;
    this.bodies.velX[body] = (this.bodies.velX[body] ?? 0) + px * im;
    this.bodies.velY[body] = (this.bodies.velY[body] ?? 0) + py * im;
    this.bodies.velZ[body] = (this.bodies.velZ[body] ?? 0) + pz * im;
    const rx = atX - (this.bodies.posX[body] ?? 0);
    const ry = atY - (this.bodies.posY[body] ?? 0);
    const rz = atZ - (this.bodies.posZ[body] ?? 0);
    this.bodies.worldInverseInertia(body, IMPULSE_I);
    const tx = ry * pz - rz * py;
    const ty = rz * px - rx * pz;
    const tz = rx * py - ry * px;
    this.bodies.angX[body] =
      (this.bodies.angX[body] ?? 0) +
      (IMPULSE_I[0] ?? 0) * tx +
      (IMPULSE_I[3] ?? 0) * ty +
      (IMPULSE_I[4] ?? 0) * tz;
    this.bodies.angY[body] =
      (this.bodies.angY[body] ?? 0) +
      (IMPULSE_I[3] ?? 0) * tx +
      (IMPULSE_I[1] ?? 0) * ty +
      (IMPULSE_I[5] ?? 0) * tz;
    this.bodies.angZ[body] =
      (this.bodies.angZ[body] ?? 0) +
      (IMPULSE_I[4] ?? 0) * tx +
      (IMPULSE_I[5] ?? 0) * ty +
      (IMPULSE_I[2] ?? 0) * tz;
    this.wakeIsland(body);
  }

  /** A force applied for one tick, which is an impulse of `force · dt`. */
  applyForce(
    body: number,
    fx: number,
    fy: number,
    fz: number,
    dt: number,
    atX: number,
    atY: number,
    atZ: number,
  ): void {
    this.applyImpulse(body, fx * dt, fy * dt, fz * dt, atX, atY, atZ);
  }

  /** Set a body's velocity outright, waking whatever it was resting against. */
  setVelocity(body: number, vx: number, vy: number, vz: number): void {
    this.bodies.velX[body] = vx;
    this.bodies.velY[body] = vy;
    this.bodies.velZ[body] = vz;
    this.wakeIsland(body);
  }

  /**
   * Move a body outright, which is a teleport rather than a push.
   *
   * The broadphase proxy moves with it, or the body would be found where it used to be until it
   * next drifted out of its own fat bounds.
   */
  setPosition(body: number, x: number, y: number, z: number): void {
    this.bodies.posX[body] = x;
    this.bodies.posY[body] = y;
    this.bodies.posZ[body] = z;
    this.tree.move(this.leafOf[body] ?? 0, this.boundsOf(body));
    this.wakeIsland(body);
  }

  /** A body's mass, or zero where it has none because it is static or kinematic. */
  bodyMass(body: number): number {
    const im = this.bodies.invMass[body] ?? 0;
    return im > 0 ? 1 / im : 0;
  }

  /** How many islands the last step found. */
  get islandCount(): number {
    return this.islands.count;
  }

  /** Whether a body is currently asleep, for a caller deciding whether to bother. */
  sleeping(index: number): boolean {
    return this.asleep(index);
  }

  /** Whether a body has been still long enough to stop being integrated. */
  private asleep(i: number): boolean {
    return bodyAsleep(this.bodies, this.allowSleep, i);
  }
}

/**
 * Never more workers than the machine has cores to spare.
 *
 * One is left for the thread that asked, which is solving its own share of the islands. A runtime
 * that does not report `hardwareConcurrency` gets what it asked for, because guessing low there
 * would silently halve a server's pool.
 */
/**
 * What the host says it has, or undefined where it says nothing.
 *
 * Its own function because two callers need it and one of them is a sentence a consumer reads:
 * a clamp that cannot name the number it clamped to is the silent kind again.
 */
function coreCount(): number | undefined {
  return (globalThis.navigator as { hardwareConcurrency?: number } | undefined)
    ?.hardwareConcurrency;
}

function clampWorkers(wanted: number): number {
  const asked = Math.max(0, Math.floor(wanted));
  const cores = coreCount();
  if (asked === 0 || cores === undefined) return asked;
  return Math.max(1, Math.min(asked, cores - 1));
}
