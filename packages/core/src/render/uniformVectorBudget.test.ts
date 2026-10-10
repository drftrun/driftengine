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

/**
 * The lit stage, at one budget, with everything a game turns on turned on — **but a surface
 * overlay**, which declares its vectors only where a draw has set one and the device has the room
 * (`setSurfaceOverlay`), so it is not part of what a budget is planned against.
 */
/*
 * Without the four switches content turns on — the overlay, a projection, the moving sun's own
 * matrix and layers — as a renderer starts.
 */
const lit = (
  budget: LightBudget,
  surfaceOverlay = false,
  worldUvs = false,
  movingSun = false,
  layered = false,
  layerLooks = false,
): string =>
  flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: false,
    nightEmissive: false,
    surfaceOverlay,
    worldUvs,
    movingSun,
    layered,
    layerLooks,
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
     *
     * **Each is one more since two-sided surfaces**, 441 and 249: \`uDoubleSided\` is an int, and a
     * scalar takes a row of its own. The device's two numbers were 440 and 248 for the source it
     * linked; the count moves by exactly what the source added.
     *
     * **And two more since DriftLight**, 443 and 251: its two vectors, and no more, because the
     * eight-light rung is then 254 of this part's 256. A first cut at five vectors put that rung at
     * 258 and dropped the part to four lights, which is what this pin is here to catch.
     *
     * **And one fewer since the shading models**, 442 and 250. A model's numbers are two vectors,
     * and the eight-light rung was already 255 at 4.8.3 — measured; the 254 above had gone stale
     * with nothing pinning the rung itself — so they put it at 257 and the part at four lights,
     * caught by the planner's tests on their first run. The material's four integer switches
     * became one \`ivec4\`, three rows for one, and the rung is 254 with the models in it.
     */
    expect(countUniformVectors(lit(FULL_LIGHT_BUDGET))).toBe(442);
    /* A material's projection, when one asks, is its one vector and no more: worldUv.ts. */
    expect(
      countUniformVectors(lit(FULL_LIGHT_BUDGET, false, true)) -
        countUniformVectors(lit(FULL_LIGHT_BUDGET)),
    ).toBe(1);
    /* The moving sun's matrix and span, five: movingSun.ts. */
    expect(
      countUniformVectors(lit(FULL_LIGHT_BUDGET, false, false, true)) -
        countUniformVectors(lit(FULL_LIGHT_BUDGET)),
    ).toBe(5);
    /* A material's layers, four: layered.ts. */
    expect(
      countUniformVectors(lit(FULL_LIGHT_BUDGET, false, false, false, true)) -
        countUniformVectors(lit(FULL_LIGHT_BUDGET)),
    ).toBe(4);
    /* And their picks and looks beside them, fifteen more, which is why they are a switch apart. */
    expect(
      countUniformVectors(lit(FULL_LIGHT_BUDGET, false, false, false, true, true)) -
        countUniformVectors(lit(FULL_LIGHT_BUDGET, false, false, false, true)),
    ).toBe(15);
    const withoutPointShadows = flatFrag({
      pointShadows: false,
      directionalShadows: true,
      environmentProbe: false,
      nightEmissive: false,
      surfaceOverlay: false,
      worldUvs: false,
      movingSun: false,
      layered: false,
    });
    expect(countUniformVectors(withoutPointShadows)).toBe(250);
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

  /*
   * **An Adreno 740 keeps eight lights**: the rung a 256-vector part is planned onto, pinned on its
   * own because a pin on the full budget let it drift to 255 unseen, and the next two vectors then
   * cost the part half its lights.
   */
  it('KEEPS THE EIGHT-LIGHT RUNG INSIDE THE 256 VECTORS AN ADRENO 740 OFFERS', () => {
    expect(countUniformVectors(lit({ maxLights: 8, maxAreaLights: 2 }))).toBeLessThanOrEqual(256);
  });

  /*
   * **A surface overlay is fifteen vectors, which that rung has no room for**: 254 and 269 against
   * 256, so the WebGL2 renderer refuses the overlay there in words rather than linking a program
   * the part refuses. Pinned so a smaller overlay, or a larger rung, is a decision someone sees.
   */
  it('PUTS A SURFACE OVERLAY AT FIFTEEN VECTORS, PAST THE ADRENO 740’S EIGHT-LIGHT RUNG', () => {
    const rung = { maxLights: 8, maxAreaLights: 2 };
    const without = countUniformVectors(lit(rung));
    expect(countUniformVectors(lit(rung, true)) - without).toBe(15);
    expect(countUniformVectors(lit(rung, true))).toBeGreaterThan(256);
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
  expect(plan.ceilingVectors).toBe(442);
  expect(plan.vectors).toBeLessThan(plan.ceilingVectors);
  expect(builds, 'one build per rung tried and not one more').toBe(3);
});
