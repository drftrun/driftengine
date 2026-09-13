/**
 * Occlusion for a rectangular area light: which layers it holds, when they re-bake, and what the
 * shader is told about them.
 *
 * **An area light's shadow is a point light's shadow rendered from the rectangle's centre**, and
 * the whole of what makes it an *area* shadow is where the penumbra's width comes from. A point
 * light hands the filter one number, `sourceRadius`, and gets a round penumbra. A rectangle hands
 * it two half extents and the filter opens along the rectangle's own axes, so a long cable of
 * bulbs — the case this was reported for — throws one broad shadow that is soft along the cable
 * and tight across it, rather than nine overlapping hard ones that pile up where they cross.
 * That part is `areaShadow()` in `shaders/flat/pointShadow.ts`; this file is the storage and the
 * scheduling in front of it.
 *
 * **Rendering from the centre is an approximation and it is the one this technique is.** The
 * correct answer integrates visibility over the rectangle, which is many shadow maps or a ray
 * query; one map from the centre plus a filter whose width is the emitter's own extent is the
 * standard percentage-closer soft shadow, and what it gets wrong is contact: a caster touching a
 * surface has an umbra there whatever the source's size, and the widened filter still softens it
 * slightly. **What would make it visibly wrong** is a rectangle much wider than its distance to
 * the caster, where different points on the emitter see genuinely different silhouettes — a
 * ceiling-wide panel a hand's width above a table.
 *
 * **Why these layers are dedicated rather than pooled**, which is the one decision here that
 * reverses a note written before it: `POINT_SHADOW_POOL` rations layers because up to fifty lamps
 * compete for twelve, and the eviction rule is what keeps that from costing 327 MB. At most
 * `MAX_AREA_LIGHTS` rectangles exist and every one of them is shaded, so there is nothing to
 * ration — and `preamble.ts` already states the rule that matters here: a shadow budget below the
 * shading budget means some lights illuminate without occluding and *which* ones changes as the
 * camera moves, which reads as shadows switching on and off. Matching the two budgets makes that
 * impossible rather than rare. So the layers are sized from how many rectangles a world says will
 * cast, exactly as `PointShadowArray` sizes itself from the world's light count rather than from
 * the maximum.
 *
 * **What that costs, arithmetic rather than estimate:** an octahedral layer is
 * `OCTAHEDRAL_EDGE` squared at four bytes, 4.19 MB, and a casting rectangle takes two — one for
 * the static world and one for the movers. 8.39 MB each, 33.6 MB if a world declares the full
 * four, nothing at all for a world whose rectangles do not cast. The point pool at its own
 * maximum is 58.7 MB for comparison.
 *
 * **Why two layers and not one.** A single layer would have to hold the static world and the
 * movers together, so a person walking under the rectangle would re-bake six passes over the whole
 * static scene every frame — `pointShadowBudget.ts` measured that shape at 89 ms and 99 ms in two
 * consecutive frames against an 8.3 ms budget, and it is the reason point lights split the two in
 * the first place. Movers alone are a handful of meshes, so the live layer is affordable every
 * frame and the static one is baked once for a fixture that never moves.
 */
import type { AreaLightSource } from './areaLights.ts';
import { MAX_AREA_LIGHTS } from './areaLights.ts';
import { LIVE_POINT_SHADOW_MAPS, POINT_SHADOW_POOL } from './lightBudget.ts';
import { planPointShadowBakes, type BakeScratch } from './pointShadowBudget.ts';
import { DEFAULT_SOURCE_RADIUS, POINT_SHADOW_NEAR } from './pointShadowImage.ts';

/** A static layer and a live one. See the header for why it is not one. */
export const LAYERS_PER_AREA_LIGHT = 2;

/**
 * How many layers of the shared array a world's rectangles will take.
 *
 * Two per rectangle that declares it casts and names a range, and none for one that does not. A
 * rectangle past `MAX_AREA_LIGHTS` is not shaded, so it gets no layer either — a layer for a light
 * the loop never reaches is storage nothing can read.
 */
export function areaShadowLayerCount(lights: readonly AreaLightSource[]): number {
  let casting = 0;
  const count = Math.min(lights.length, MAX_AREA_LIGHTS);
  for (let slot = 0; slot < count; slot++) {
    if (castingRange(lights[slot]) > 0) casting++;
  }
  return casting * LAYERS_PER_AREA_LIGHT;
}

