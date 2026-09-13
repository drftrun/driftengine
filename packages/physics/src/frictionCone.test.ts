import { describe, expect, it } from 'vitest';
import { BODY_DYNAMIC, BODY_STATIC } from './bodies.ts';
import { boxShape } from './shape.ts';
import { PhysicsWorld } from './world.ts';
import type { FrictionModel } from './solver.ts';

const DT = 1 / 60;
const SPEED = 4;

/**
 * How far a box slides before friction stops it, launched along one heading.
 *
 * The measurement that separates the two models, and it needs no knowledge of which world
 * directions the solver picked for its tangent basis — which is the point, because that basis is
 * constructed from the contact normal and is not a consumer's to know.
 */
function slideDistance(model: FrictionModel | undefined, heading: number): number {
  const world = new PhysicsWorld(model === undefined ? {} : { frictionModel: model });
  world.addBody({ type: BODY_STATIC, shape: boxShape(50, 1, 50), y: -1, friction: 0.8 });
  const box = world.addBody({
    type: BODY_DYNAMIC,
    shape: boxShape(0.5, 0.5, 0.5),
    y: 0.5,
    density: 500,
    friction: 0.8,
  });
  /* Let it bed in before it is pushed, so the slide is measured against a settled contact. */
  for (let i = 0; i < 30; i++) world.step(DT);
  const startX = world.bodies.posX[box] ?? 0;
  const startZ = world.bodies.posZ[box] ?? 0;
  world.bodies.velX[box] = Math.cos(heading) * SPEED;
  world.bodies.velZ[box] = Math.sin(heading) * SPEED;
  for (let i = 0; i < 180; i++) world.step(DT);
  return Math.hypot((world.bodies.posX[box] ?? 0) - startX, (world.bodies.posZ[box] ?? 0) - startZ);
}

function overHeadings(model: FrictionModel): number[] {
  const distances: number[] = [];
  for (let i = 0; i < 8; i++) distances.push(slideDistance(model, (i * Math.PI) / 4));
  return distances;
}

describe('the friction cone', () => {
  /**
   * **Two independent clamps make a box, and a box is anisotropic in a way nothing justifies.**
   *
   * Each tangent axis is bounded at `mu * N` on its own, so along the diagonal between them the
   * pair can reach `sqrt(2) * mu * N` — forty-one per cent more friction than the same surface
   * offers along an axis. The tangent basis is constructed from the contact normal, so *which*
   * directions are cheap is an artefact of that construction rather than a fact about the world.
   *
   * Hand-derived: friction decelerates at `mu * g`, so a slide covers `v^2 / (2 * mu * g)` and the
   * diagonal covers `1 / sqrt(2)` of the axis-aligned distance — a ratio of 1.414.
   *
   * **Measured: 1.064 m along the axes against 0.737 m along the diagonals, a ratio of 1.46.** A
   * little past the analytic 1.414 because a substepped solve reaches its bound rather than sitting
   * exactly on it. The bounds below are wide of that on both sides on purpose: what is being
   * asserted is that a box is *visibly* anisotropic, not the second decimal place of how much.
   */
  it('is a box by default, and a box slides further along some headings than others', () => {
    const distances = overHeadings('box');
    const longest = Math.max(...distances);
    const shortest = Math.min(...distances);
    expect(longest / shortest).toBeGreaterThan(1.3);
    expect(longest / shortest).toBeLessThan(1.6);
  });

  /**
   * **An ellipse couples the two axes, and friction becomes what it physically is: isotropic.**
   *
   * The same surface, the same speed, every heading — one distance. This is the whole of what the
   * row buys, and it is a correctness fix rather than a feature.
   */
  it('slides the same distance in every direction when it is elliptical', () => {
    /* Measured: 1.059 to 1.073 m across eight headings, a ratio of 1.013. The remainder is the
       solver's own settling asymmetry, which `solver.test.ts` measures at under a millimetre. */
    const distances = overHeadings('elliptical');
    const longest = Math.max(...distances);
    const shortest = Math.min(...distances);
    expect(longest / shortest).toBeLessThan(1.03);
  });

  /**
   * **The control, and it is the one that says the ellipse did not simply weaken friction.**
   *
   * On a tangent axis the two models agree exactly — the box's clamp and the ellipse's radius are
   * the same number there. So the elliptical distance must match the box's *longest*, which is the
   * axis-aligned one, rather than sitting anywhere between the box's two extremes.
   */
  it('matches the box model along the headings where the two agree', () => {
    const boxed = overHeadings('box');
    const elliptical = overHeadings('elliptical');
    expect(Math.max(...elliptical)).toBeCloseTo(Math.max(...boxed), 1);
  });

  /**
   * **The default is the old numbers, exactly, and that is what lets a stored replay survive.**
   *
   * Every stacking result moves under the ellipse — `fingerprintBodies`, both baselines and any
   * golden a consumer has kept — so it is behind a world option rather than shipped as the new
   * behaviour. A world that says nothing has to be bit-identical to one that says `box`.
   */
  it('answers the same numbers unasked as it does asked for the box', () => {
    expect(new PhysicsWorld({}).frictionModel).toBe('box');

    /* Bit-identical, not merely close: an option nobody set must not move a stored replay by a
       float. `toBe` rather than `toBeCloseTo`, because the claim is equality. */
    const unasked = slideDistance(undefined, Math.PI / 4);
    expect(unasked).toBe(slideDistance('box', Math.PI / 4));
    /* And the ellipse genuinely differs there, or the assertion above would hold trivially. */
    expect(unasked).not.toBe(slideDistance('elliptical', Math.PI / 4));
  });
});
