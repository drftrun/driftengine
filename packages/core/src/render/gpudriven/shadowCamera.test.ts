import { expect, test } from 'vitest';

import {
  LIGHT_CONE_DISTANCE,
  SHADOW_CULL_CORRECTION,
  SHADOW_LOOKUP_CORRECTION,
  SHADOW_RASTER_CORRECTION,
  correctShadowMatrix,
  fitDirectionalShadow,
  fitShadow,
  lightConeEye,
  sceneShadowBounds,
} from './shadowCamera.ts';
import { SHADOW_DEPTH_FADE } from './shadow.ts';
import { coneBackfacing } from './cullClusters.ts';

/**
 * **What this file is for: a shadow matrix that is wrong does not draw broken, it draws dark.**
 *
 * `depthConvention.ts` says it in those words about the four defects it cost, and every one of them
 * was a matrix. So the fit is asserted against the thing it claims — that every point of the scene
 * lands inside the light's clip box and that a point outside the scene does not — rather than
 * against sixteen numbers, which would pin a transcription and not a property.
 */

/** A point at `centre + direction * distance`, for the sphere the fit is built around. */
function at(
  centre: readonly [number, number, number],
  direction: readonly [number, number, number],
  distance: number,
): [number, number, number] {
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  return [
    centre[0] + (direction[0] / length) * distance,
    centre[1] + (direction[1] / length) * distance,
    centre[2] + (direction[2] / length) * distance,
  ];
}

/** `m · (p, 1)`, column-major, which is how every matrix in this pipeline is stored. */
function project(m: Float32Array, p: readonly [number, number, number]): [number, number, number] {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    out.push(
      (m[row] as number) * p[0] +
        (m[4 + row] as number) * p[1] +
        (m[8 + row] as number) * p[2] +
        (m[12 + row] as number),
    );
  }
  return out as unknown as [number, number, number];
}

/** Directions spread over a sphere, so a test covers a box rather than an axis. */
const DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [1, 1, 1],
  [-1, 1, -1],
  [1, -1, 1],
  [-0.3, 0.8, 0.5],
];

const CENTRE: [number, number, number] = [2, 1, -3];
const RADIUS = 5;
const SUN: [number, number, number] = [0.4, 0.66, 0.35];

test('every point of the scene lands inside the light clip box', () => {
  const m = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, SUN, m);
  for (const direction of DIRECTIONS) {
    const p = project(m, at(CENTRE, direction, RADIUS));
    expect(Math.abs(p[0])).toBeLessThanOrEqual(1 + 1e-5);
    expect(Math.abs(p[1])).toBeLessThanOrEqual(1 + 1e-5);
    expect(Math.abs(p[2])).toBeLessThanOrEqual(1 + 1e-5);
  }
});

test('the box is no larger than the scene, so the map is not spent on nothing', () => {
  const m = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, SUN, m);
  /*
   * The sphere *touches* the box rather than rattling inside it, asserted on the light's own axes
   * rather than on a sampled direction — a cube circumscribing a sphere holds points beyond the
   * radius near its corners, so a sample that misses the axis reads as slack that is not there.
   */
  expect(project(m, at(CENTRE, SUN, RADIUS))[2]).toBeCloseTo(-1, 6);
  expect(project(m, at(CENTRE, [-SUN[0], -SUN[1], -SUN[2]], RADIUS))[2]).toBeCloseTo(1, 6);
  /* Across the light, where the map's texels are spent: a lateral point reaches an edge too. */
  const lateral: [number, number, number] = [SUN[2], 0, -SUN[0]];
  const across = project(m, at(CENTRE, lateral, RADIUS));
  expect(Math.max(Math.abs(across[0]), Math.abs(across[1]))).toBeCloseTo(1, 6);
  /* And a caster further from the light than the scene is is outside the range, not clamped. */
  expect(project(m, at(CENTRE, SUN, RADIUS * 1.2))[2]).toBeLessThan(-1);
});

