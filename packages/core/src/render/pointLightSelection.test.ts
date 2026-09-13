import { describe, expect, it, test } from 'vitest';
import { MAX_POINT_LIGHTS, POINT_SHADOW_POOL } from './lightBudget.ts';
import {
  DEFAULT_POINT_LIGHT_VIEW_RANGE,
  createPointLightBuffer,
  selectPointLights,
} from './pointLightSelection.ts';
import type { PointLightSource } from './pointLightSelection.ts';

function light(x: number, y: number, z: number): PointLightSource {
  return {
    x,
    y,
    z,
    r: 1,
    g: 0.5,
    b: 0.2,
    radius: 12,
    flicker: 0,
    shadowNear: 0.15,
    sourceRadius: 0.06,
  };
}

test('the fixed budget keeps exactly the nearest lights', () => {
  const buffer = createPointLightBuffer();
  const sources: PointLightSource[] = [];
  for (let index = 0; index < MAX_POINT_LIGHTS + 4; index++) sources.push(light(index * 10, 0, 0));

  selectPointLights(sources, 0, 0, 0, buffer);
  expect(buffer.count).toBe(MAX_POINT_LIGHTS);
  expect(Array.from(buffer.positions.filter((_, index) => index % 3 === 0))).toEqual(
    Array.from({ length: MAX_POINT_LIGHTS }, (_, i) => i * 10),
  );

  /*
   * Viewed from 110, the nearest are 110 and 120 (ten metres either side), then 100,
   * then 130, and so on outward — so this is not a descending run, and writing one
   * hid that the ordering is by distance rather than by position.
   */
  selectPointLights(sources, 110, 0, 0, buffer);
  const seen = Array.from(buffer.positions.filter((_, index) => index % 3 === 0));
  const byDistance = sources
    .map((l) => l.x)
    .sort((a, b) => Math.abs(a - 110) - Math.abs(b - 110))
    .slice(0, MAX_POINT_LIGHTS);
  expect(seen.slice().sort((a, b) => a - b)).toEqual(byDistance.slice().sort((a, b) => a - b));
});

test('influence range culls only lights that cannot contribute', () => {
  const buffer = createPointLightBuffer();
  selectPointLights([light(500, 0, 0)], 0, 0, 0, buffer);
  expect(buffer.count).toBe(0);
  selectPointLights([light(40, 0, 0)], 0, 0, 0, buffer);
  expect(buffer.count).toBe(1);
});

test('packed light metadata stays together and reuses its storage', () => {
  const buffer = createPointLightBuffer();
  const positions = buffer.positions;
  const source = light(1, 2, 3);
  source.r = 0.25;
  source.g = 0.5;
  source.b = 0.75;
  source.radius = 20;
  selectPointLights([source], 0, 0, 0, buffer);
  selectPointLights([source], 5, 5, 5, buffer);

  expect(buffer.positions).toBe(positions);
  expect(Array.from(buffer.positions.subarray(0, 3))).toEqual([1, 2, 3]);
  expect(Array.from(buffer.colors.subarray(0, 3))).toEqual([0.25, 0.5, 0.75]);
  expect(buffer.radii[0]).toBe(20);
  expect(buffer.sourceIndex[0]).toBe(0);
});

test('steady lights ignore time while spatially phased flicker does not', () => {
  const buffer = createPointLightBuffer();
  const steady = light(0, 0, 0);
  selectPointLights([steady], 0, 0, 0, buffer, 0);
  const steadyAtZero = buffer.colors[0];
  selectPointLights([steady], 0, 0, 0, buffer, 3.21);
  expect(buffer.colors[0]).toBe(steadyAtZero);

  const fireA = light(0, 0, 0);
  const fireB = light(9, 0, 4);
  fireA.flicker = 0.4;
  fireB.flicker = 0.4;
  selectPointLights([fireA], 0, 0, 0, buffer, 0);
  const fireAtZero = buffer.colors[0];
  selectPointLights([fireA], 0, 0, 0, buffer, 3.21);
  expect(buffer.colors[0]).not.toBe(fireAtZero);

  selectPointLights([fireA, fireB], 0, 0, 0, buffer, 1.7);
  expect(buffer.colors[0]).not.toBe(buffer.colors[3]);
});

