import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { boxShape, cylinderShape, hullShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';

/**
 * What an n-gon prism costs where an exact cylinder does not, measured rather than asserted.
 *
 * **This file was written while a cylinder was refused, and the measurement in it is what
 * withdrew the refusal on 2026-08-27.** `shape.ts` used to say a cylinder was not expressible in a
 * point-cloud-plus-radius representation — a uniform rounding radius grows around every feature, so
 * it would round the rim as well as the side — and it pointed a consumer at `hullShape` with an
 * n-gon prism instead. What that advice cost had never been written down, and once it was, the
 * numbers said the workaround did not cover the case the refusal itself named.
 *
 * Two costs, and they are different in kind:
 *
 * 1. **A geometric one, which is arithmetic**: an n-gon inscribed in a circle of radius `r` is
 *    short by `r * (1 − cos(π / n))` at the middle of each flat. That is exact and needs no
 *    simulation, so it is asserted as arithmetic below rather than measured.
 * 2. **A dynamic one, which is not**: a prism resting on a flat sits `r * cos(π / n)` above the
 *    ground rather than `r`, and rolling it lifts the centre back to `r` at each vertex. So a
 *    rolling prism bobs, and the bob is what a player sees. That is measured.
 *
 * And there is a **ceiling** on the workaround, which is the finding that decided it: `hullShape`
 * refuses more than **64 points**, and a prism spends two per side, so **32 sides is the most a
 * consumer can build**. Whatever bob remains at thirty-two cannot be reduced by adding sides.
 *
 * The file stays, and gains one test: the same wheel built as a `cylinderShape`, rolled the same
 * way, so the shape kind's own claim is measured against the thing it replaced rather than against
 * a tolerance. `cylinder.test.ts` is where the rest of the cylinder's properties live.
 */

const DT = 1 / 60;

/** A regular n-gon prism about z, which is the axis it rolls around here. */
function prism(sides: number, radius: number, halfDepth: number): ReturnType<typeof hullShape> {
  const points: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    points.push(x, y, -halfDepth, x, y, halfDepth);
  }
  return hullShape(points);
}

/**
 * How far the centre of a rolling wheel moves up and down over one run, in metres.
 *
 * `sides` of zero means the cylinder, which stands along y and so arrives turned a quarter turn
 * about x to put its axis where the prism's already is.
 */
function rollBob(sides: number): number {
  const world = new PhysicsWorld({ gravityY: -9.81, allowSleep: false });
  world.addBody({ type: BODY_STATIC, shape: boxShape(100, 1, 100), y: -1, friction: 1 });
  const turn = sides === 0 ? { qx: Math.SQRT1_2, qy: 0, qz: 0, qw: Math.SQRT1_2 } : {};
  const wheel = world.addBody({
    type: BODY_DYNAMIC,
    shape: sides === 0 ? cylinderShape(1, 0.3) : prism(sides, 1, 0.3),
    y: 1.2,
    density: 500,
    friction: 1,
    ...turn,
  });
  /* Settle first, so the bob measured is rolling rather than landing. */
  for (let i = 0; i < 90; i++) world.step(DT);
  world.bodies.velX[wheel] = 6;
  world.bodies.angZ[wheel] = -6;

  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < 120; i++) {
    world.step(DT);
    const y = world.bodies.posY[wheel] ?? 0;
    if (y < lowest) lowest = y;
    if (y > highest) highest = y;
  }
  return highest - lowest;
}

describe('the prism a consumer built while a cylinder was refused', () => {
  /**
   * **The geometric cost, which is exact and is the number to quote.**
   *
   * `r * (1 − cos(π / n))` at the middle of a flat. Hand-derived at r = 1: an octagon is 76 mm
   * short, a sixteen-gon 19 mm, a thirty-two-gon 4.8 mm. That is the error a consumer accepts, and
   * it halves twice for every doubling of the side count — which is why the answer to "not round
   * enough" is more sides rather than a new shape kind.
   */
  it('is short of the circle by a known amount at the middle of each flat', () => {
    const shortfall = (sides: number): number => 1 - Math.cos(Math.PI / sides);
    expect(shortfall(8)).toBeCloseTo(0.076, 3);
    expect(shortfall(16)).toBeCloseTo(0.019, 3);
    expect(shortfall(32)).toBeCloseTo(0.0048, 4);
  });

  /**
   * **The ceiling, and it is the number that decides whether the refusal holds.**
   *
   * `hullShape` refuses more than 64 points — "derive shapes from defining points, not meshes" —
   * and a prism spends two per side. So thirty-two sides is not a recommendation, it is the wall,
   * and "add more sides" stops being an answer there.
   */
  it('cannot be built past thirty-two sides, because a hull takes 64 points', () => {
    expect(() => prism(32, 1, 0.3)).not.toThrow();
    expect(() => prism(33, 1, 0.3)).toThrow(/64/);
  });

  /**
   * **The comparison the shape kind had to win, and by how much.**
   *
   * The same wheel, the same floor, the same 6 m/s: the thirty-two-sided prism bobs about sixteen
   * millimetres and cannot do better, and the cylinder bobs **under two**, which is inside the
   * solver's own five-millimetre slop. A cylinder's support is exactly its radius at every angle,
   * so there is no vertex to lift the centre onto and nothing left for more sides to fix.
   */
  it('is beaten by an exact cylinder, which has no facets to climb', () => {
    const cylinder = rollBob(0);
    expect(cylinder).toBeLessThan(0.005);
    expect(cylinder).toBeLessThan(rollBob(32) / 3);
  });

  /**
   * **The dynamic cost: a rolling prism bobs, and the bob shrinks with the side count.**
   *
   * A bob is what a player sees; a geometric shortfall is not. Measured on a rolling wheel of
   * radius 1 at 6 m/s: **an octagon bobs 119 mm, a sixteen-gon 49 mm, a thirty-two-gon 16 mm** —
   * roughly the third-per-doubling the arithmetic predicts, arrived at through the whole solver
   * rather than from the shape alone.
   *
   * **Sixteen millimetres on a one-metre wheel is the floor of the workaround**, because
   * thirty-two sides is the hull's own ceiling. `shape.ts` named "a wheel rim, a rolling barrel" as
   * what would reverse the cylinder refusal, and a centimetre and a half of bob on a slow, close,
   * deliberately-rolling subject is plainly visible — so the workaround did not cover the case the
   * refusal pointed at. That is what withdrew it, and it is why this measurement exists.
   */
  it('bobs while it rolls, and sixteen millimetres is the best the workaround can do', () => {
    const eight = rollBob(8);
    const sixteen = rollBob(16);
    const thirtyTwo = rollBob(32);

    expect(eight).toBeGreaterThan(sixteen);
    expect(sixteen).toBeGreaterThan(thirtyTwo);
    /* Wide bounds on purpose: what is asserted is the order of magnitude and the direction, not
       the third decimal place of a solver's settling. */
    expect(eight).toBeGreaterThan(0.05);
    expect(thirtyTwo).toBeGreaterThan(0.005);
    expect(thirtyTwo).toBeLessThan(0.04);
  });
});