test('depth runs away from the light, which is what a stored depth means', () => {
  const m = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, SUN, m);
  const near = project(m, at(CENTRE, SUN, RADIUS * 0.9));
  const far = project(m, at(CENTRE, [-SUN[0], -SUN[1], -SUN[2]], RADIUS * 0.9));
  expect(near[2]).toBeLessThan(far[2]);
  /* The centre of the scene is the middle of the range, which is what makes the fit symmetric. */
  expect(project(m, CENTRE)[2]).toBeCloseTo(0, 6);
});

test('the depth span is the metres the range covers', () => {
  const m = new Float32Array(16);
  const span = fitDirectionalShadow(CENTRE, RADIUS, SUN, m);
  expect(span).toBeCloseTo(2 * RADIUS, 6);
  /*
   * The property the lookup rests on: a difference in *stored* depth times the span is the metres
   * between two points along the light. `directionalVisibility` turns a depth difference into a
   * ray distance with exactly this multiply.
   */
  const a = at(CENTRE, SUN, 1);
  const b = at(CENTRE, SUN, 3);
  const stored = (p: readonly [number, number, number]): number => project(m, p)[2] * 0.5 + 0.5;
  expect(Math.abs(stored(a) - stored(b)) * span).toBeCloseTo(2, 5);
});

test('a sun straight overhead is a basis rather than a collapse', () => {
  const m = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, [0, 1, 0], m);
  for (const value of m) expect(Number.isFinite(value)).toBe(true);
  for (const direction of DIRECTIONS) {
    const p = project(m, at(CENTRE, direction, RADIUS));
    expect(Math.abs(p[0])).toBeLessThanOrEqual(1 + 1e-5);
    expect(Math.abs(p[1])).toBeLessThanOrEqual(1 + 1e-5);
    expect(Math.abs(p[2])).toBeLessThanOrEqual(1 + 1e-5);
  }
  /*
   * **The two lateral rows still span the ground, and asserting only the three above does not say
   * so.** `cross(up, axis)` is the zero vector for a sun exactly overhead, and a basis built from
   * it puts *every* point at clip x and y of zero — which is finite, and inside the box, and a
   * shadow map holding one texel's worth of the world. The guard in the module is what this test
   * is named for, so this is the line that fires when it is gone.
   */
  const east = project(m, at(CENTRE, [1, 0, 0], RADIUS));
  const west = project(m, at(CENTRE, [-1, 0, 0], RADIUS));
  const north = project(m, at(CENTRE, [0, 0, 1], RADIUS));
  const south = project(m, at(CENTRE, [0, 0, -1], RADIUS));
  expect(Math.hypot(east[0] - west[0], east[1] - west[1])).toBeCloseTo(2, 5);
  expect(Math.hypot(north[0] - south[0], north[1] - south[1])).toBeCloseTo(2, 5);
});

test("the bounds cover every cluster, read at the cull buffer's own stride", () => {
  /*
   * **Eight floats a cluster, not four**, because what this is handed is the buffer the cull
   * reads: `clusterWorld.ts` writes world centre, radius, cone axis and cutoff, and the four the
   * fit wants are the first of the eight. Reading it four at a time takes every other cluster's
   * cone for a sphere, which is a box fitted around unit vectors at the origin.
   */
  const bounds = Float32Array.from([...[0, 0, 0, 1, 0, 0, 1, 0], ...[10, 0, 0, 2, 0, 0, 1, 0]]);
  const out = new Float32Array(4);
  sceneShadowBounds(bounds, 8, 2, out);

  /* The first cluster spans [-1, 1] and the second [8, 12], so the union is [-1, 12]. */
  const low = (out[0] as number) - (out[3] as number);
  const high = (out[0] as number) + (out[3] as number);
  expect(low).toBeLessThanOrEqual(-1 + 1e-5);
  expect(high).toBeGreaterThanOrEqual(12 - 1e-5);
});

test('an empty scene is a unit sphere rather than a radius of zero', () => {
  const out = new Float32Array(4);
  sceneShadowBounds(new Float32Array(0), 8, 0, out);
  /* A radius of zero divides by zero in the fit, and the matrix that comes back is all NaN. */
  expect(out[3]).toBeGreaterThan(0);
  const m = new Float32Array(16);
  fitDirectionalShadow(
    [out[0] as number, out[1] as number, out[2] as number],
    out[3] as number,
    SUN,
    m,
  );
  for (const value of m) expect(Number.isFinite(value)).toBe(true);
});