/**
 * Where the area layers begin, given how many point lights the world has.
 *
 * **One function rather than the same expression written in three files**, which is the mistake
 * `pointShadowImage.ts` records at `DEFAULT_SOURCE_RADIUS`: the array sizes itself, this set hands
 * out indices, and the two disagreeing by one would have every rectangle sampling a lamp's map.
 * Both call this.
 */
export function firstAreaShadowLayer(pointLightCount: number): number {
  return Math.min(pointLightCount, POINT_SHADOW_POOL) + LIVE_POINT_SHADOW_MAPS;
}

/**
 * The range a rectangle will actually cast over, or 0 for one that will not.
 *
 * **A declared `castsShadow` with no `shadowRange` counts as not casting**, because there is no
 * honest far plane to invent for it — see the field. The renderer says so once by name; this
 * function is only the predicate, and it is shared so the layer count and the map assignment
 * cannot answer it differently.
 */
export function castingRange(light: AreaLightSource | undefined): number {
  if (light === undefined) return 0;
  if (light.castsShadow !== true) return 0;
  const range = light.shadowRange;
  if (range === undefined || !Number.isFinite(range) || range <= 0) return 0;
  return range;
}

/** What the shader is told about each rectangle's occlusion, filled once a frame. */
export interface ResolvedAreaShadows {
  /** Which array layer holds this rectangle's static image, or -1 for none. */
  readonly layer: Int32Array;
  readonly far: Float32Array;
  readonly near: Float32Array;
  /** How present the image is, 0 to 1, so a fresh bake arrives rather than appears. */
  readonly weight: Float32Array;
  /** The same four for the layer holding movers only. */
  readonly liveLayer: Int32Array;
  readonly liveFar: Float32Array;
  readonly liveNear: Float32Array;
  readonly liveWeight: Float32Array;
}

export function createResolvedAreaShadows(slots: number = MAX_AREA_LIGHTS): ResolvedAreaShadows {
  return {
    layer: new Int32Array(slots).fill(-1),
    far: new Float32Array(slots).fill(1),
    near: new Float32Array(slots).fill(POINT_SHADOW_NEAR),
    weight: new Float32Array(slots),
    liveLayer: new Int32Array(slots).fill(-1),
    liveFar: new Float32Array(slots).fill(1),
    liveNear: new Float32Array(slots).fill(POINT_SHADOW_NEAR),
    liveWeight: new Float32Array(slots),
  };
}

/**
 * What a map must answer for this set to schedule and publish it.
 *
 * Structurally exactly what `PointShadowMap` and `GpuPointShadowMap` already are, which is the
 * point: an area light's map is a point light's map on a layer of the same array, so neither
 * backend needs a second class and neither can drift from the other about staleness, arrival or
 * resumption. All of that lives in `PointShadowImage`, inside both of them.
 */
export interface AreaShadowMap {
  readonly layer: number;
  readonly far: number;
  readonly near: number;
  readonly hasBaked: boolean;
  readonly presence: number;
  matchesSource(
    x: number,
    y: number,
    z: number,
    range: number,
    near: number,
    sourceRadius: number,
    tolerance: number,
  ): boolean;
  advance(dt: number): void;
  forget(): void;
}

/** The one thing this set cannot do itself: put faces of a world into a layer. */
export type BakeAreaFaces<M> = (
  map: M,
  light: AreaLightSource,
  range: number,
  near: number,
  casters: unknown,
  maxFaces: number,
) => number;

/**
 * The maps a world's casting rectangles hold, and when each of them re-bakes.
 *
 * Constructed with a factory rather than a device, for the reason `PointShadowSystem` is: every
 * decision in here is about scheduling and none of it is about a texture, so both backends share
 * this file and supply one callback each.
 */
export class AreaShadowSet<M extends AreaShadowMap> {
  /** Indexed by area-light slot. `undefined` where that slot does not cast. */
  private readonly statics: (M | undefined)[] = [];
  private readonly lives: (M | undefined)[] = [];
  /** What each slot was prepared for, so a changed declaration rebuilds rather than lies. */
  private readonly ranges = new Float32Array(MAX_AREA_LIGHTS);
  private firstLayer = -1;

  constructor(
    private readonly createMap: (layer: number) => M,
    private readonly releaseMap: (map: M) => void,
  ) {}