test('the contested slot fades out rather than switching off', () => {
  /*
   * *"these are like on/off"*, and the whole of it.
   *
   * A world carries more lights than the shader binds, so somebody is always last.
   * Membership was a step: the light holding the final slot contributed everything,
   * the one behind it nothing, and ordinary camera drift traded them. Both the light
   * and its shadow switched, which is what happens to a gate whose two lights are
   * equidistant by construction: they straddle the cut, so exactly one of them was
   * ever rendered and which one flipped as the camera turned.
   *
   * Hysteresis was tried here first and cannot fix it: a slower swap is still a
   * swap, and the loser is still hard off. What removes it is arriving and leaving
   * at nothing, so the trade happens where there is nothing to trade.
   *
   * The sweep crosses the tie rather than asserting either side of it, because the
   * claim is about every frame in between.
   */
  const buffer = createPointLightBuffer();
  const sources: PointLightSource[] = [];
  // Seven on top of the camera hold the first seven slots wherever it goes, so the
  // eighth is the only contested one and this measures exactly one swap.
  for (let index = 0; index < MAX_POINT_LIGHTS - 1; index++) sources.push(light(0, 0, 0));
  const near = sources.push(light(0, 0, 20)) - 1;
  const far = sources.push(light(0, 0, -20)) - 1;
  /** Camera step between samples, small enough that a real ramp reads as one. */
  const STEP_M = 0.05;

  const weightOf = (index: number): number => {
    for (let slot = 0; slot < buffer.count; slot++) {
      if (buffer.sourceIndex[slot] === index) return buffer.weights[slot] ?? 0;
    }
    // Out of the set is out of the picture, which is the value a step would jump from.
    return 0;
  };
  const holds = (index: number): boolean =>
    Array.from(buffer.sourceIndex.slice(0, buffer.count)).includes(index);

  // Primed outside the measurement: the first sample has nothing before it, and
  // counting the step up from an unmeasured frame would fail every implementation.
  selectPointLights(sources, 0, 0, -3, buffer);
  let previousNear = weightOf(near);
  let previousFar = weightOf(far);
  let previousHolder = holds(near) ? near : far;
  let biggestStep = 0;
  let swaps = 0;
  for (let z = -3 + STEP_M; z <= 3.0001; z += STEP_M) {
    selectPointLights(sources, 0, 0, z, buffer);
    const weightNear = weightOf(near);
    const weightFar = weightOf(far);
    const held = holds(near) ? near : far;
    if (held !== previousHolder) swaps++;
    previousHolder = held;
    biggestStep = Math.max(
      biggestStep,
      Math.abs(weightNear - previousNear),
      Math.abs(weightFar - previousFar),
    );
    previousNear = weightNear;
    previousFar = weightFar;
  }

  expect(swaps, 'the sweep has to cross the tie or it proves nothing').toBeGreaterThan(0);
  /*
   * Five centimetres of camera closes the gap between the two by ten, so the honest
   * step is about 0.033 and the tolerance is three of them. Wide enough not to be
   * about arithmetic, narrow enough that the switch this replaced — a whole 1 —
   * cannot slip through.
   */
  expect(biggestStep, 'a swap must move in slivers, not in ones').toBeLessThan(0.1);
});

test('a light with nothing contesting its slot is at full strength', () => {
  /*
   * The fade is for the boundary, not for the budget. A lamp overhead with the set
   * half empty has to be exactly as bright as it was before any of this.
   */
  const buffer = createPointLightBuffer();
  selectPointLights([light(0, 0, 5)], 0, 0, 0, buffer);
  expect(buffer.weights[0]).toBe(1);
});

test('a light arrives across the last stretch of view range', () => {
  /*
   * A light must not surprise the player by switching on in front of them.
   * The other boundary a light can cross, and the one `e8cd4ec` fixed before
   * `a33fb75` rewrote this function and dropped it.
   */
  const buffer = createPointLightBuffer();
  const edge = light(DEFAULT_POINT_LIGHT_VIEW_RANGE + 12 - 1, 0, 0);
  selectPointLights([edge], 0, 0, 0, buffer);
  expect(buffer.count, 'a metre inside the cull is still in range').toBe(1);
  expect(buffer.weights[0]).toBeGreaterThan(0);
  expect(buffer.weights[0], 'and arrives at almost nothing').toBeLessThan(0.1);
});

