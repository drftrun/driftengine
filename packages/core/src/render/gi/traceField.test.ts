import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { composeGlobalField, createGlobalField } from './globalField.ts';
import { FIELD_MARCH, coneRadiusAt, newFieldHit, traceField } from './traceField.ts';

import type { FieldSource, GlobalField } from './globalField.ts';

/**
 * **What this file is for: a march that converges, misses honestly, and does not start inside.**
 *
 * The world-space fallback is what makes the screen-space level legitimate — it is the "something
 * behind it" the refusal in `ROADMAP.md` requires. So its own failures matter more than they would
 * on their own: a march that does not converge leaves the chain answering from probes everywhere,
 * a march that reports a miss it should have answered does the same, and a march that hits the
 * surface it started on puts every surface in shadow of itself.
 */

/** A sphere's exact field, sampled onto a grid. Analytic, so every assertion below is a closed form. */
function sphereField(radius: number, half: number, resolution: number): FieldSource {
  const field = new Float32Array(resolution ** 3);
  const step = (2 * half) / (resolution - 1);
  for (let iz = 0; iz < resolution; iz++) {
    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
        field[ix + resolution * (iy + resolution * iz)] =
          Math.hypot(-half + ix * step, -half + iy * step, -half + iz * step) - radius;
      }
    }
  }
  return {
    field,
    dims: [resolution, resolution, resolution],
    bounds: new Float32Array([-half, -half, -half, half, half, half]),
  };
}

/** One unit sphere at the origin, in a field reaching eight metres. */
function world(): GlobalField {
  const field = createGlobalField(65, 2);
  const at = mat4.fromTranslation(new Float32Array(16), [0, 0, 0]) as Float32Array;
  composeGlobalField([{ source: sphereField(1, 2, 33), transform: at }], [0, 0, 0], 4, field);
  return field;
}

test('A MARCH CONVERGES ON A SPHERE, and does it in a step count worth having', () => {
  /*
   * **Convergence is the whole reason a distance field is worth baking.** A ray against a triangle
   * list is a traversal; a ray against a field steps by the field's own value, which is a distance
   * nothing can be nearer than, so each step is as long as it can safely be. On a sphere that is
   * a handful of steps whatever the distance — and a march that needs its whole budget is one
   * whose field is not a distance, which `sdf.ts` and `globalField.ts` both have tests for.
   */
  const field = world();
  const hit = newFieldHit();

  /* From open space, so there is no surface to lift off and no normal to lift along. */
  const found = traceField(field, [3.5, 0, 0], [0, 0, 0], [-1, 0, 0], FIELD_MARCH, hit);

  expect(found).toBe(true);
  expect(hit.distanceM).toBeCloseTo(2.5, 1);
  expect(Math.hypot(hit.x, hit.y, hit.z)).toBeCloseTo(1, 1);
  expect(hit.steps).toBeLessThan(12);
});

test('a march that approaches at an angle converges too', () => {
  const field = world();
  const hit = newFieldHit();
  const from = [2.5, 2.5, 0] as const;
  const length = Math.hypot(from[0], from[1], from[2]);
  const found = traceField(
    field,
    from,
    [0, 0, 0],
    [-from[0] / length, -from[1] / length, 0],
    FIELD_MARCH,
    hit,
  );
  expect(found).toBe(true);
  expect(Math.hypot(hit.x, hit.y, hit.z)).toBeCloseTo(1, 1);
});

test('A RAY THAT ESCAPES THE FIELD REPORTS A MISS, rather than the edge of the outermost cascade', () => {
  /*
   * **The field's own bound, and it has to be reported as one.** Outside the outermost cascade
   * there is no information at all — `sampleGlobalField` clamps to the edge rather than
   * extrapolating, which is the right answer for a sample and the wrong one for a march: a march
   * that kept stepping on clamped values would converge on the boundary of the cascade and report
   * a surface made of nothing. This is the level below's cue: a probe volume is never wrong and
   * only ever coarse, and it is what answers here.
   */
  const field = world();
  const hit = newFieldHit();

  const found = traceField(field, [3, 0, 0], [1, 0, 0], [1, 0, 0], FIELD_MARCH, hit);

  expect(found).toBe(false);
  expect(hit.hit).toBe(false);
  expect(hit.escaped).toBe(true);
});

test('a ray that runs out of reach before it escapes reports a miss that is not an escape', () => {
  const field = world();
  const hit = newFieldHit();
  /* Along the x axis from well inside, with a reach too short to clear the cascade. */
  const short = { ...FIELD_MARCH, reachM: 1 };
  expect(traceField(field, [3, 0, 0], [1, 0, 0], [1, 0, 0], short, hit)).toBe(false);
  expect(hit.escaped).toBe(false);
});

