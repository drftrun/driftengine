import { expect, test } from 'vitest';

import { DEFAULT_RENDER_QUALITY } from './renderQuality.ts';
import {
  createBakeScratch,
  planPointShadowBakes,
  runPointShadowBakes,
  selectCastingLights,
} from './pointShadowBudget.ts';

function plan(stale: number[], ready: number[], slots = 16): number[] {
  const out = new Int32Array(slots);
  const n = planPointShadowBakes(Uint8Array.from(stale), Uint8Array.from(ready), stale.length, out);
  return Array.from(out.slice(0, n));
}

test('nothing stale plans nothing', () => {
  expect(plan([0, 0, 0], [1, 1, 1])).toEqual([]);
});

test('a map with nothing to show is baked before one that merely drifted', () => {
  /*
   * The whole ordering rule. Slot 0 has a usable image a few centimetres out of date;
   * slot 2 has no image at all and its lamp is casting no shadow until this lands.
   * Serving slot 0 first would hold a missing shadow hostage to an invisible fix.
   */
  expect(plan([1, 0, 1], [1, 1, 0])).toEqual([2, 0]);
});

test('within a group the caller order is preserved', () => {
  // That order is the shading pass's own light order, already sorted by how much
  // each light matters, so reordering inside a group would discard real information.
  expect(plan([1, 1, 1, 1], [0, 0, 0, 0])).toEqual([0, 1, 2, 3]);
  expect(plan([1, 1, 1, 1], [1, 1, 1, 1])).toEqual([0, 1, 2, 3]);
});

test('every stale slot is planned, never-baked ones first', () => {
  const order = plan([1, 1, 1, 1, 1], [1, 0, 1, 0, 1]);
  expect(order).toEqual([1, 3, 0, 2, 4]);
  expect(order).toHaveLength(5);
});

test('slots past count are ignored', () => {
  // `count` is the sampled light count, which is usually below the array length:
  // the arrays are sized once for the maximum and reused every frame.
  const out = new Int32Array(8);
  const n = planPointShadowBakes(
    Uint8Array.from([1, 1, 1, 1]),
    Uint8Array.from([0, 0, 0, 0]),
    2,
    out,
  );
  expect(Array.from(out.slice(0, n))).toEqual([0, 1]);
});

test('the plan never overruns the output it was given', () => {
  // A caller sizing `out` to the shader's light budget must not be written past,
  // whatever the sampled count claims.
  const out = new Int32Array(3);
  const n = planPointShadowBakes(
    Uint8Array.from([1, 1, 1, 1, 1, 1]),
    Uint8Array.from([0, 0, 0, 0, 0, 0]),
    6,
    out,
  );
  expect(n).toBe(3);
  expect(Array.from(out)).toEqual([0, 1, 2]);
});

test('a map that will be stale again next frame does not hold up one that will not', () => {
  /*
   * The failure this orders around: a light that moves, or breathes its radius, is owed a
   * bake again the frame after it gets one. Ranked on importance alone it sits permanently
   * ahead of a static light that drifted once and would then hold its image for an hour,
   * takes the spread budget forever, and the static one never gets its correction. Two
   * pulsing floor markers were enough to leave one lamp casting in a whole courtyard.
   */
  const stale = new Uint8Array([1, 1, 1]);
  const ready = new Uint8Array([1, 1, 1]);
  // Slot 0 is the nearest light and never settles; slot 2 drifted once.
  const chronic = new Uint8Array([1, 0, 0]);
  const out = new Int32Array(3);

  const written = planPointShadowBakes(stale, ready, 3, out, chronic);

  expect(written).toBe(3);
  expect(Array.from(out), 'the settling maps first, the chronic one last').toEqual([1, 2, 0]);
});

test('a never-baked map still outranks everything, chronic or not', () => {
  /*
   * A light with no image casts nothing at all, so waiting is visible in a way that
   * correcting a nearly-right image is not. That ordering is older than the chronic group
   * and the chronic group must not disturb it.
   */
  const stale = new Uint8Array([1, 1]);
  const ready = new Uint8Array([1, 0]);
  const chronic = new Uint8Array([0, 1]);
  const out = new Int32Array(2);

  planPointShadowBakes(stale, ready, 2, out, chronic);

  expect(out[0], 'the cold map, even though it never settles').toBe(1);
});

test('a caller that says nothing about staleness gets the old order', () => {
  const stale = new Uint8Array([1, 1]);
  const ready = new Uint8Array([1, 1]);
  const out = new Int32Array(2);

  const written = planPointShadowBakes(stale, ready, 2, out);

  expect(written).toBe(2);
  expect(Array.from(out)).toEqual([0, 1]);
});

