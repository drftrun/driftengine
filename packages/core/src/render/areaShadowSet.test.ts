import { describe, expect, it } from 'vitest';

import type { AreaLightSource } from './areaLights.ts';
import { MAX_AREA_LIGHTS } from './areaLights.ts';
import {
  areaShadowLayerCount,
  castingRange,
  createResolvedAreaShadows,
  firstAreaShadowLayer,
  AreaShadowSet,
  type AreaShadowMap,
} from './areaShadowSet.ts';
import { LIVE_POINT_SHADOW_MAPS, POINT_SHADOW_POOL } from './lightBudget.ts';
import { createBakeScratch } from './pointShadowBudget.ts';
import { FACE_COUNT, POINT_SHADOW_NEAR } from './pointShadowImage.ts';

const PANEL: AreaLightSource = {
  x: 0,
  y: 3,
  z: 0,
  r: 1,
  g: 1,
  b: 1,
  rightX: 1,
  rightY: 0,
  rightZ: 0,
  upX: 0,
  upY: 0,
  upZ: 1,
  halfWidth: 1.6,
  halfHeight: 0.5,
};

/** A rectangle that will cast, which takes both a flag and a range. See `castingRange`. */
function casting(over: Partial<AreaLightSource> = {}): AreaLightSource {
  return { ...PANEL, castsShadow: true, shadowRange: 12, ...over };
}

/**
 * A map with no device in it: the fields this set reads and a record of what it was asked to bake.
 *
 * `PointShadowMap` and `GpuPointShadowMap` are the real ones and both are `PointShadowImage` plus a
 * layer index — see `AreaShadowMap`. This stands in for the image so the scheduling can be tested
 * against literals, which is the half of the row that was priced cheap.
 */
class FakeMap implements AreaShadowMap {
  far = 0;
  near = 0;
  hasBaked = false;
  presence = 0;
  /** What `matchesSource` will answer, so a test can make a map stale on purpose. */
  matches = true;
  /** Every bake this map was given, as `[range, near, faces]`. */
  readonly bakes: [number, number, number][] = [];
  advanced = 0;
  forgotten = 0;

  constructor(readonly layer: number) {}

  /**
   * **A map that has never baked matches nothing**, which is what `PointShadowImage` answers and
   * what makes a fresh map stale enough to be scheduled at all. A fake that answered `true` here
   * reported every rectangle as settled and nothing ever baked — which is exactly the shape of the
   * defect this class stands in for, so it is worth the fake carrying the rule rather than a flag.
   */
  matchesSource(): boolean {
    return this.hasBaked && this.matches;
  }

  advance(dt: number): void {
    this.advanced += dt;
  }

  forget(): void {
    this.forgotten++;
    this.hasBaked = false;
  }

  /** What a renderer's callback does, compressed: render the faces and publish the parameters. */
  bake(range: number, near: number, faces: number): number {
    this.bakes.push([range, near, faces]);
    this.far = range;
    this.near = near;
    this.hasBaked = true;
    this.presence = 1;
    this.matches = true;
    return faces;
  }
}

/** A set over `FakeMap`, with the maps it built kept in the order it built them. */
function fakeSet(): { set: AreaShadowSet<FakeMap>; built: FakeMap[]; released: FakeMap[] } {
  const built: FakeMap[] = [];
  const released: FakeMap[] = [];
  const set = new AreaShadowSet<FakeMap>(
    (layer) => {
      const map = new FakeMap(layer);
      built.push(map);
      return map;
    },
    (map) => released.push(map),
  );
  return { set, built, released };
}

/** Drive one frame's scheduling, answering with what each map was asked to bake. */
function runFrame(
  set: AreaShadowSet<FakeMap>,
  lights: readonly AreaLightSource[],
  facesPerFrame = 2,
  liveFacesPerFrame = 12,
): void {
  set.update(
    lights,
    1 / 60,
    facesPerFrame,
    liveFacesPerFrame,
    0.4,
    FACE_COUNT,
    createBakeScratch(MAX_AREA_LIGHTS),
    'static',
    'dynamic',
    (map, _light, range, near, _casters, maxFaces) => map.bake(range, near, maxFaces),
  );
}

