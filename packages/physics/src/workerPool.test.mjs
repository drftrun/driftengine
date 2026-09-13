/**
 * The pool, against the serial runner, on real threads.
 *
 * `node:test` rather than vitest, for the reason `packages/ai/src/adapters/proxy.test.mjs` gives:
 * the workspace tsconfig gives package tests no node types, deliberately, so that nothing under
 * `src/` can compile against `Buffer` and reach a consumer's browser bundle. A test that needs
 * `node:worker_threads` therefore cannot be a `.ts` file, and should not want to be.
 *
 * **The entry point spawned here is the one a browser gets.** Node strips types outside
 * `node_modules`, so `islandWorker.ts` loads as itself and the only difference between this and a
 * page is which object delivers the message. A stand-in worker would have tested the test.
 *
 * **Agreement is asserted second.** A pool that failed to start falls back to serial and agrees with
 * serial on every bit of every tick, so a fingerprint comparison alone is a claim that passes when
 * nothing happened — the shape the 2026-09-04 audit removed 57 of from `scripts/*-check.mjs`. Every
 * case below establishes that the pool ran, and how much of the work it took, before comparing
 * anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { fingerprintBodies } from './fingerprint.ts';
import { JOINT_DISTANCE } from './joints.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';
import { createIslandPool } from './workerPool.ts';

const DT = 1 / 60;
const WORKERS = 4;

/**
 * How many cores the world is told this machine has.
 *
 * **Two mistakes were made here in one afternoon and both are worth keeping written down.** The
 * first: every case below asserted four running workers, and `PhysicsWorld` keeps a core back for
 * the thread that steps the world — so a two-core build character grants one whatever is asked for.
 * Those cases were green on a twenty-four-core machine and red on every push for four releases,
 * because the number under test was the character's rather than the engine's.
 *
 * The second was the fix for the first: pinning the core count *high* so the pool would run four
 * threads anywhere. It does, and four threads on two cores miss the 250 ms join deadline — so the
 * pool honestly reports that its workers never took the shared buffer, and two cases went red for a
 * new reason. Forcing a machine to run more workers than it has is not measuring the pool either.
 *
 * So nothing is pinned for the working cases: they ask for `WORKERS`, take whatever the machine
 * grants, and assert against *that*. Only the two clamp cases pin, because the clamp is the thing
 * they are about, and neither of them steps a world with more workers than the machine has.
 */
function pinCores(count) {
  const navigator = globalThis.navigator;
  if (navigator === undefined) return () => {};
  const original = Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency');
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: count, configurable: true });
  return () => {
    if (original === undefined) delete navigator.hardwareConcurrency;
    else Object.defineProperty(navigator, 'hardwareConcurrency', original);
  };
}

/**
 * What this machine actually grants for a request of `WORKERS`, which is what the cases below
 * assert against. At least one, and never more than asked for.
 */
function granted(world) {
  assert.ok(world.parallelism.running >= 1, `no workers ran: ${world.parallelism.reason}`);
  assert.ok(world.parallelism.running <= WORKERS, 'more workers ran than were asked for');
  assert.equal(world.parallelism.requested, WORKERS);
  return world.parallelism.running;
}

const spawn = () => new Worker(new URL('./islandWorker.ts', import.meta.url));

/** Many islands, so there is something to hand out, plus a joint and a shared static floor. */
function scene(world, stacks, high) {
  world.addBody({ type: BODY_STATIC, shape: boxShape(2000, 1, 2000), y: -1, friction: 0.8 });
  let previous = -1;
  for (let s = 0; s < stacks; s++) {
    for (let i = 0; i < high; i++) {
      const body = world.addBody({
        type: BODY_DYNAMIC,
        shape: boxShape(0.5, 0.5, 0.5),
        x: s * 6,
        y: 0.5 + i * 1.02,
        density: 500,
        friction: 0.8,
        restitution: i === 0 ? 0.2 : 0,
      });
      if (s === 1 && i === high - 1 && previous >= 0) {
        world.addJoint({ type: JOINT_DISTANCE, bodyA: previous, bodyB: body, length: 1.02 });
      }
      previous = body;
    }
  }
}