test('the two corrections agree about depth and disagree about rows', () => {
  const light = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, SUN, light);
  const raster = new Float32Array(16);
  const lookup = new Float32Array(16);
  correctShadowMatrix(SHADOW_RASTER_CORRECTION, light, raster);
  correctShadowMatrix(SHADOW_LOOKUP_CORRECTION, light, lookup);

  for (const direction of DIRECTIONS) {
    const p = at(CENTRE, direction, RADIUS * 0.8);
    const r = project(raster, p);
    const l = project(lookup, p);
    /* Both put depth in the 0..1 WebGPU clips to, and neither reverses it. */
    expect(r[2]).toBeCloseTo(l[2], 6);
    expect(r[2]).toBeGreaterThanOrEqual(0);
    expect(r[2]).toBeLessThanOrEqual(1);
    /* And the raster's rows are the mirror of the lookup's, which is what makes them agree. */
    expect(r[0]).toBeCloseTo(l[0], 6);
    expect(r[1]).toBeCloseTo(-l[1], 6);
  }
});

test('the raster correction is not the frame correction, which is reversed', () => {
  /* A shadow map is not reversed — `depthConvention.ts` says so and clears it to 1. So the near
     side of the box stores 0 and the far side stores 1, which is the opposite of the frame. */
  const light = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, SUN, light);
  const raster = new Float32Array(16);
  correctShadowMatrix(SHADOW_RASTER_CORRECTION, light, raster);
  const near = project(raster, at(CENTRE, SUN, RADIUS * 0.9));
  const far = project(raster, at(CENTRE, [-SUN[0], -SUN[1], -SUN[2]], RADIUS * 0.9));
  expect(near[2]).toBeLessThan(far[2]);
  expect(near[2]).toBeGreaterThanOrEqual(0);
  expect(far[2]).toBeLessThanOrEqual(1);
});

test('ONLY ONE OF THE TWO CORRECTIONS MIRRORS, and that is what `frontFace: cw` answers', () => {
  /*
   * **The absolute fact about this pair, and the reason the test below it is not one.** Writing the
   * anchor first as "the lookup reads the texel the raster wrote" produced a test that passed with
   * the two matrices' roles **exchanged** — and it was right to: a map stored upside down and read
   * upside down is a correct shadow. Both orderings are self-consistent, so consistency cannot say
   * which is which.
   *
   * What says it is the rasteriser. The raster correction negates clip `y`, which mirrors every
   * triangle and therefore reverses its winding, and `gpuDrivenPass` answers that with
   * `frontFace: 'cw'` — a pipeline state chosen for a matrix, in another file, with nothing between
   * them. Exchange the two and that state is drawing the **back** faces of every caster into the
   * map, which is a shadow offset by the thickness of whatever cast it.
   *
   * So the claim is a determinant: the one the raster uses mirrors, the one the lookup uses does
   * not. It is three numbers and it is the only statement here that survives swapping the pair.
   */
  const upper = (m: Float32Array): number =>
    (m[0] as number) *
      ((m[5] as number) * (m[10] as number) - (m[6] as number) * (m[9] as number)) -
    (m[4] as number) *
      ((m[1] as number) * (m[10] as number) - (m[2] as number) * (m[9] as number)) +
    (m[8] as number) * ((m[1] as number) * (m[6] as number) - (m[2] as number) * (m[5] as number));

  expect(upper(SHADOW_RASTER_CORRECTION)).toBeLessThan(0);
  expect(upper(SHADOW_LOOKUP_CORRECTION)).toBeGreaterThan(0);

  /* And the mirroring survives composition with a fit, which is what the pass actually binds. */
  const light = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, SUN, light);
  const raster = new Float32Array(16);
  const lookup = new Float32Array(16);
  correctShadowMatrix(SHADOW_RASTER_CORRECTION, light, raster);
  correctShadowMatrix(SHADOW_LOOKUP_CORRECTION, light, lookup);
  expect(Math.sign(upper(raster))).toBe(-Math.sign(upper(lookup)));
});

