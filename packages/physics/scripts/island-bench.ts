/**
 * What the island solve costs, and what a worker pool behind the executor seam could take off it.
 *
 * **`executor.ts` says the pool's threshold is a measurement, and this is that measurement.** It is
 * a benchmark rather than a test: nothing here asserts, because a wall-clock number on one machine
 * is evidence rather than a contract. `npm run bench:islands`.
 *
 * It prints three things a decision needs:
 *
 * 1. **How much of a tick is the island solve.** That is the fraction a pool can touch at all, and
 *    Amdahl's law caps every speedup at it.
 * 2. **How many islands a world actually has.** The parallelism is `min(workers, islands)` — never
 *    the body count, which is what `executor.ts`'s own comment named and which is wrong: a
 *    thousand-box tower is one island and a pool can do nothing with it.
 * 3. **What one island costs**, against the handshake a fork-join pays.
 */
import { BODY_DYNAMIC, BODY_STATIC } from '../src/bodies';
import type { Executor, IslandSolver } from '../src/executor';
import { JOINT_DISTANCE } from '../src/joints';
import { boxShape } from '../src/shape';
import { PhysicsWorld } from '../src/world';
import { createIslandPool } from '../src/workers';
import { Worker } from 'node:worker_threads';

/** The real entry point, spawned the way Node spawns one. A browser uses the package default. */
const spawn = () =>
  new Worker(new URL('../src/islandWorker.ts', import.meta.url)) as unknown as {
    postMessage(value: unknown): void;
    terminate(): void | Promise<number>;
  };

const DT = 1 / 60;

/** A serial runner that also records how long the islands took and how many there were. */
class TimingExecutor implements Executor {
  readonly name = 'timing';
  totalUs = 0;
  ticks = 0;
  islands = 0;

  run(count: number, solver: IslandSolver): void {
    const started = performance.now();
    for (let i = 0; i < count; i++) solver.solveIsland(i);
    this.totalUs += (performance.now() - started) * 1000;
    this.ticks += 1;
    this.islands = count;
  }

  reset(): void {
    this.totalUs = 0;
    this.ticks = 0;
  }
}

/** `stacks` towers of `high` boxes, spaced far enough apart that each tower is its own island. */
function build(stacks: number, high: number): { world: PhysicsWorld; timer: TimingExecutor } {
  const world = new PhysicsWorld({ allowSleep: false });
  const timer = new TimingExecutor();
  world.executor = timer;
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
  return { world, timer };
}

/**
 * A hundred boxes strung together by joints, which is **one island** by definition.
 *
 * A tall tower would have been the obvious shape and is the wrong one: it topples inside a second
 * and becomes seventy islands, which measures the opposite of what it was built to show. Joints put
 * bodies in one island whatever they then do.
 */
function chain(links: number): { world: PhysicsWorld; timer: TimingExecutor } {
  const world = new PhysicsWorld({ allowSleep: false });
  const timer = new TimingExecutor();
  world.executor = timer;
  world.addBody({ type: BODY_STATIC, shape: boxShape(2000, 1, 2000), y: -1, friction: 0.8 });
  let previous = -1;
  for (let i = 0; i < links; i++) {
    const body = world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.3, 0.3, 0.3),
      x: i * 0.8,
      y: 4,
      density: 500,
      friction: 0.8,
    });
    if (previous >= 0) {
      world.addJoint({ type: JOINT_DISTANCE, bodyA: previous, bodyB: body, length: 0.8 });
    }
    previous = body;
  }
  return { world, timer };
}

function report(world: PhysicsWorld, timer: TimingExecutor, bodies: number): void {
  for (let i = 0; i < 60; i++) world.step(DT);
  timer.reset();
  const runs = 180;
  const started = performance.now();
  for (let i = 0; i < runs; i++) world.step(DT);
  const tick = ((performance.now() - started) / runs) * 1000;
  const solve = timer.totalUs / timer.ticks;
  const perIsland = solve / Math.max(timer.islands, 1);
  console.log(
    [
      String(bodies).padStart(7),
      String(timer.islands).padStart(8),
      tick.toFixed(0).padStart(8),
      solve.toFixed(0).padStart(9),
      `${((solve / tick) * 100).toFixed(0)}%`.padStart(8),
      perIsland.toFixed(1).padStart(11),
    ].join(' | '),
  );
}