test("a pool starts, takes real work, and lands on the serial runner's bits", () => {
  const serial = new PhysicsWorld({ allowSleep: false });
  const pooled = new PhysicsWorld({
    allowSleep: false,
    workers: WORKERS,
    spawn,
    pool: createIslandPool,
  });
  try {
    /* First: it started at all. Everything below is vacuous without this. */
    const running = granted(pooled);

    scene(serial, 12, 5);
    scene(pooled, 12, 5);

    for (let tick = 0; tick < 300; tick++) {
      serial.step(DT);
      pooled.step(DT);
      assert.equal(
        fingerprintBodies(pooled.bodies),
        fingerprintBodies(serial.bodies),
        `tick ${tick}`,
      );
    }

    /* Second: the workers did the work, and not one of them idled through the whole run. */
    const solved = pooled.executor.solvedPerWorker;
    assert.equal(solved.length, running);
    assert.ok(solved.reduce((a, b) => a + b, 0) > 300, `islands solved on workers: ${solved}`);
    for (const count of solved) assert.ok(count > 0, `an idle worker: ${solved}`);
    assert.equal(pooled.executor.failure, null);
  } finally {
    pooled.dispose();
  }
});

/**
 * **A grow re-plans the staging buffer, and a parked worker cannot receive a message.** So the pool
 * lets its workers out of `Atomics.wait` first, hands them the new buffer, and waits for every one
 * to say it took it. This is the case that deadlocks if that handshake is wrong.
 */
test('a pool follows a grow that moves every lane, without losing a worker', () => {
  const serial = new PhysicsWorld({ allowSleep: false });
  const pooled = new PhysicsWorld({
    allowSleep: false,
    workers: WORKERS,
    spawn,
    pool: createIslandPool,
  });
  try {
    granted(pooled);
    scene(serial, 6, 3);
    scene(pooled, 6, 3);
    for (let tick = 0; tick < 30; tick++) {
      serial.step(DT);
      pooled.step(DT);
    }
    /* Past the 64-body starting capacity, so `grow` runs and every offset moves. */
    for (const world of [serial, pooled]) {
      for (let i = 0; i < 80; i++) {
        world.addBody({
          type: BODY_DYNAMIC,
          shape: boxShape(0.4, 0.4, 0.4),
          x: 60 + i * 3,
          y: 0.4,
          density: 400,
          friction: 0.8,
        });
      }
    }
    assert.ok(serial.bodies.count > 64);
    for (let tick = 0; tick < 120; tick++) {
      serial.step(DT);
      pooled.step(DT);
      assert.equal(
        fingerprintBodies(pooled.bodies),
        fingerprintBodies(serial.bodies),
        `tick ${tick}`,
      );
    }
    assert.equal(pooled.executor.failure, null);
    for (const count of pooled.executor.solvedPerWorker) assert.ok(count > 0);
  } finally {
    pooled.dispose();
  }
});

/**
 * One worker is a pool too, and its result must be the same bits as many, or as none.
 *
 * **How many "many" is belongs to the machine.** On a build character that grants one, this compares a
 * pool of one against a pool of one — which still holds the agreement it is named for, and stops
 * being a claim about *width*. It says so rather than skipping, because a case that quietly tests
 * nothing is worse than one that reports what it could reach.
 */
test('a pool of one and a pool of as many as this machine grants agree', (t) => {
  const one = new PhysicsWorld({ allowSleep: false, workers: 1, spawn, pool: createIslandPool });
  const many = new PhysicsWorld({
    allowSleep: false,
    workers: WORKERS,
    spawn,
    pool: createIslandPool,
  });
  try {
    assert.equal(one.parallelism.running, 1);
    const width = granted(many);
    if (width < 2) {
      t.diagnostic(
        `this machine grants ${width} worker for a request of ${WORKERS}, so the two pools are the ` +
          'same width and the agreement below is not a claim about parallelism',
      );
    }
    /* Big enough that the caller cannot drain the cursor before a worker wakes. A cheap scene is
       legitimately solved entirely on the calling thread, which is the pool costing nothing when
       there is nothing to gain — correct, and not what this case is about. */
    scene(one, 40, 5);
    scene(many, 40, 5);
    for (let tick = 0; tick < 60; tick++) {
      one.step(DT);
      many.step(DT);
    }
    assert.equal(fingerprintBodies(many.bodies), fingerprintBodies(one.bodies));
    assert.ok(one.executor.solvedPerWorker[0] > 0);
    assert.ok(many.executor.solvedPerWorker.reduce((a, b) => a + b, 0) > 0);
  } finally {
    one.dispose();
    many.dispose();
  }
});