test('and the lookup addresses the row the viewport wrote, for every point the map holds', () => {
  /*
   * The consistency half, which is worth keeping even though the test above is the one that pins
   * the ordering. It states the two external rules in the one place a reader will look for them:
   *
   * - A WebGPU viewport puts clip `y = +1` at **framebuffer row 0**, so a rasterised point lands at
   *   `(0.5 - ndc.y * 0.5) * size`.
   * - `shadowDepthAt(u, v)` in `shade.wgsl.ts` reads row `floor(v * size)` with
   *   `v = ndc.y * 0.5 + 0.5`, straight off the lookup matrix.
   *
   * Break one of the two corrections and the rows part company, which does not draw a mirrored
   * shadow — it draws a **smeared region with no relation to any caster**, because every receiver
   * reads the map where the light was pointing at something else. §3 row 77.
   *
   * Continuous coordinates rather than texel indices on purpose: a point landing a millionth of a
   * texel either side of a boundary is not a defect, and rounding first is how a test of this shape
   * becomes flaky instead of wrong.
   */
  const size = 1024;
  const light = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, SUN, light);
  const raster = new Float32Array(16);
  const lookup = new Float32Array(16);
  correctShadowMatrix(SHADOW_RASTER_CORRECTION, light, raster);
  correctShadowMatrix(SHADOW_LOOKUP_CORRECTION, light, lookup);

  let seed = 0x5f3a91c7;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let trial = 0; trial < 200; trial += 1) {
    const p = at(
      CENTRE,
      [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1],
      random() * RADIUS * 0.95,
    );
    const r = project(raster, p);
    const l = project(lookup, p);

    const rasterColumn = ((r[0] as number) * 0.5 + 0.5) * size;
    const rasterRow = (0.5 - (r[1] as number) * 0.5) * size;
    const lookupColumn = ((l[0] as number) * 0.5 + 0.5) * size;
    const lookupRow = ((l[1] as number) * 0.5 + 0.5) * size;

    expect(lookupColumn, `trial ${trial}: the column`).toBeCloseTo(rasterColumn, 2);
    expect(lookupRow, `trial ${trial}: the row`).toBeCloseTo(rasterRow, 2);
    /*
     * And the depth the raster stores is the depth the lookup compares against — §3 row 74, where a
     * GL-style remap gives a shadow half as deep and biased by half the map, which reads as
     * everything being lit.
     */
    expect(l[2] as number, `trial ${trial}: the depth`).toBeCloseTo(r[2] as number, 6);
  }
});

/*
 * **A world rather than a rig.** Everything above fits the map to the whole scene, which is right
 * for a few metres of boxes and wrong for a world: the voxel sandbox's port at radius 14 is a sphere
 * hundreds of metres across, and one 2048 map over it has texels a quarter of a metre wide. Past a
 * radius the caller names, the map follows the eye instead — the forward path's own answer, in
 * `lightMatrix.ts` — and at or under it nothing changes, so the three rigs stay the control.
 */

const MAP = 2048;
/** A world's bounding sphere: centre, then radius, as `sceneShadowBounds` writes it. */
const WORLD = Float32Array.from([10, 0, -20, 400]);
const EYE: [number, number, number] = [130, 24, -75];
const FOLLOW = 32;

/** The map's own right, up and toward-the-light axes, read back out of a fitted matrix. */
function axesOf(m: Float32Array, radius: number): [number, number, number][] {
  return [0, 1].map((row) => [
    (m[row] as number) * radius,
    (m[4 + row] as number) * radius,
    (m[8 + row] as number) * radius,
  ]) as [number, number, number][];
}

test('A SCENE NO LARGER THAN THE RADIUS IS FITTED AS IT ALWAYS WAS, bit for bit', () => {
  const sphere = Float32Array.from([...CENTRE, RADIUS]);
  const before = new Float32Array(16);
  const spanBefore = fitDirectionalShadow(CENTRE, RADIUS, SUN, before);
  for (const follow of [undefined, RADIUS, RADIUS * 4]) {
    const after = new Float32Array(16);
    /* An eye nowhere near the scene, so a fit that followed it would show. */
    expect(fitShadow(sphere, EYE, follow, SUN, MAP, after)).toBe(spanBefore);
    expect([...after]).toEqual([...before]);
  }
});