test('a light that declines to cast gets no slot, even while it is being shaded', () => {
  /*
   * The flag was read only while building the *eligible* list, so a light that declared
   * `castsShadow: false` still got a cubemap whenever it was one of the lights being
   * shaded — which is every light near the camera, and so every light whose bake anybody
   * would see. It surfaced as a shadow with nothing to throw it, following the player.
   */
  const lights = [{ castsShadow: false }, {}, { castsShadow: true }];
  const shaded = new Int32Array([0, 1, 2]);
  const out = new Int32Array(4).fill(-1);

  const written = selectCastingLights(lights, shaded, 3, out);

  expect(written).toBe(2);
  expect(Array.from(out.subarray(0, written)), 'kept in the shaded order').toEqual([1, 2]);
});

test('an empty slot in the shaded set is skipped rather than baked', () => {
  // -1 is how the selection spells "this slot holds nothing", and indexing lights with it
  // would read past the array rather than skip.
  const out = new Int32Array(4).fill(-1);
  const written = selectCastingLights([{}, {}], new Int32Array([-1, 1, -1]), 3, out);
  expect(written).toBe(1);
  expect(out[0]).toBe(1);
});

/**
 * The live maps, which held no budget at all and cost a courtyard its frame rate.
 *
 * `facesPerFrame` was spent entirely on the static maps above them; the loop over the live
 * maps then asked for the whole cubemap, unconditionally, once per live map per frame. Measured
 * on the consumer and on three of the engine's seven demos: `pointShadow.face` six times
 * every frame, for ever. `LIVE_POINT_SHADOW_MAPS` is two and the second wakes up during an
 * ownership handoff — which is exactly what running past a row of lamps is — so a courtyard was
 * twelve full face passes a frame on top of everything else it draws.
 *
 * Unlike a static map there is no staleness test to make: the caster moved, that is what makes
 * it live. What there has to be is a ceiling, and the faces round-robin under it.
 */
function livePool(liveMapCount: number) {
  const maps = Array.from({ length: liveMapCount }, (_, i) => ({
    id: i,
    hasBaked: true,
    matchesSource: () => true,
  }));
  return {
    pooledCount: 0,
    sampledCount: 0,
    liveMapCount,
    pooledLight: () => -1,
    mapForLight: () => undefined,
    liveOwner: (slot: number) => slot,
    liveMap: (slot: number) => maps[slot],
  };
}

const LIVE_LIGHTS = [
  { x: 0, y: 0, z: 0, radius: 10, shadowNear: 0.1, sourceRadius: 0 },
  { x: 1, y: 0, z: 0, radius: 10, shadowNear: 0.1, sourceRadius: 0 },
];

/** Record what each live map was asked to bake, in order. */
function liveBakes(liveMapCount: number, liveFacesPerFrame: number): number[] {
  const asked: number[] = [];
  runPointShadowBakes(
    livePool(liveMapCount),
    LIVE_LIGHTS,
    /* facesPerFrame */ 2,
    liveFacesPerFrame,
    /* rebakeDistance */ 0.4,
    /* faceCount */ 6,
    createBakeScratch(16),
    {},
    {},
    (_map, _light, _casters, maxFaces) => {
      asked.push(maxFaces);
      return maxFaces;
    },
  );
  return asked;
}

test('two live maps share one face budget instead of taking six each', () => {
  expect(liveBakes(2, 3)).toEqual([3]);
});

test('a budget wider than one cubemap still stops at a cubemap', () => {
  // Six is the whole map; asking for eight would be asking for faces that do not exist.
  expect(liveBakes(1, 8)).toEqual([6]);
});

test('the budget carries to the second map once the first is satisfied', () => {
  // Eight faces: all six of the first map, then the two that are left for the second.
  expect(liveBakes(2, 8)).toEqual([6, 2]);
});

test('a live map is never asked for nothing', () => {
  // A spent budget stops the loop rather than calling bake with zero faces, which would be a
  // pass over the dynamic casters that writes no face.
  for (const faces of liveBakes(2, 6)) expect(faces).toBeGreaterThan(0);
});

test('the default budget still gives both live maps their whole cubemap', () => {
  /*
   * `DEFAULT_RENDER_QUALITY.liveShadowFacesPerFrame` is two cubemaps rather than one, and this
   * is why. The budget is shared across the live maps, not granted to each, so a default of six
   * would let the first take everything and leave the second — the crossfade's map, the one that
   * exists only while a character moves between two lamps — never baked at all. Which is a shadow
   * disappearing at precisely the moment the crossfade was added to smooth.
   */
  expect(liveBakes(2, DEFAULT_RENDER_QUALITY.liveShadowFacesPerFrame)).toEqual([6, 6]);
});

/**
 * A light that wanders finishes its cube in one frame, so its shadow travels instead of stepping.
 *
 * **`planBake` pins the origin for the whole of a resumed bake**, which is what stops half a
 * cubemap around one point and half around another. The consequence is that six faces dribbled
 * out at two a frame publish a *new origin only once every third frame* — and since 4.1.5 the
 * shader shoots from that origin, so the shadow steps with it. Reported on a brazier as motion
 * that was "really fast, not smooth, snappy, and unrealistic": a 20 Hz sample of a flame that
 * wanders about once a second.
 *
 * Given the whole cube at once the origin moves every frame and the shadow travels.
 *
 * The allowance is one light, because eight braziers taking six passes each is the 48 passes the
 * face budget exists to prevent, and it is spent after the cold group so a light arriving in
 * range still gets its first image first.
 */