  /** How many slots currently hold a static map. For a renderer publishing its own state. */
  get castingCount(): number {
    let count = 0;
    for (const map of this.statics) if (map !== undefined) count++;
    return count;
  }

  /**
   * Hand out layers for the rectangles that will cast. Called when the world's lights are known.
   *
   * **Rebuilt from scratch rather than patched**, because the layer a map owns is fixed for its
   * life — `PointShadowMap.layer` is `readonly` and the shader is told an index — so a rectangle
   * that starts or stops casting moves every layer after it. That happens at load, not per frame.
   */
  prepare(lights: readonly AreaLightSource[], firstLayer: number): void {
    this.release();
    this.firstLayer = firstLayer;
    const count = Math.min(lights.length, MAX_AREA_LIGHTS);
    let next = firstLayer;
    for (let slot = 0; slot < count; slot++) {
      const range = castingRange(lights[slot]);
      this.ranges[slot] = range;
      if (range <= 0) continue;
      this.statics[slot] = this.createMap(next++);
      this.lives[slot] = this.createMap(next++);
    }
  }

  /** Throw every image away, keeping the layers. For an array that has just been rebuilt. */
  forgetEveryImage(): void {
    for (const map of this.statics) map?.forget();
    for (const map of this.lives) map?.forget();
  }

  /** Give the layers back. */
  release(): void {
    for (const map of this.statics) if (map !== undefined) this.releaseMap(map);
    for (const map of this.lives) if (map !== undefined) this.releaseMap(map);
    this.statics.length = 0;
    this.lives.length = 0;
    this.ranges.fill(0);
    this.firstLayer = -1;
  }

  /**
   * Whether the layers handed out still match what these lights declare.
   *
   * A consumer that turns a rectangle's casting on, or moves one past `MAX_AREA_LIGHTS`, has
   * changed the layout — and a set that carried on would publish a layer index belonging to
   * another rectangle, which is another fixture's shadow under this one. The renderer re-prepares
   * on a false answer, which is the same thing `prepareStaticPointShadows` does about a light
   * count that grew.
   */
  matchesDeclaration(lights: readonly AreaLightSource[]): boolean {
    if (this.firstLayer < 0) return false;
    const count = Math.min(lights.length, MAX_AREA_LIGHTS);
    for (let slot = 0; slot < MAX_AREA_LIGHTS; slot++) {
      const range = slot < count ? castingRange(lights[slot]) : 0;
      const held = this.statics[slot] !== undefined;
      if (range > 0 !== held) return false;
    }
    return true;
  }