test('a clearly nearer light still takes the slot', () => {
  /*
   * Hysteresis must not become stickiness. A lamp the character has walked right up to
   * has to win, or the set freezes on whatever was chosen first and the whole
   * selection stops meaning anything.
   */
  const buffer = createPointLightBuffer();
  const sources: PointLightSource[] = [];
  for (let index = 0; index < MAX_POINT_LIGHTS; index++) sources.push(light(40 + index, 0, 0));
  selectPointLights(sources, 0, 0, 0, buffer);
  expect(Array.from(buffer.sourceIndex)).not.toContain(MAX_POINT_LIGHTS);

  sources.push(light(1, 0, 0));
  selectPointLights(sources, 0, 0, 0, buffer);

  expect(Array.from(buffer.sourceIndex), 'a lamp overhead must win').toContain(MAX_POINT_LIGHTS);
});

test('only a light inside its own radius takes a shadow slot', () => {
  /*
   * `decb3a2` fixed this once: *"Slot acquisition took any light from the buffer,
   * which is culled at 120m view range, but released it when beyond the light's own
   * radius of 14m... slots thrashed between distant lights and shadows blinked on and
   * off as the character moved."*
   *
   * The pool rewrite drove slots from the shaded list and brought it straight back.
   * The shader's falloff is `1 - dist / radius`, so a light past its own radius emits
   * nothing and has nothing to cast — giving it a cubemap starves the lamp overhead.
   */
  const buffer = createPointLightBuffer();
  const near = light(5, 0, 0); // radius 12, well inside
  const far = light(100, 0, 0); // radius 12, lights nothing here

  selectPointLights([near, far], 0, 0, 0, buffer);

  expect(buffer.count, 'both are still shaded, and the far one fades to nothing').toBe(2);
  expect(buffer.shadowCount, 'only the near one casts').toBe(1);
  expect(buffer.shadowIndex[0]).toBe(0);
});

describe('the point a light casts for', () => {
  /*
   * **A third-person camera is not where the caster stands, and the pool is about the caster.**
   * `AGENTS.md` settles the design question this was filed as: *"a character's shadow only has to
   * exist near the light they are standing at"* — they, not the viewer. The shaded list is about
   * what the camera can see and is culled at `viewRange + radius`; the shadow list is about what
   * can cast and is culled at the light's own radius. Those are two questions about two points,
   * and they were one argument.
   *
   * The default is still the shading point, so every existing caller and every published scene
   * selects exactly what it selected before.
   */
  const lamp = (): PointLightSource => ({ ...light(0, 0, 0), radius: 9 });

  it('offers no map when only the viewer is outside the radius', () => {
    const buffer = createPointLightBuffer();
    /* Twenty metres back from a lamp of radius nine: well inside the 189 m shaded cull. */
    selectPointLights([lamp()], 0, 0, 20, buffer);
    expect(buffer.count, 'shaded, because the cull is view range plus radius').toBe(1);
    expect(buffer.shadowCount, 'and nothing casts, which is the defect').toBe(0);
  });

  it('offers one when a caster is inside it', () => {
    const buffer = createPointLightBuffer();
    selectPointLights([lamp()], 0, 0, 20, buffer, 0, DEFAULT_POINT_LIGHT_VIEW_RANGE, 1, 0, 0);
    expect(buffer.shadowCount, 'the subject stands in the light, so it casts').toBe(1);
    expect(buffer.shadowIndex[0]).toBe(0);
  });

  it('defaults to the shading point, so an existing caller is unchanged', () => {
    const withDefault = createPointLightBuffer();
    const spelledOut = createPointLightBuffer();
    const sources = [light(5, 0, 0), light(100, 0, 0), light(2, 0, 0)];

    selectPointLights(sources, 1, 0, 0, withDefault);
    selectPointLights(sources, 1, 0, 0, spelledOut, 0, DEFAULT_POINT_LIGHT_VIEW_RANGE, 1, 0, 0);

    expect(withDefault.shadowCount).toBe(spelledOut.shadowCount);
    expect(Array.from(withDefault.shadowIndex)).toEqual(Array.from(spelledOut.shadowIndex));
  });

  it('ranks the pool by distance from the caster, not from the viewer', () => {
    /*
     * The guard and the rank have to read the same point or the pool fills nearest-to-*camera*
     * and then evicts the lamp the subject is standing under.
     *
     * **The two orders have to disagree, or the test proves nothing.** The first version of this
     * put the subject at x = 7 with the camera at x = 30, where both keys rank the same lamp
     * first — it passed with the rank reverted to the viewer, which is what perturbing the fix
     * is for. Lamps at x = 0 and x = 8, camera at x = 30, subject at x = 1: hand-derived,
     * |1 − 0| = 1 < |1 − 8| = 7 puts lamp 0 first, and |30 − 8| = 22 < |30 − 0| = 30 puts
     * lamp 1 first. One order each way.
     */
    const buffer = createPointLightBuffer();
    const sources = [
      { ...light(0, 0, 0), radius: 20 },
      { ...light(8, 0, 0), radius: 20 },
    ];

    selectPointLights(sources, 30, 0, 0, buffer, 0, DEFAULT_POINT_LIGHT_VIEW_RANGE, 1, 0, 0);

    expect(buffer.shadowCount).toBe(2);
    expect(buffer.shadowIndex[0], 'the lamp the subject stands under is first').toBe(0);
    expect(buffer.shadowIndex[1]).toBe(1);
  });
});