describe('whether a rectangle casts at all', () => {
  it('takes both a flag and a range, because there is no far plane to invent', () => {
    expect(castingRange(PANEL)).toBe(0);
    expect(castingRange({ ...PANEL, castsShadow: true })).toBe(0);
    expect(castingRange({ ...PANEL, shadowRange: 12 })).toBe(0);
    expect(castingRange(casting())).toBe(12);
  });

  it('refuses a range that is not a usable distance', () => {
    /* A far plane of zero or less is a projection with no depth range at all, and a NaN one
       propagates into every matrix entry — the shape AGENTS.md records as a scene drawn black. */
    expect(castingRange(casting({ shadowRange: 0 }))).toBe(0);
    expect(castingRange(casting({ shadowRange: -4 }))).toBe(0);
    expect(castingRange(casting({ shadowRange: Number.NaN }))).toBe(0);
    expect(castingRange(casting({ shadowRange: Number.POSITIVE_INFINITY }))).toBe(0);
  });

  it('costs a world nothing until a rectangle asks for it', () => {
    expect(areaShadowLayerCount([])).toBe(0);
    expect(areaShadowLayerCount([PANEL, PANEL, PANEL])).toBe(0);
  });

  it('counts two layers per casting rectangle: the static world and the movers', () => {
    expect(areaShadowLayerCount([casting()])).toBe(2);
    expect(areaShadowLayerCount([casting(), PANEL, casting()])).toBe(4);
  });

  it('counts nothing for a rectangle past the shaded budget', () => {
    /*
     * The lit pass loops to `MAX_AREA_LIGHTS` and breaks, so a fifth rectangle is not shaded. A
     * layer for it is 4.19 MB of storage nothing can read.
     */
    const many = Array.from({ length: MAX_AREA_LIGHTS + 3 }, () => casting());
    expect(areaShadowLayerCount(many)).toBe(MAX_AREA_LIGHTS * 2);
  });
});

describe('where the area layers sit in the shared array', () => {
  it('begins where the point pool and the live pair end', () => {
    /*
     * `PointShadowArray` sizes itself `min(lightCount, POOL) + LIVE`, and the area layers follow.
     * One function answers this for both the array and the set: the two disagreeing by one would
     * have every rectangle sampling a lamp's map, which is a picture rather than an error.
     */
    expect(firstAreaShadowLayer(0)).toBe(LIVE_POINT_SHADOW_MAPS);
    expect(firstAreaShadowLayer(3)).toBe(3 + LIVE_POINT_SHADOW_MAPS);
    expect(firstAreaShadowLayer(500)).toBe(POINT_SHADOW_POOL + LIVE_POINT_SHADOW_MAPS);
  });

  it('hands out a static layer and a live one per casting rectangle, in slot order', () => {
    const { set, built } = fakeSet();
    const first = firstAreaShadowLayer(4);
    set.prepare([casting(), PANEL, casting()], first);
    expect(built.map((map) => map.layer)).toEqual([first, first + 1, first + 2, first + 3]);
    expect(set.castingCount).toBe(2);
  });

  it('gives the layers back when it is prepared again', () => {
    const { set, built, released } = fakeSet();
    set.prepare([casting()], 8);
    set.prepare([casting()], 8);
    expect(released).toEqual(built.slice(0, 2));
  });
});

describe('noticing that a declaration changed', () => {
  it('accepts the lights it was prepared for', () => {
    const { set } = fakeSet();
    const lights = [casting(), PANEL];
    set.prepare(lights, 8);
    expect(set.matchesDeclaration(lights)).toBe(true);
  });

  it('refuses when a rectangle starts or stops casting', () => {
    /*
     * A layer is fixed for the life of a map and the shader is told its index, so a rectangle
     * joining or leaving moves every layer after it. Carrying on would publish one fixture's
     * layer under another, which is its shadow appearing under the wrong light.
     */
    const { set } = fakeSet();
    set.prepare([casting(), PANEL], 8);
    expect(set.matchesDeclaration([casting(), casting()])).toBe(false);
    expect(set.matchesDeclaration([PANEL, PANEL])).toBe(false);
  });

  it('refuses before it has ever been prepared', () => {
    const { set } = fakeSet();
    expect(set.matchesDeclaration([casting()])).toBe(false);
  });

  it('ignores a change past the shaded budget, which holds no layers either way', () => {
    const { set } = fakeSet();
    const four = Array.from({ length: MAX_AREA_LIGHTS }, () => casting());
    set.prepare(four, 8);
    expect(set.matchesDeclaration([...four, casting()])).toBe(true);
  });
});