  /**
   * Spend a frame's faces across the casting rectangles, static maps first.
   *
   * **The static half is ordered by `planPointShadowBakes`, the same function the point pool
   * uses**, so a rectangle with no image yet jumps ahead of one that has merely drifted — a map
   * that has never baked contributes no occlusion at all, and every frame it waits is a frame with
   * a rectangle visibly lighting through walls. Sharing the ordering rather than writing a second
   * one is the 2026-08-13 rule: two implementations of one decision drift, and here the drift
   * would be shadows arriving in a different order on the two backends, which no parity capture
   * would attribute because both frames look plausible.
   *
   * **The live half has no staleness test, for the reason the point pool's does not**: the caster
   * moved, which is what makes it live. It has a ceiling instead, round-robin across the
   * rectangles, so a scene with four of them spends a bounded number of faces rather than
   * twenty-four.
   */
  update(
    lights: readonly AreaLightSource[],
    dt: number,
    facesPerFrame: number,
    liveFacesPerFrame: number,
    rebakeDistance: number,
    faceCount: number,
    scratch: BakeScratch,
    staticCasters: unknown,
    dynamicCasters: unknown,
    bake: BakeAreaFaces<M>,
  ): void {
    const count = Math.min(lights.length, MAX_AREA_LIGHTS, scratch.stale.length);

    /*
     * Before the bakes, so an image completing this frame is published at no presence and ramps
     * from there. `PointShadowSystem` advances in the same order and for the same reason:
     * advancing afterwards hands a fresh image a frame's worth of weight on the frame it lands,
     * which is most of the pop on a slow frame.
     */
    for (let slot = 0; slot < count; slot++) {
      this.statics[slot]?.advance(dt);
      this.lives[slot]?.advance(dt);
    }

    for (let slot = 0; slot < count; slot++) {
      const light = lights[slot];
      const map = this.statics[slot];
      const range = castingRange(light);
      const stale =
        light !== undefined &&
        map !== undefined &&
        range > 0 &&
        !map.matchesSource(
          light.x,
          light.y,
          light.z,
          range,
          light.shadowNear ?? POINT_SHADOW_NEAR,
          /*
           * **`DEFAULT_SOURCE_RADIUS`, and it is not a rectangle's extent.** `matchesSource`
           * compares what a map was baked *with*, and the bake is a depth render from the centre —
           * the emitter's size never reaches it, being read by the filter in the shader instead.
           * Passing the extent here would make the comparison a comparison against a number the
           * bake does not use, and a rectangle whose half extents animate would then be stale
           * every frame: six passes over the static world, for ever, for a picture that cannot
           * change. `pointShadowImage.ts` records the same trap from the other side, two readers
           * of this argument disagreeing about its default.
           */
          DEFAULT_SOURCE_RADIUS,
          rebakeDistance,
        );
      scratch.stale[slot] = stale ? 1 : 0;
      scratch.ready[slot] = map !== undefined && map.hasBaked ? 1 : 0;
    }

    const planned = planPointShadowBakes(scratch.stale, scratch.ready, count, scratch.order);
    let faces = facesPerFrame;
    let urgentSpent = false;
    for (let i = 0; i < planned && faces > 0; i++) {
      const slot = scratch.order[i] ?? -1;
      const light = slot >= 0 ? lights[slot] : undefined;
      const map = slot >= 0 ? this.statics[slot] : undefined;
      if (light === undefined || map === undefined) continue;
      const range = castingRange(light);
      if (range <= 0) continue;
      /*
       * A rectangle with no image at all gets the whole map in one frame, one such jump per
       * frame — the point pool's rule, and it exists because a partial octahedral map is worse
       * than none: half the sphere holds a shadow and half holds the far plane, so the floor is
       * cut in two along a line that belongs to the projection rather than to the scene.
       */
      const cold = scratch.ready[slot] === 0;
      const budget = cold && !urgentSpent ? faceCount : faces;
      if (cold && !urgentSpent) urgentSpent = true;
      faces -= bake(
        map,
        light,
        range,
        light.shadowNear ?? POINT_SHADOW_NEAR,
        staticCasters,
        Math.min(budget, faceCount),
      );
    }

    let liveFaces = Math.max(1, liveFacesPerFrame);
    for (let slot = 0; slot < count && liveFaces > 0; slot++) {
      const light = lights[slot];
      const map = this.lives[slot];
      if (light === undefined || map === undefined) continue;
      const range = castingRange(light);
      if (range <= 0) continue;
      liveFaces -= bake(
        map,
        light,
        range,
        light.shadowNear ?? POINT_SHADOW_NEAR,
        dynamicCasters,
        Math.min(liveFaces, faceCount),
      );
    }
  }

  /**
   * Publish what the shader should read, per area-light slot.
   *
   * **The far plane and the near plane come off the map rather than off the light**, which is the
   * trap `PointShadowImage.planBake` was written for: a bake in flight owns the parameters it
   * started with, so a rectangle whose range changed mid-bake has a map holding faces rendered
   * under the old one. Publishing the declaration would pair new numbers with old pixels, and what
   * that looks like is a shadow at the wrong distance rather than an error.
   *
   * **A map with no image publishes -1** rather than a layer at zero weight. Zero weight would
   * make the fetch harmless and it would still *be* a fetch, of a layer holding whatever
   * `texStorage3D` left there.
   */
  resolve(lights: readonly AreaLightSource[], out: ResolvedAreaShadows): void {
    const slots = out.layer.length;
    const count = Math.min(lights.length, MAX_AREA_LIGHTS, slots);
    out.layer.fill(-1);
    out.liveLayer.fill(-1);
    out.weight.fill(0);
    out.liveWeight.fill(0);
    for (let slot = 0; slot < count; slot++) {
      const map = this.statics[slot];
      if (map !== undefined && map.hasBaked) {
        out.layer[slot] = map.layer;
        out.far[slot] = map.far;
        out.near[slot] = map.near;
        out.weight[slot] = map.presence;
      }
      const live = this.lives[slot];
      if (live !== undefined && live.hasBaked) {
        out.liveLayer[slot] = live.layer;
        out.liveFar[slot] = live.far;
        out.liveNear[slot] = live.near;
        out.liveWeight[slot] = live.presence;
      }
    }
  }
}