test('THE CONE WIDENS WITH DISTANCE, which is what a rough surface gathers through', () => {
  /*
   * **A rough surface does not reflect a ray, it reflects a lobe**, and the honest way to trace a
   * lobe against a distance field is a cone: the radius grows with the distance travelled, and a
   * hit is where the field's value falls below that radius rather than below a constant. What it
   * buys is that the blur is *correct by construction* rather than applied afterwards — a wider
   * cone stops further from a surface, so what it gathers is a broader patch of it.
   *
   * **The ray has to graze, and the first version of this test did not.** A cone aimed dead centre
   * at a sphere arrives exactly where a pencil ray does, because the axis reaches the surface
   * before any edge of the cone does — so both stopped at 2.5 m and the test asserted a difference
   * that geometry does not produce. Aimed 1.3 m off the centre of a unit sphere, the axis misses by
   * 30 cm and only a cone wide enough to reach across that gap finds anything at all.
   */
  expect(coneRadiusAt(0, 0.2)).toBe(0);
  expect(coneRadiusAt(1, 0.2)).toBeCloseTo(Math.tan(0.2), 6);
  expect(coneRadiusAt(2, 0.2)).toBeCloseTo(2 * Math.tan(0.2), 6);

  const field = world();
  const graze = [3.5, 1.3, 0] as const;
  const pencil = newFieldHit();
  const narrow = newFieldHit();
  const wide = newFieldHit();
  traceField(field, graze, [0, 0, 0], [-1, 0, 0], { ...FIELD_MARCH, coneAngle: 0 }, pencil);
  traceField(field, graze, [0, 0, 0], [-1, 0, 0], { ...FIELD_MARCH, coneAngle: 0.1 }, narrow);
  traceField(field, graze, [0, 0, 0], [-1, 0, 0], { ...FIELD_MARCH, coneAngle: 0.3 }, wide);

  /* The axis passes 30 cm clear, so a ray of no width finds nothing and says so. */
  expect(pencil.hit).toBe(false);
  expect(pencil.escaped).toBe(true);

  /* Both cones reach across the gap, and the wider one reaches across it sooner. */
  expect(narrow.hit).toBe(true);
  expect(wide.hit).toBe(true);
  expect(wide.distanceM).toBeLessThan(narrow.distanceM);
  expect(wide.radiusM).toBeGreaterThan(narrow.radiusM);

  /* And the radius reported is the cone's own opening at the distance it stopped. */
  expect(wide.radiusM).toBeCloseTo(coneRadiusAt(wide.distanceM, 0.3), 5);
  expect(narrow.radiusM).toBeCloseTo(coneRadiusAt(narrow.distanceM, 0.1), 5);
});

test('A RAY DOES NOT HIT THE SURFACE IT LEAVES, whatever direction it leaves in', () => {
  /*
   * **A march starting on a surface starts at distance zero, which is a hit before it moves.** The
   * offset has to be proportional to the *field's* resolution rather than to a constant, because
   * what it is escaping is the field's own error near a surface — a voxel of it — and that is a
   * different number in each cascade and in each scene. `FIELD_START_VOXELS` says how many.
   *
   * Tangent directions are the hard ones: every other direction leaves the surface on its own.
   */
  const field = world();
  const hit = newFieldHit();
  const offenders: string[] = [];
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    /* A point on the unit sphere at the equator, and a direction in its tangent plane. */
    const nx = Math.cos(angle);
    const nz = Math.sin(angle);
    const found = traceField(
      field,
      [nx, 0, nz],
      [nx, 0, nz],
      [-nz, 0, nx],
      { ...FIELD_MARCH, coneAngle: 0 },
      hit,
    );
    /* A tangent ray does eventually curve away from a sphere, so a hit within a few centimetres
       is the surface it started on and anything further is the sphere's far side, which is real. */
    if (found && hit.distanceM < 0.2) {
      offenders.push(`ray ${i} hit its own surface at ${hit.distanceM.toFixed(4)} m`);
    }
  }
  expect(offenders).toEqual([]);
});

test('a march refuses a direction of no length rather than stepping nowhere for ever', () => {
  const field = world();
  const hit = newFieldHit();
  expect(() => traceField(field, [3, 0, 0], [1, 0, 0], [0, 0, 0], FIELD_MARCH, hit)).toThrow(
    /direction/i,
  );
});