test('A SCENE LARGER THAN THE RADIUS IS FITTED AROUND THE EYE, to that radius', () => {
  const m = new Float32Array(16);
  fitShadow(WORLD, EYE, FOLLOW, SUN, MAP, m);
  for (const axis of axesOf(m, FOLLOW)) {
    /* Within a texel of the eye's own sphere, so half a texel of snap either way is allowed. */
    const inside = project(m, at(EYE, axis, FOLLOW - 0.1));
    const outside = project(m, at(EYE, axis, FOLLOW + 0.1));
    expect(Math.abs(inside[0]) <= 1 && Math.abs(inside[1]) <= 1).toBe(true);
    expect(Math.abs(outside[0]) > 1 || Math.abs(outside[1]) > 1).toBe(true);
  }
  /* The eye is the middle of the map, to the snap. */
  const middle = project(m, EYE);
  expect(Math.abs(middle[0])).toBeLessThanOrEqual(1 / MAP + 1e-6);
  expect(Math.abs(middle[1])).toBeLessThanOrEqual(1 / MAP + 1e-6);
});

test('IT MOVES IN WHOLE TEXELS AS THE EYE DOES, so no edge crawls', () => {
  /*
   * **What snapping is for.** A map that slid with the eye continuously would resample every
   * shadow edge at a new sub-texel offset each frame, and the edges would crawl as the player
   * walked. Snapped, the map's corner only ever lands on the texel grid of a fixed light space, so
   * a world point's texel changes in whole steps or not at all. The origin's clip position is the
   * negated snapped centre, and it has to be a whole number of texels at every eye position.
   */
  const texelClip = 2 / MAP;
  for (let step = 0; step < 64; step += 1) {
    const eye: [number, number, number] = [
      EYE[0] + step * 0.173,
      EYE[1] + step * 0.011,
      EYE[2] - step * 0.291,
    ];
    const m = new Float32Array(16);
    fitShadow(WORLD, eye, FOLLOW, SUN, MAP, m);
    for (const translation of [m[12] as number, m[13] as number]) {
      const texels = translation / texelClip;
      expect(Math.abs(texels - Math.round(texels))).toBeLessThan(1e-3);
    }
  }
  /*
   * **And along each of the light's three axes, a walk of one texel moves the map at most once.**
   * Twenty steps of a twentieth of a texel: snapped, the matrix is one of two; unsnapped, it is a
   * new one every step. The third axis is depth, which does not crawl but does drift — every stored
   * depth moving each frame — and `lightMatrix.ts` snaps it for that reason.
   */
  const first = new Float32Array(16);
  fitShadow(WORLD, EYE, FOLLOW, SUN, MAP, first);
  const [right, up] = axesOf(first, FOLLOW) as [[number, number, number], [number, number, number]];
  const toward: [number, number, number] = [
    right[1] * up[2] - right[2] * up[1],
    right[2] * up[0] - right[0] * up[2],
    right[0] * up[1] - right[1] * up[0],
  ];
  const texelMetres = (2 * FOLLOW) / MAP;
  for (const axis of [right, up, toward]) {
    const seen = new Set<string>();
    for (let step = 0; step < 20; step += 1) {
      const m = new Float32Array(16);
      fitShadow(WORLD, at(EYE, axis, (step * texelMetres) / 20), FOLLOW, SUN, MAP, m);
      seen.add([...m].join());
    }
    expect(seen.size).toBeLessThanOrEqual(2);
  }
});

test('an eye beyond the scene on the sunward side still gets a radius of depth either way', () => {
  /* Flown up past the world toward the sun, there is nothing further to reach; the sphere itself
     must still be in range, or what is beneath the eye is clipped out of its own map. */
  const m = new Float32Array(16);
  const high = at(EYE, SUN, 2000);
  /* Two radii either way, the least that keeps the sphere clear of the lookup's fade. */
  expect(fitShadow(WORLD, high, FOLLOW, SUN, MAP, m)).toBeCloseTo(4 * FOLLOW, 9);
  expect(project(m, at(high, SUN, FOLLOW - 0.5))[2]).toBeGreaterThanOrEqual(-1);
});