function row(stacks: number, high: number): void {
  const { world, timer } = build(stacks, high);
  report(world, timer, stacks * high);
}

console.log(' bodies |  islands |  tick us | solve us |   solve% | us/island');
for (const [stacks, high] of [
  [1, 10],
  [4, 10],
  [16, 10],
  [64, 10],
  [256, 10],
] as const) {
  row(stacks, high);
}
const linked = chain(100);
report(linked.world, linked.timer, 100);
console.log(
  '\nThe last row is a hundred jointed boxes: one island, however many bodies, so a pool of any\n' +
    'size can do nothing with it. The parallelism is bounded by the island count and never by the\n' +
    'body count, which is what `executor.ts` said until this was measured.',
);

/**
 * And what the pool actually takes off a tick, against both bounds it is held between.
 *
 * **Two ceilings, and the scene picks which one binds.** Amdahl's is `1 / (1 - solve share)`, from
 * the column above. The other is `total island cost / largest island cost`, because the tick cannot
 * end before its slowest island does — which is why the jointed chain gains nothing at any worker
 * count and why a printed speedup means little without the bound beside it.
 *
 * Nothing here asserts. A wall-clock number on one machine is evidence, and the gate that has to
 * hold is `workerPool.test.mjs`, which compares bits.
 */
function pooled(stacks: number, high: number, workers: number): void {
  const world = new PhysicsWorld({ allowSleep: false, workers, spawn, pool: createIslandPool });
  if (world.parallelism.running !== workers) {
    console.log(`  ${workers} workers: not running — ${world.parallelism.reason}`);
    world.dispose();
    return;
  }
  const serial = new PhysicsWorld({ allowSleep: false });
  for (const target of [world, serial]) {
    target.addBody({ type: BODY_STATIC, shape: boxShape(2000, 1, 2000), y: -1, friction: 0.8 });
    for (let s = 0; s < stacks; s++) {
      for (let i = 0; i < high; i++) {
        target.addBody({
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
  const time = (target: PhysicsWorld): number => {
    for (let i = 0; i < 30; i++) target.step(DT);
    const started = performance.now();
    for (let i = 0; i < 120; i++) target.step(DT);
    return ((performance.now() - started) / 120) * 1000;
  };
  const one = time(serial);
  const many = time(world);
  const solved = (world.executor as { solvedPerWorker: number[] }).solvedPerWorker;
  console.log(
    `  ${String(workers).padStart(2)} workers: ${one.toFixed(0).padStart(6)} us serial | ` +
      `${many.toFixed(0).padStart(6)} us pooled | ${(one / many).toFixed(2)}x | ` +
      `islands taken off this thread: ${solved.reduce((a, b) => a + b, 0)}`,
  );
  world.dispose();
}

console.log('\n256 stacks of 10, so there are 256 islands to hand out:');
for (const workers of [1, 2, 4, 8]) pooled(256, 10, workers);
console.log('\nAnd the jointed chain, which is one island and therefore has nothing to split:');
const oneIsland = new PhysicsWorld({
  allowSleep: false,
  workers: 4,
  spawn,
  pool: createIslandPool,
});
if (oneIsland.parallelism.running === 4) {
  oneIsland.addBody({ type: BODY_STATIC, shape: boxShape(2000, 1, 2000), y: -1, friction: 0.8 });
  let last = -1;
  for (let i = 0; i < 100; i++) {
    const body = oneIsland.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.3, 0.3, 0.3),
      x: i * 0.8,
      y: 4,
      density: 500,
      friction: 0.8,
    });
    if (last >= 0)
      oneIsland.addJoint({ type: JOINT_DISTANCE, bodyA: last, bodyB: body, length: 0.8 });
    last = body;
  }
  for (let i = 0; i < 30; i++) oneIsland.step(DT);
  const started = performance.now();
  for (let i = 0; i < 120; i++) oneIsland.step(DT);
  console.log(
    `  4 workers on one island: ${(((performance.now() - started) / 120) * 1000).toFixed(0)} us a tick`,
  );
} else {
  console.log(`  not running — ${oneIsland.parallelism.reason}`);
}
oneIsland.dispose();
