/**
 * A simulation that gives the same bits every time: a generator that can be rewound, functions
 * whose results ECMAScript does not leave to the engine, and a fingerprint that proves two runs
 * agreed.
 *
 * A snippet, typechecked with the examples and quoted by the manual's determinism chapter.
 */
import {
  BODY_DYNAMIC,
  BODY_STATIC,
  PhysicsWorld,
  TickTrace,
  boxShape,
  exactCos,
  exactSin,
  fingerprintBodies,
  savableMulberry32,
} from '@driftengine/core';

// #region seeded
/** A generator whose position is one integer, so a rollback can put it back exactly. */
const random = savableMulberry32(42);

const before = random.save();
const first = random.next();
random.restore(before);
const again = random.next(); // the same number as `first`, bit for bit
// #endregion

// #region exact
/** A platform that sways on a fixed step. `Math.sin` may differ in its last bit between browsers. */
export function swayAt(tick: number): { x: number; z: number } {
  const t = tick / 60;
  return { x: exactSin(t * 0.7) * 2, z: exactCos(t * 0.7) * 2 };
}
// #endregion

// #region check
/** Run the same simulation twice from the same start, and compare the bodies' bits. */
function run(ticks: number): string {
  const world = new PhysicsWorld({ substeps: 4 });
  world.addBody({ type: BODY_STATIC, shape: boxShape(10, 0.5, 10), y: -0.5 });
  for (let i = 0; i < 6; i += 1) {
    world.addBody({
      type: BODY_DYNAMIC,
      shape: boxShape(0.5, 0.5, 0.5),
      x: i * 0.3,
      y: 1 + i * 1.1,
    });
  }
  for (let tick = 0; tick < ticks; tick += 1) world.step(1 / 60);
  return fingerprintBodies(world.bodies);
}

export const agrees = run(600) === run(600);
// #endregion

// #region trace
/** Keep what each tick produced, so a replay can seek to any tick without simulating its way there. */
export function recordHeights(ticks: number): TickTrace {
  const trace = new TickTrace(1, ticks);
  const value = new Float32Array(1);
  for (let tick = 0; tick < ticks; tick += 1) {
    value[0] = swayAt(tick).x;
    trace.push(value);
  }
  return trace;
}
// #endregion

export { again, first };
