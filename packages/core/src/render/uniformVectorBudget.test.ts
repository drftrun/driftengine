import { describe, expect, it } from 'vitest';

import { flatFrag } from './shaders/flat/index.ts';
import {
  countUniformVectors,
  FULL_LIGHT_BUDGET,
  GUARANTEED_FRAGMENT_UNIFORM_VECTORS,
  LIGHT_BUDGET_LADDER,
  type LightBudget,
  nextLightBudget,
  planLightBudget,
} from './uniformVectorBudget.ts';

/** The lit stage, at one budget, with everything a game turns on turned on. */
const lit = (budget: LightBudget): string =>
  flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
    maxLights: budget.maxLights,
    maxAreaLights: budget.maxAreaLights,
  });

describe('countUniformVectors', () => {
  it('gives an array one row per element whatever its base type', () => {
    /* Appendix A: `float uA[16]` costs the sixteen rows `vec3 uB[16]` does, not four. */
    expect(countUniformVectors('uniform float uA[16];')).toBe(16);
    expect(countUniformVectors('uniform vec3 uB[16];')).toBe(16);
    expect(countUniformVectors('uniform mat4 uC[2];')).toBe(8);
  });

  it('resolves an array size written as a define, which is how every shader here sizes one', () => {
    expect(countUniformVectors('#define N 8\nuniform vec3 uA[N];')).toBe(8);
    /* `#define LIGHT_LOOP_MAX MAX_LIGHTS` is the shape this alias branch exists for. */
    expect(countUniformVectors('#define N 8\n#define M N\nuniform vec3 uA[M];')).toBe(8);
  });

  it('skips samplers, which are counted against the texture units instead', () => {
    const source = 'uniform sampler2D uA;\nuniform highp sampler2DArray uB;\nuniform vec4 uC;';
    expect(countUniformVectors(source)).toBe(1);
  });

  it('reads a precision qualifier without charging for it', () => {
    expect(countUniformVectors('uniform highp float uA[4];')).toBe(4);
  });

  it('counts what the report measured off the vendored source', () => {
    /*
     * The two numbers a consumer counted on an Adreno 740 and confirmed on the device by linking
     * both permutations there: 440 is refused where the part offers 256, and 248 links. They are
     * pinned here because the whole budget rests on this function agreeing with a real driver.
     */
    expect(countUniformVectors(lit(FULL_LIGHT_BUDGET))).toBe(440);
    const withoutPointShadows = flatFrag({
      pointShadows: false,
      directionalShadows: true,
      environmentProbe: false,
      nightEmissive: false,
    });
    expect(countUniformVectors(withoutPointShadows)).toBe(248);
  });
});

describe('the ladder', () => {
  it('reaches what WebGL2 guarantees with every feature still compiled in', () => {
    /*
     * The complaint this closes: switching point shadows off is 248 and a conforming device may
     * offer only 224, so no consumer-side option could reach the floor. A rung that fits with
     * point shadows *on* is what makes the floor reachable at all.
     */
    const floor = LIGHT_BUDGET_LADDER[LIGHT_BUDGET_LADDER.length - 1];
    expect(countUniformVectors(lit(floor))).toBeLessThanOrEqual(
      GUARANTEED_FRAGMENT_UNIFORM_VECTORS,
    );
  });

  it('descends, so each rung is a real step down from the one above it', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const rung of LIGHT_BUDGET_LADDER) {
      const vectors = countUniformVectors(lit(rung));
      expect(vectors).toBeLessThan(previous);
      previous = vectors;
    }
  });

  it('starts at the budget the rest of the engine is written for', () => {
    expect(LIGHT_BUDGET_LADDER[0]).toEqual(FULL_LIGHT_BUDGET);
  });
});

