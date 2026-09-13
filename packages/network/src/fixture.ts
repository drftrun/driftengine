/**
 * One simulation, written twice: once in doubles behind the exactness gate, once in fixed point.
 *
 * **This is `SimNumber`'s consumer, and it exists because of a rule.** `AGENTS.md`: a feature
 * nothing turns on is written rather than ported. An opt-in numeric type with no user in the
 * repository would ship as untested surface area whose first real consumer finds its bugs — so the
 * conformance fixture is written in it, and the exit test, the cross-machine script and the browser
 * check all run both arms.
 *
 * **The two arms are not expected to agree with each other**, and a test asserting they did would be
 * asserting something false: fixed point truncates where floating point rounds, so the arms diverge
 * by design within the first few ticks. What each must be is *reproducible* — identical to itself
 * across a rewind, across a process, and across a machine.
 *
 * ---
 *
 * ## What it simulates, and why it is this and not something simpler
 *
 * Bodies on a ring, each steered toward the one ahead and slowed by drag. It is chosen for what it
 * exercises rather than for what it depicts:
 *
 * - **A transcendental per body per tick**, because that is where two engines disagree. The
 *   floating arm calls `exactSin`/`exactCos`; the fixed arm uses a table, since a fixed-point sine
 *   is a table by construction.
 * - **A square root**, which is the operation `Math.sqrt` is exactly rounded for and `simSqrt` has
 *   to earn by Newton iteration.
 * - **A division**, which is the one operation the fixed arm is deterministic at rather than exact.
 * - **Accumulated rotation**, so a one-ulp difference on tick one is visible by tick a thousand
 *   instead of staying below the noise.
 *
 * A simulation of one body moving in a straight line would be reproducible on any implementation of
 * anything, and would prove nothing.
 */
import {
  SIM_ONE,
  type Sim,
  simAdd,
  simDiv,
  simFrom,
  simMul,
  simSqrt,
  simSub,
  simTo,
} from './simNumber.ts';
import { Fingerprint } from './fingerprint.ts';

export const FIXTURE_BODIES = 12;

/** How many entries the fixed arm's sine table holds over a full turn. A power of two, so the */
/* index arithmetic is a mask rather than a modulo, and the same index is reached on every engine. */
const TABLE_SIZE = 1024;
const TABLE_MASK = TABLE_SIZE - 1;
const TWO_PI = 6.283185307179586;

/**
 * The trigonometry, supplied rather than imported.
 *
 * **`@driftengine/core` is a devDependency here and must stay one.** This package imports
 * `@driftengine/entities` at runtime and nothing else, which is the property that lets an
 * authoritative host run it with no renderer in its module graph — and `boundaries.test.mjs`
 * asserts it against the manifest rather than trusting the prose. So the fixture takes its
 * reproducible sine and cosine as a capability, the way everything else in this package takes its
 * dependencies, and a caller passes core's `exactSin` and `exactCos`.
 */
export interface FixtureMath {
  sin(radians: number): number;
  cos(radians: number): number;
}

export interface FixtureResult {
  /** A hash of the whole state at the end. What another machine compares. */
  readonly digest: string;
  /** The first body's position, for a check that wants a number rather than a hash. */
  readonly x: number;
  readonly y: number;
}

/**
 * The pair of arms, sharing one sine table and one starting state.
 *
 * `runFloat` uses only what `scripts/determinism.mjs` permits: arithmetic, `Math.sqrt`, and the
 * supplied transcendentals. `runFixed` uses only `simNumber`.
 */