test('the shadow list is nearest first and capped at the pool', () => {
  const buffer = createPointLightBuffer();
  const sources: PointLightSource[] = [];
  // Twenty lamps all within radius 12 of the origin, so every one qualifies.
  for (let index = 0; index < 20; index++) sources.push(light(index * 0.5, 0, 0));

  selectPointLights(sources, 0, 0, 0, buffer);

  expect(buffer.shadowCount).toBe(POINT_SHADOW_POOL);
  expect(buffer.shadowIndex[0]).toBe(0);
});

test('a light with a shadow slot need not have a shader slot', () => {
  /*
   * The two lists are independent. Nine lamps overhead means the ninth is not shaded
   * — the shader binds eight — but it is still inside its own radius, and the pool has
   * room, so it keeps a map ready for the moment it is.
   */
  const buffer = createPointLightBuffer();
  const sources: PointLightSource[] = [];
  for (let index = 0; index < POINT_SHADOW_POOL; index++) sources.push(light(index * 0.5, 0, 0));

  selectPointLights(sources, 0, 0, 0, buffer);

  expect(buffer.count).toBe(MAX_POINT_LIGHTS);
  expect(buffer.shadowCount).toBeGreaterThan(MAX_POINT_LIGHTS);
});

test('a light that does not cast never takes a shadow slot', () => {
  /*
   * A light whose `radius` is animated invalidates its own map every frame, because
   * `matchesSource` compares the range and the range is the cube's far plane. It is
   * therefore stale forever and eats bake budget forever — and with a couple of faces
   * a frame, a handful of them starve every real lamp.
   *
   * Pulsing floor markers animate a squared fade into `radius` each frame. A courtyard full
   * of them left exactly one lamp casting a shadow, which is the bug this prevents.
   */
  const buffer = createPointLightBuffer();
  const pad = { ...light(2, 0, 0), castsShadow: false };
  const lamp = light(4, 0, 0);

  selectPointLights([pad, lamp], 0, 0, 0, buffer);

  expect(buffer.count, 'both still light the world').toBe(2);
  expect(buffer.shadowCount, 'only the lamp casts').toBe(1);
  expect(buffer.shadowIndex[0], 'and it is the lamp, not the nearer pad').toBe(1);
});

/**
 * A buffer wider than the fixed budget, which is what clustered lighting needs.
 *
 * **Clustered lighting shipped in 2.2.0 able to carry 320 lights, and this helper could hand it
 * sixteen.** The froxel table has always taken as many as `MAX_CLUSTERED_LIGHTS`, and a consumer
 * that built the arrays itself could fill it — the engine's own demo page does — but every
 * consumer reaches lights through `selectPointLights`, and its buffer was sized from the shader's
 * uniform arrays. So the capability was real and unreachable by the one path anybody uses, which
 * is the same shape of gap as an index the container carries and no layer passes on.
 *
 * The default is unchanged, so nothing that does not ask for a wider buffer sees any difference.
 */
test('a buffer can be made wider than the fixed budget, and the selection fills it', () => {
  const buffer = createPointLightBuffer(40);
  const sources: PointLightSource[] = [];
  /* Fifty candidates in a line, nearest first by construction. */
  for (let n = 0; n < 50; n++) sources.push(light(n + 1, 0, 0));

  selectPointLights(sources, 0, 0, 0, buffer);

  expect(buffer.count, 'the wider capacity is what caps it, not MAX_POINT_LIGHTS').toBe(40);
  expect(buffer.considered).toBe(50);
  /* Nearest first, so the fortieth is the fortieth nearest and the far ten were dropped. */
  expect(buffer.positions[0]).toBeCloseTo(1, 5);
  expect(buffer.positions[39 * 3]).toBeCloseTo(40, 5);
});