/** Dials changed between ticks reach the workers through shared memory, with no message sent. */
test('a dial changed mid-run reaches the workers', () => {
  const serial = new PhysicsWorld({ allowSleep: false });
  const pooled = new PhysicsWorld({
    allowSleep: false,
    workers: WORKERS,
    spawn,
    pool: createIslandPool,
  });
  try {
    granted(pooled);
    scene(serial, 6, 4);
    scene(pooled, 6, 4);
    for (let tick = 0; tick < 120; tick++) {
      if (tick === 40) {
        for (const world of [serial, pooled]) {
          world.gravityX = 3;
          world.frictionModel = 'elliptical';
        }
      }
      serial.step(DT);
      pooled.step(DT);
      assert.equal(
        fingerprintBodies(pooled.bodies),
        fingerprintBodies(serial.bodies),
        `tick ${tick}`,
      );
    }
  } finally {
    pooled.dispose();
  }
});

/** A bundler that cannot build the worker is the commonest failure, and it must not be fatal. */
test('a pool that cannot start says why, and the world still steps correctly', () => {
  const serial = new PhysicsWorld({ allowSleep: false });
  const asked = new PhysicsWorld({
    allowSleep: false,
    workers: 4,
    pool: createIslandPool,
    spawn: () => {
      throw new Error('Cannot find module ./islandWorker.ts');
    },
  });
  assert.equal(asked.parallelism.requested, 4);
  assert.equal(asked.parallelism.running, 0);
  assert.match(asked.parallelism.reason, /the worker entry failed to load/);
  assert.match(asked.parallelism.reason, /spawn/);

  scene(serial, 4, 4);
  scene(asked, 4, 4);
  for (let tick = 0; tick < 60; tick++) {
    serial.step(DT);
    asked.step(DT);
  }
  assert.equal(fingerprintBodies(asked.bodies), fingerprintBodies(serial.bodies));
  asked.dispose();
});

/** Asking for none is not a failure and must not read like one. */
test('a world with no workers reports nothing at all', () => {
  const world = new PhysicsWorld();
  assert.deepEqual(world.parallelism, { requested: 0, running: 0, reason: '' });
  world.dispose();
});

/**
 * The clamp, said out loud.
 *
 * **This is the case four releases of green local runs could not see.** A world keeps a core back
 * for the thread that steps it, so a small machine grants fewer workers than asked — and it used to
 * report the granted number under `requested`, with an empty `reason`. Every field agreed with
 * every other and none of them said three quarters of the request had been dropped, which is the
 * silent clamp `parallelism` exists to prevent.
 *
 * Pinned to two cores rather than left to the machine, so the assertion is about the engine.
 */
test('the clamp says so when it bites, and reports what was actually asked for', () => {
  const restore = pinCores(2);
  try {
    const world = new PhysicsWorld({
      allowSleep: false,
      workers: WORKERS,
      spawn,
      pool: createIslandPool,
    });
    try {
      /* What the consumer asked for, not what the machine allowed. */
      assert.equal(world.parallelism.requested, WORKERS);
      assert.equal(world.parallelism.running, 1);
      assert.match(world.parallelism.reason, /4 workers were asked for and 1 run/);
      assert.match(world.parallelism.reason, /2 cores/);
      /* And it still steps: a clamp is a smaller pool, never a broken one. */
      scene(world, 4, 4);
      for (let tick = 0; tick < 30; tick++) world.step(DT);
      assert.equal(world.executor.failure, null);
    } finally {
      world.dispose();
    }
  } finally {
    restore();
  }
});

/**
 * A machine with room to spare says nothing, because there is nothing to say.
 *
 * **Pinned high, and this is the one case where that is safe.** Forcing more workers than a machine
 * has is what broke the working cases above: four threads on two cores miss the join deadline. This
 * one never steps a world, so the four threads are spawned, counted and disposed without ever being
 * asked to wake — which is exactly the claim, that a request inside the budget is granted whole and
 * silently.
 */
test('the clamp is silent when it does not bite', () => {
  const restore = pinCores(32);
  try {
    const world = new PhysicsWorld({
      allowSleep: false,
      workers: WORKERS,
      spawn,
      pool: createIslandPool,
    });
    try {
      assert.equal(world.parallelism.requested, WORKERS);
      assert.equal(world.parallelism.running, WORKERS);
      assert.equal(world.parallelism.reason, '');
    } finally {
      world.dispose();
    }
  } finally {
    restore();
  }
});