test('DEPTH REACHES TOWARD THE SUN AS FAR AS THE SCENE DOES, so a tall caster outside still casts', () => {
  /*
   * **A map a sphere deep clips what stands between the sphere and the sun.** A tower two hundred
   * metres up the light's ray from the eye is outside the eye's sphere and is exactly what shadows
   * the street the eye stands in at dusk. `lightMatrix.ts` reaches three radii; this reaches the
   * scene's own far side, which is where the last caster can be.
   */
  const m = new Float32Array(16);
  const span = fitShadow(WORLD, EYE, FOLLOW, SUN, MAP, m);
  const tower = project(m, at(EYE, SUN, 200));
  expect(tower[2]).toBeGreaterThanOrEqual(-1);
  expect(tower[2]).toBeLessThan(project(m, EYE)[2]);
  /* Every point of the scene up the light's ray is in range. */
  const sunward = project(m, at(EYE, SUN, 0));
  expect(sunward[2]).toBeLessThanOrEqual(1);
  const length = Math.hypot(...SUN);
  const toward = (WORLD[0] as number) * SUN[0] + (WORLD[1] as number) * SUN[1];
  const reach = (toward + (WORLD[2] as number) * SUN[2]) / length + (WORLD[3] as number);
  const eyeAlong = (EYE[0] * SUN[0] + EYE[1] * SUN[1] + EYE[2] * SUN[2]) / length;
  expect(project(m, at(EYE, SUN, reach - eyeAlong - 1))[2]).toBeGreaterThanOrEqual(-1);
  /* The span is still the metres the range covers, which the lookup multiplies by. */
  const a = at(EYE, SUN, 1);
  const b = at(EYE, SUN, 3);
  const stored = (p: readonly [number, number, number]): number => project(m, p)[2] * 0.5 + 0.5;
  expect(Math.abs(stored(a) - stored(b)) * span).toBeCloseTo(2, 4);
});

test('THE EYE\u2019S SPHERE SITS WHERE THE LOOKUP DOES NOT FADE IT, at every depth along the light', () => {
  /*
   * **The lookup gives up on the last stretch of the map's depth**, `SHADOW_DEPTH_FADE` of the
   * stored range, because in the scene fit that is the scene's far rim. A following range that
   * reached far toward the sun and only a radius away from it put every receiver in that stretch:
   * ground ten metres below the eye along the light came out forty per cent less shadowed, and
   * the sphere's far side not at all. The first version did exactly that, and the fit's own tests
   * could not see it — they are about where points land, and this is about what the lookup does
   * with where they land.
   */
  for (const eye of [EYE, at(EYE, SUN, 2000), [10, 0, -20] as [number, number, number]]) {
    const m = new Float32Array(16);
    fitShadow(WORLD, eye, FOLLOW, SUN, MAP, m);
    for (const along of [-FOLLOW, -FOLLOW / 2, 0, FOLLOW / 2, FOLLOW]) {
      const stored = project(m, at(eye, SUN, along))[2] * 0.5 + 0.5;
      expect(stored).toBeGreaterThanOrEqual(0);
      expect(stored).toBeLessThan(SHADOW_DEPTH_FADE[0]);
    }
  }
});

test('THE DEPTH RANGE MOVES IN WHOLE RADII, so walking does not rescale every stored depth', () => {
  /*
   * The reach toward the sun depends on where the eye is inside the world, and a range that
   * followed it exactly would change the depth scale every frame — every stored depth and the
   * receiver tolerance with it. Rounded up to a whole number of radii, it changes only when the
   * eye has walked a radius's worth along the light.
   */
  const spans = new Set<number>();
  for (let step = 0; step < 40; step += 1) {
    const m = new Float32Array(16);
    const span = fitShadow(WORLD, [EYE[0] + step * 0.05, EYE[1], EYE[2]], FOLLOW, SUN, MAP, m);
    expect((span / FOLLOW) % 1).toBeCloseTo(0, 9);
    spans.add(span);
  }
  expect(spans.size).toBe(1);
});