function trackingPool(maps: { hasBaked: boolean; matchesSource: () => boolean }[]) {
  return {
    pooledCount: maps.length,
    sampledCount: maps.length,
    liveMapCount: 0,
    pooledLight: (slot: number) => slot,
    mapForLight: (light: number) => maps[light],
    liveOwner: () => -1,
    liveMap: () => undefined,
  };
}

/** Run `frames` frames over one scratch, returning what the last frame asked each map for. */
function staticBakes(
  maps: { hasBaked: boolean; matchesSource: () => boolean }[],
  frames: number,
): { light: number; faces: number }[] {
  const scratch = createBakeScratch(16);
  const lights = maps.map((_, i) => ({
    x: i,
    y: 0,
    z: 0,
    radius: 10,
    shadowNear: 0.1,
    sourceRadius: 0,
  }));
  let asked: { light: number; faces: number }[] = [];
  for (let frame = 0; frame < frames; frame++) {
    asked = [];
    runPointShadowBakes(
      trackingPool(maps),
      lights,
      /* facesPerFrame */ 2,
      /* liveFacesPerFrame */ 0,
      /* rebakeDistance */ 0.01,
      /* faceCount */ 6,
      scratch,
      {},
      {},
      (map, _light, _casters, maxFaces) => {
        asked.push({ light: maps.indexOf(map), faces: maxFaces });
        return maxFaces;
      },
    );
  }
  return asked;
}

test('A WANDERING LIGHT GETS ITS WHOLE CUBE IN ONE FRAME, so its origin moves every frame', () => {
  /* One light, baked, and stale again on every frame however it is served: a flame. */
  const flame = { hasBaked: true, matchesSource: () => false };

  /* Two faces while the run is short, which is the ordinary drifted-once budget. */
  expect(staticBakes([flame], 1), 'the first stale frame is not yet chronic').toEqual([
    { light: 0, faces: 2 },
  ]);

  /* CHRONIC_STALE_FRAMES is 3, and past it the whole cube lands inside the frame. */
  expect(staticBakes([flame], 4), 'a light stale every frame stops being dribbled').toEqual([
    { light: 0, faces: 6 },
  ]);
});

test('AND ONLY ONE OF THEM DOES, because eight braziers at six passes is the bill the cap exists for', () => {
  const flames = [
    { hasBaked: true, matchesSource: () => false },
    { hasBaked: true, matchesSource: () => false },
    { hasBaked: true, matchesSource: () => false },
  ];
  const asked = staticBakes(flames, 4);
  expect(asked, 'one light takes the cube and spends the frame doing it').toEqual([
    { light: 0, faces: 6 },
  ]);
});

test('AND A LIGHT WITH NO IMAGE AT ALL IS STILL SERVED FIRST, ahead of a flame refining one', () => {
  /* Cold: holds no image, so it cannot be sampled until its six faces are in. */
  const arriving = { hasBaked: false, matchesSource: () => false };
  const flame = { hasBaked: true, matchesSource: () => false };
  const asked = staticBakes([flame, arriving], 4);
  expect(asked, 'the cold light takes the cube and the flame waits a frame').toEqual([
    { light: 1, faces: 6 },
  ]);
});

test('A QUIET FRAME DOES NOT COST A WANDERER ITS ALLOWANCE, which is what stopped the vibration', () => {
  /*
   * A light wandering on a curve moves less than the rebake tolerance in a frame near the turning
   * points of its travel, so it is not stale on *every* frame. With a run that reset to zero it
   * lost the tracking allowance there and dropped back to two faces, and the shadow then ran
   * smoothly through the fast part of the wander and stepped through the slow part. Reported as
   * the motion still vibrating once the allowance itself was in.
   */
  let stale = true;
  const flame = { hasBaked: true, matchesSource: () => !stale };
  const scratch = createBakeScratch(16);
  const lights = [{ x: 0, y: 0, z: 0, radius: 10, shadowNear: 0.1, sourceRadius: 0 }];
  const run = (): number => {
    let faces = 0;
    runPointShadowBakes(
      trackingPool([flame]),
      lights,
      2,
      0,
      0.001,
      6,
      scratch,
      {},
      {},
      (_map, _light, _casters, maxFaces) => {
        faces = maxFaces;
        return maxFaces;
      },
    );
    return faces;
  };

  /* Four stale frames earns the allowance. */
  for (let frame = 0; frame < 3; frame++) run();
  expect(run(), 'a light stale every frame takes the whole cube').toBe(6);

  /* One quiet frame: it moved less than a millimetre, so nothing is asked for. */
  stale = false;
  expect(run(), 'a light that matches its image is not baked at all').toBe(0);

  /* And it is still tracking on the next frame it moves, rather than starting over. */
  stale = true;
  expect(run(), 'the allowance survives a quiet frame').toBe(6);
});