describe('spending a frame on area shadows', () => {
  it('gives a rectangle with no image the whole map at once', () => {
    /*
     * The point pool's rule, and it is about the projection rather than about impatience: half a
     * baked octahedral map holds a shadow and half holds the far plane, so the floor is cut in two
     * along a line belonging to the encoding. One such jump a frame.
     */
    const { set, built } = fakeSet();
    set.prepare([casting()], 8);
    runFrame(set, [casting()], 2);
    expect(built[0]?.bakes).toEqual([[12, POINT_SHADOW_NEAR, FACE_COUNT]]);
  });

  it('serves a rectangle that has never baked before one that merely drifted', () => {
    const { set, built } = fakeSet();
    const lights = [casting({ x: -4 }), casting({ x: 4 })];
    set.prepare(lights, 8);
    /* The first slot already holds an image and has drifted; the second holds nothing. */
    const drifted = built[0];
    const cold = built[2];
    if (drifted === undefined || cold === undefined) throw new Error('maps not built');
    drifted.hasBaked = true;
    drifted.matches = false;
    cold.hasBaked = false;
    runFrame(set, lights, FACE_COUNT);
    expect(cold.bakes.length).toBe(1);
    expect(drifted.bakes.length).toBe(0);
  });

  it("carries the caller's near plane through to the bake", () => {
    const { set, built } = fakeSet();
    const lights = [casting({ shadowNear: 0.9 })];
    set.prepare(lights, 8);
    runFrame(set, lights);
    expect(built[0]?.bakes[0]?.[1]).toBe(0.9);
  });

  it('re-bakes the live layer every frame with no staleness test at all', () => {
    /* The caster moved, which is what makes it live. There is nothing to compare. */
    const { set, built } = fakeSet();
    const lights = [casting()];
    set.prepare(lights, 8);
    runFrame(set, lights);
    runFrame(set, lights);
    expect(built[1]?.bakes.length).toBe(2);
  });

  it('bounds the live half across four rectangles rather than asking for twenty-four faces', () => {
    const { set, built } = fakeSet();
    const lights = Array.from({ length: MAX_AREA_LIGHTS }, () => casting());
    set.prepare(lights, 8);
    runFrame(set, lights, 2, 7);
    const liveFaces = built
      .filter((map) => map.layer % 2 === 1)
      .reduce((total, map) => total + map.bakes.reduce((sum, [, , faces]) => sum + faces, 0), 0);
    expect(liveFaces).toBe(7);
  });

  it('never asks for more faces than a map has', () => {
    /* A budget larger than the cube is a request for faces that do not exist. */
    const { set, built } = fakeSet();
    const lights = [casting()];
    set.prepare(lights, 8);
    runFrame(set, lights, 40, 40);
    for (const map of built) {
      for (const [, , faces] of map.bakes) expect(faces).toBeLessThanOrEqual(FACE_COUNT);
    }
  });

  it('advances the arrival ramp before it bakes, so a fresh image starts at nothing', () => {
    const { set, built } = fakeSet();
    const lights = [casting()];
    set.prepare(lights, 8);
    runFrame(set, lights);
    expect(built[0]?.advanced).toBeCloseTo(1 / 60, 6);
  });

  it('leaves a rectangle that does not cast entirely alone', () => {
    const { set, built } = fakeSet();
    set.prepare([PANEL], 8);
    runFrame(set, [PANEL]);
    expect(built).toEqual([]);
  });
});

describe('what the shader is told', () => {
  it('publishes -1 until an image exists, so nothing fetches an unwritten layer', () => {
    const { set } = fakeSet();
    const out = createResolvedAreaShadows();
    const lights = [casting()];
    set.prepare(lights, 8);
    set.resolve(lights, out);
    expect(out.layer[0]).toBe(-1);
    expect(out.liveLayer[0]).toBe(-1);
    expect(out.weight[0]).toBe(0);
  });

  it('publishes the layer, the planes and the presence once one does', () => {
    const { set } = fakeSet();
    const out = createResolvedAreaShadows();
    const lights = [casting()];
    set.prepare(lights, 8);
    runFrame(set, lights);
    set.resolve(lights, out);
    expect(out.layer[0]).toBe(8);
    expect(out.liveLayer[0]).toBe(9);
    expect(out.far[0]).toBe(12);
    expect(out.near[0]).toBe(POINT_SHADOW_NEAR);
    expect(out.weight[0]).toBe(1);
  });

  it('publishes what the map was baked with, not what the light now says', () => {
    /*
     * `PointShadowImage.planBake` exists for this: a bake in flight owns the parameters it started
     * with. Publishing the declaration would pair a new far plane with old pixels, which is a
     * shadow at the wrong distance rather than an error.
     */
    const { set } = fakeSet();
    const out = createResolvedAreaShadows();
    const lights = [casting({ shadowRange: 12 })];
    set.prepare(lights, 8);
    runFrame(set, lights);
    const moved = [casting({ shadowRange: 40 })];
    set.resolve(moved, out);
    expect(out.far[0]).toBe(12);
  });

  it('is indexed by the slot the lit pass shades, not by which rectangles cast', () => {
    /*
     * `selectAreaLights` fills the shader arrays from the caller's list in order, so slot 1 is
     * `lights[1]` whether or not slot 0 casts. A resolved set compacted by casting order would put
     * the second rectangle's shadow under the first.
     */
    const { set } = fakeSet();
    const out = createResolvedAreaShadows();
    const lights = [PANEL, casting()];
    set.prepare(lights, 8);
    runFrame(set, lights);
    set.resolve(lights, out);
    expect(out.layer[0]).toBe(-1);
    expect(out.layer[1]).toBe(8);
  });

  it('clears a slot whose image was thrown away', () => {
    const { set } = fakeSet();
    const out = createResolvedAreaShadows();
    const lights = [casting()];
    set.prepare(lights, 8);
    runFrame(set, lights);
    set.forgetEveryImage();
    set.resolve(lights, out);
    expect(out.layer[0]).toBe(-1);
  });
});