/*
 * **A directional light has no eye, and the cone test wants one.** The light's cull stands its eye
 * `LIGHT_CONE_DISTANCE` toward the sun, where every direction to a cluster in the map is the sun's
 * own to within the scene's size over that distance — so the perspective test the shader has
 * answers the directional one, which is the one the map's raster applies when it culls the faces
 * turned from the light.
 */
test('THE LIGHT’S CONE EYE ANSWERS THE DIRECTIONAL TEST, for clusters across a city', () => {
  const random = (() => {
    let state = 0x2545f491;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  })();
  const toward = [0.938, 0.052, 0.341];
  const length = Math.hypot(toward[0] as number, toward[1] as number, toward[2] as number);
  const light: [number, number, number] = [
    (toward[0] as number) / length,
    (toward[1] as number) / length,
    (toward[2] as number) / length,
  ];
  const eye: [number, number, number] = [40, 12, -300];
  const cone = lightConeEye(eye, light, [0, 0, 0]);
  /* Moved along the light by the whole distance, from the camera's eye. */
  for (let i = 0; i < 3; i += 1) {
    expect(cone[i]).toBeCloseTo((eye[i] as number) + (light[i] as number) * LIGHT_CONE_DISTANCE, 0);
  }
  let culled = 0;
  let wrong = 0;
  let edge = 0;
  for (let n = 0; n < 4000; n += 1) {
    const ax = random() * 2 - 1;
    const ay = random() * 2 - 1;
    const az = random() * 2 - 1;
    const al = Math.hypot(ax, ay, az) || 1;
    const cutoff = random() * 0.9;
    const cx = (random() * 2 - 1) * 1500;
    const cy = random() * 400;
    const cz = (random() * 2 - 1) * 1500;
    const radius = 1 + random() * 20;
    const perspective = coneBackfacing(
      ax / al,
      ay / al,
      az / al,
      cutoff,
      cx,
      cy,
      cz,
      radius,
      cone[0],
      cone[1],
      cone[2],
    );
    /* Every ray runs against the light, so every triangle faces away when the cone does. */
    const along = -(ax * light[0] + ay * light[1] + az * light[2]) / al;
    if (Math.abs(along - cutoff) < 1e-4) {
      edge += 1;
      continue;
    }
    if (perspective !== along > cutoff) wrong += 1;
    if (perspective) culled += 1;
  }
  expect(wrong).toBe(0);
  expect(edge).toBeLessThan(10);
  expect(culled).toBeGreaterThan(800);
});

test('the cone eye takes a light direction of any length', () => {
  const eye: [number, number, number] = [1, 2, 3];
  const unit = lightConeEye(eye, [0, 1, 0], [0, 0, 0]);
  const long = lightConeEye(eye, [0, 5, 0], [0, 0, 0]);
  expect(long).toEqual(unit);
});

test('THE LIGHT’S CULL SEES THE RASTER’S MAP WITH ITS DEPTH TURNED OVER, and its rows as they are', () => {
  /*
   * The light's pyramid is stored turned over, `1 - depth`, so the camera's cull can read it; the
   * matrix that cull projects a cluster through has to turn its depth over the same way and leave
   * everything else where the raster put it — the rows included, because the pyramid's rows are the
   * map's and the map's are the raster's.
   */
  const light = new Float32Array(16);
  fitDirectionalShadow(CENTRE, RADIUS, SUN, light);
  const raster = correctShadowMatrix(SHADOW_RASTER_CORRECTION, light, new Float32Array(16));
  const cull = correctShadowMatrix(SHADOW_CULL_CORRECTION, raster, new Float32Array(16));
  for (const direction of DIRECTIONS) {
    const p = at(CENTRE, direction, RADIUS * 0.8);
    const r = project(raster, p);
    const c = project(cull, p);
    expect(c[0]).toBeCloseTo(r[0], 6);
    expect(c[1]).toBeCloseTo(r[1], 6);
    expect(c[2]).toBeCloseTo(1 - r[2], 6);
  }
  /* So the side toward the sun is now the larger number, as the camera's near side is. */
  const near = project(cull, at(CENTRE, SUN, RADIUS * 0.9));
  const far = project(cull, at(CENTRE, [-SUN[0], -SUN[1], -SUN[2]], RADIUS * 0.9));
  expect(near[2]).toBeGreaterThan(far[2]);
});