export function createFixture(math: FixtureMath): {
  runFloat(ticks: number): FixtureResult;
  runFixed(ticks: number): FixtureResult;
} {
  /*
   * The fixed arm's sine, as a table built once from the floating arm's own function.
   *
   * **A table rather than a fixed-point polynomial**, and the reason is the point of the whole arm:
   * a polynomial would be arithmetic whose exactness needs an argument, and a table is a list of
   * numbers. It is built from the same `sin` the floating arm calls, so the two arms start from one
   * function rather than from two people's idea of one, and it is built here rather than on a tick.
   */
  const table = new Int32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    table[i] = Math.round(math.sin((i / TABLE_SIZE) * TWO_PI) * SIM_ONE);
  }

  const simSin = (angle: Sim): Sim => {
    /* Angle in turns rather than radians, so the index is a multiply and a mask. */
    const turns = simDiv(angle, simFrom(TWO_PI));
    const index = Math.floor((turns / SIM_ONE) * TABLE_SIZE) & TABLE_MASK;
    return table[index] as number;
  };
  const simCos = (angle: Sim): Sim => simSin(simAdd(angle, simFrom(TWO_PI / 4)));

  return { runFloat, runFixed };

  function runFloat(ticks: number): FixtureResult {
    const x = new Float64Array(FIXTURE_BODIES);
    const y = new Float64Array(FIXTURE_BODIES);
    const angle = new Float64Array(FIXTURE_BODIES);
    const speed = new Float64Array(FIXTURE_BODIES);

    for (let i = 0; i < FIXTURE_BODIES; i++) {
      x[i] = i * 0.37;
      y[i] = -i * 0.11;
      angle[i] = i * 0.19;
      speed[i] = 1 + i * 0.013;
    }

    const dt = 1 / 60;
    for (let tick = 0; tick < ticks; tick++) {
      for (let i = 0; i < FIXTURE_BODIES; i++) {
        const ahead = (i + 1) % FIXTURE_BODIES;
        const dx = (x[ahead] as number) - (x[i] as number);
        const dy = (y[ahead] as number) - (y[i] as number);
        const distance = Math.sqrt(dx * dx + dy * dy);
        const steer = distance > 0 ? dy / (distance + 1) : 0;

        angle[i] = (angle[i] as number) + steer * dt;
        speed[i] = (speed[i] as number) * 0.99 + 0.02;
        x[i] = (x[i] as number) + math.cos(angle[i] as number) * (speed[i] as number) * dt;
        y[i] = (y[i] as number) + math.sin(angle[i] as number) * (speed[i] as number) * dt;
      }
    }

    const fingerprint = new Fingerprint();
    fingerprint.array(x).array(y).array(angle).array(speed);
    return { digest: fingerprint.digest(), x: x[0] as number, y: y[0] as number };
  }

  /** The fixed arm. The same simulation, in `Sim`. */
  function runFixed(ticks: number): FixtureResult {
    const x = new Float64Array(FIXTURE_BODIES);
    const y = new Float64Array(FIXTURE_BODIES);
    const angle = new Float64Array(FIXTURE_BODIES);
    const speed = new Float64Array(FIXTURE_BODIES);

    for (let i = 0; i < FIXTURE_BODIES; i++) {
      x[i] = simFrom(i * 0.37);
      y[i] = simFrom(-i * 0.11);
      angle[i] = simFrom(i * 0.19);
      speed[i] = simFrom(1 + i * 0.013);
    }

    const dt = simFrom(1 / 60);
    const one = simFrom(1);
    const drag = simFrom(0.99);
    const gain = simFrom(0.02);

    for (let tick = 0; tick < ticks; tick++) {
      for (let i = 0; i < FIXTURE_BODIES; i++) {
        const ahead = (i + 1) % FIXTURE_BODIES;
        const dx = simSub(x[ahead] as number, x[i] as number);
        const dy = simSub(y[ahead] as number, y[i] as number);
        const distance = simSqrt(simAdd(simMul(dx, dx), simMul(dy, dy)));
        const steer = distance > 0 ? simDiv(dy, simAdd(distance, one)) : 0;

        angle[i] = simAdd(angle[i] as number, simMul(steer, dt));
        speed[i] = simAdd(simMul(speed[i] as number, drag), gain);
        const step = simMul(speed[i] as number, dt);
        x[i] = simAdd(x[i] as number, simMul(simCos(angle[i] as number), step));
        y[i] = simAdd(y[i] as number, simMul(simSin(angle[i] as number), step));
      }
    }

    const fingerprint = new Fingerprint();
    fingerprint.array(x).array(y).array(angle).array(speed);
    return {
      digest: fingerprint.digest(),
      x: simTo(x[0] as number),
      y: simTo(y[0] as number),
    };
  }
}