describe('nextLightBudget', () => {
  it('steps down a rung', () => {
    expect(nextLightBudget(FULL_LIGHT_BUDGET)).toEqual({ maxLights: 12, maxAreaLights: 3 });
  });

  it('steps a budget between rungs to the largest rung under it', () => {
    expect(nextLightBudget({ maxLights: 6, maxAreaLights: 2 })).toEqual({
      maxLights: 4,
      maxAreaLights: 1,
    });
  });

  it('runs out, so a caller retrying on a refusal terminates', () => {
    let budget: LightBudget | null = FULL_LIGHT_BUDGET;
    let steps = 0;
    while (budget !== null) {
      budget = nextLightBudget(budget);
      steps++;
      expect(steps).toBeLessThan(20);
    }
    expect(steps).toBeGreaterThan(1);
  });
});

describe('planLightBudget', () => {
  it('keeps the full budget on a device with room, and builds once to decide it', () => {
    let builds = 0;
    const plan = planLightBudget(4096, FULL_LIGHT_BUDGET, (budget) => {
      builds++;
      return lit(budget);
    });
    expect(plan.budget).toEqual(FULL_LIGHT_BUDGET);
    expect(plan.fits).toBe(true);
    expect(builds).toBe(1);
  });

  it('keeps point shadows on the part that could not link the full shader', () => {
    /*
     * The reported device: an Adreno 740 at 256 vectors, where the full budget's 440 is refused.
     * The consumer's only lever was `pointShadows: false`; this keeps the feature and fits.
     */
    const plan = planLightBudget(256, FULL_LIGHT_BUDGET, lit);
    expect(plan.fits).toBe(false);
    expect(plan.vectors).toBeLessThanOrEqual(256);
    expect(plan.budget.maxLights).toBe(8);
    expect(plan.source).toContain('#define MAX_LIGHTS 8');
    /* Still the full shader: the point-shadow arrays are declared, not compiled out. */
    expect(plan.source).toContain('uPointShadowLayer[MAX_LIGHTS]');
  });

  it('fits a device at the guaranteed floor', () => {
    const plan = planLightBudget(GUARANTEED_FRAGMENT_UNIFORM_VECTORS, FULL_LIGHT_BUDGET, lit);
    expect(plan.vectors).toBeLessThanOrEqual(GUARANTEED_FRAGMENT_UNIFORM_VECTORS);
  });

  it('honours a ceiling that is not a rung rather than rounding it down', () => {
    const plan = planLightBudget(4096, { maxLights: 6, maxAreaLights: 2 }, lit);
    expect(plan.budget).toEqual({ maxLights: 6, maxAreaLights: 2 });
    expect(plan.source).toContain('#define MAX_LIGHTS 6');
    expect(plan.fits).toBe(true);
  });

  it('never returns more than the ceiling it was given', () => {
    const plan = planLightBudget(4096, { maxLights: 4, maxAreaLights: 1 }, lit);
    expect(plan.budget.maxLights).toBeLessThanOrEqual(4);
    expect(plan.budget.maxAreaLights).toBeLessThanOrEqual(1);
  });

  it('hands back the smallest build when nothing fits, for the driver to answer', () => {
    /*
     * This counts an upper bound, so a refusal here is not a verdict. The caller compiles what
     * comes back and lets the link decide — which is why there is a source and a `fits: false`
     * rather than a throw.
     */
    const plan = planLightBudget(1, FULL_LIGHT_BUDGET, lit);
    expect(plan.fits).toBe(false);
    expect(plan.source).toContain('#define MAX_LIGHTS 2');
    expect(plan.vectors).toBeGreaterThan(1);
  });
});

/** The ceiling's own cost is carried, so a caller's message never rebuilds the source to get it. */
it('reports what the ceiling would have spent even when it could not have it', () => {
  let builds = 0;
  const plan = planLightBudget(256, FULL_LIGHT_BUDGET, (budget) => {
    builds++;
    return lit(budget);
  });
  expect(plan.ceilingVectors).toBe(440);
  expect(plan.vectors).toBeLessThan(plan.ceilingVectors);
  expect(builds, 'one build per rung tried and not one more').toBe(3);
});