test('the default buffer is still the fixed budget, so nothing that does not ask is changed', () => {
  const buffer = createPointLightBuffer();
  const sources: PointLightSource[] = [];
  for (let n = 0; n < 50; n++) sources.push(light(n + 1, 0, 0));

  selectPointLights(sources, 0, 0, 0, buffer);

  expect(buffer.count).toBe(MAX_POINT_LIGHTS);
});

describe('a spot light', () => {
  const LAMP = {
    x: 0,
    y: 3,
    z: 0,
    r: 1,
    g: 1,
    b: 1,
    radius: 12,
    flicker: 0,
    shadowNear: 0.25,
    sourceRadius: 0.1,
  };

  /*
   * **A light that declares no cone gets the pair that collapses, exactly.** This is the property
   * every published scene depends on: the shader's `smoothstep(cosOuter, cosInner, dot)` returns
   * its upper bound outright once the argument reaches it, and every direction on the sphere has
   * `dot >= -1 >= cosInner`. Approximately-one would be a look change on every scene in the
   * repository, so it is asserted as equality.
   */
  it('leaves a light with no cone admitting every direction', () => {
    const buffer = createPointLightBuffer();
    selectPointLights([LAMP], 0, 0, 0, buffer, 0);
    expect(buffer.count).toBe(1);
    expect(buffer.coneCos[0]).toBe(-1);
    expect(buffer.coneCos[1]).toBe(-2);
  });

  /*
   * **The direction is normalised here rather than trusted.** The cone is a comparison against a
   * cosine, so a vector of length two halves every cosine it produces and gives a cone of the
   * wrong width — which reads as the angle having been set wrong rather than the vector, and is
   * the kind of thing a caller fixes by tuning the angle until it looks right.
   */
  it('normalises the direction a caller supplied', () => {
    const buffer = createPointLightBuffer();
    selectPointLights(
      [{ ...LAMP, dirX: 0, dirY: -3, dirZ: 0, coneOuterDeg: 40 }],
      0,
      0,
      0,
      buffer,
      0,
    );
    expect(buffer.directions[0]).toBeCloseTo(0, 6);
    expect(buffer.directions[1]).toBeCloseTo(-1, 6);
    expect(buffer.directions[2]).toBeCloseTo(0, 6);
  });

  /* Hand-derived: cos 40° = 0.766044, and the inner defaults to three quarters of the outer,
     cos 30° = 0.866025. */
  it('converts the angles to cosines, inner first', () => {
    const buffer = createPointLightBuffer();
    selectPointLights(
      [{ ...LAMP, dirX: 0, dirY: -1, dirZ: 0, coneOuterDeg: 40 }],
      0,
      0,
      0,
      buffer,
      0,
    );
    expect(buffer.coneCos[0]).toBeCloseTo(0.8660254, 6);
    expect(buffer.coneCos[1]).toBeCloseTo(0.7660444, 6);
  });

  /*
   * **Swapped angles are clamped rather than passed through.** `smoothstep` with its edges
   * inverted is a cone dark in the middle and bright at the rim, which is a picture nobody would
   * attribute to two numbers being the wrong way round.
   */
  it('never lets the inner edge pass the outer', () => {
    const buffer = createPointLightBuffer();
    selectPointLights(
      [{ ...LAMP, dirX: 0, dirY: -1, dirZ: 0, coneInnerDeg: 60, coneOuterDeg: 20 }],
      0,
      0,
      0,
      buffer,
      0,
    );
    /* Both at cos 20°, so the edge is hard rather than inverted. */
    expect(buffer.coneCos[0]).toBeCloseTo(buffer.coneCos[1] ?? 0, 6);
  });

  /*
   * A direction with no angle is not a spot. Half a declaration is a caller in the middle of
   * writing one, and taking it would darken their scene for a reason nothing names.
   */
  it('needs an angle as well as a direction', () => {
    const buffer = createPointLightBuffer();
    selectPointLights([{ ...LAMP, dirX: 0, dirY: -1, dirZ: 0 }], 0, 0, 0, buffer, 0);
    expect(buffer.coneCos[0]).toBe(-1);
    expect(buffer.coneCos[1]).toBe(-2);
  });
});
