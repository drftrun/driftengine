/**
 * Which point-shadow maps get to bake this frame, and in what order.
 *
 * Baking is six full passes over the static world per light, and the renderer used to
 * do every stale one in the frame it noticed. That is fine in the steady state, where
 * nothing is stale, and catastrophic on the frame it stops being true: walking into a
 * courtyard makes eight lights stale at once, which is 48 passes in one frame. Measured on
 * a fast machine at boot, that was two consecutive frames of 89 ms and 99 ms against an
 * 8.3 ms budget — the hitch about a second after a page load, and a smaller one each
 * time a new cluster of lamps comes into range.
 *
 * Spreading the same work over more frames costs nothing anybody can see. Eight lights
 * at two faces a frame is 24 frames, a fifth of a second at 120 Hz, during which
 * shadows resolve progressively instead of the whole game stopping.
 *
 * This module only decides the *order*. The renderer spends a face budget walking it,
 * because lights need different numbers of faces depending on how far through a bake
 * they already are.
 */

/**
 * Order the stale maps so the ones with nothing to show go first.
 *
 * A light whose map has never been baked contributes no shadow at all until it has one
 * (see `PointShadowSystem.bind`), so every frame it waits is a frame with a visibly
 * unlit lamp. A light that has merely drifted past the rebake tolerance is still
 * sampling a perfectly reasonable map from a few centimetres away, and can wait.
 * Serving the second kind first would hold a missing shadow hostage to a nearly
 * invisible correction.
 *
 * Within each group the caller's order is preserved, which is the shading pass's own
 * light order and therefore already sorted by how much each light matters.
 *
 * Writes into `out` and returns how many entries it wrote; allocation-free because this
 * runs every frame.
 */
export function planPointShadowBakes(
  /** 1 where the map at that slot needs baking. */
  stale: Uint8Array,
  /** 1 where the map at that slot already holds a usable image. */
  ready: Uint8Array,
  count: number,
  out: Int32Array,
  /**
   * 1 where this slot's map has gone stale on every recent frame.
   *
   * Optional: a caller that omits it gets the two-group order this had before.
   */
  chronic?: Uint8Array,
): number {
  let written = 0;
  // Never baked: nothing to sample until this lands.
  for (let slot = 0; slot < count && written < out.length; slot++) {
    if (stale[slot] === 1 && ready[slot] !== 1) out[written++] = slot;
  }
  // Baked but drifted: correcting an image that is already close to right.
  for (let slot = 0; slot < count && written < out.length; slot++) {
    if (stale[slot] === 1 && ready[slot] === 1 && chronic?.[slot] !== 1) out[written++] = slot;
  }
  /*
   * Last: the maps that will be stale again next frame whatever is done for them.
   *
   * A light that moves, or breathes its radius, invalidates its own map every frame — so
   * a bake buys it one frame and is owed again immediately. Ordered by the caller's
   * importance alone, which is all the drifted group above uses, such a light sits
   * permanently ahead of a static one that drifted once and would then stay correct for
   * an hour; it takes the spread budget forever and the static one never gets its
   * correction. Importance is the right tie-break between two maps that will *keep* what
   * they are given, and the wrong one when only one of them will.
   *
   * They are still served, and served in full when budget is left over, so a light that
   * settles catches up on the next frame. They simply cannot hold a settling light
   * hostage any more.
   *
   * This is the scheduling half of the problem only. Whether a light is *worth* a cubemap
   * at all — a floor-level marker, a lamp riding a camera, a creature standing inside
   * its own glow — is a question about the content, and `castsShadow` is where a consumer
   * answers it. No ordering can.
   */
  if (chronic !== undefined) {
    for (let slot = 0; slot < count && written < out.length; slot++) {
      if (stale[slot] === 1 && ready[slot] === 1 && chronic[slot] === 1) out[written++] = slot;
    }
  }
  return written;
}

/**
 * The shaded lights that also cast, in the order they were shaded.
 *
 * `castsShadow: false` says a light is not worth a cubemap. `selectPointLights` honours
 * that when it builds the *eligible* list, and that was taken for the whole promise — but
 * the shaded set is a different list, a caller hands it to `updatePointShadows` as the set
 * to bind, and a light in it was given a pool slot and baked whatever it had declared. So
 * the flag held for a lamp out of range and quietly failed for the one in front of you,
 * which is the only one whose bake is visible.
 *
 * It showed up as a shadow with nothing to throw it — a lamp that rides the camera
 * declines to cast for exactly that reason, and cast anyway.
 *
 * Writes into `out` and returns how many it wrote; allocation-free, because this runs
 * every frame.
 */
export function selectCastingLights(
  lights: readonly { castsShadow?: boolean }[],
  activeWorldIndices: Int32Array,
  activeCount: number,
  out: Int32Array,
): number {
  let written = 0;
  for (let i = 0; i < activeCount && written < out.length; i++) {
    const worldIndex = activeWorldIndices[i] ?? -1;
    if (worldIndex < 0) continue;
    if (lights[worldIndex]?.castsShadow === false) continue;
    out[written++] = worldIndex;
  }
  return written;
}

/**
 * How many consecutive frames a slot must be stale before it is treated as chronically so.
 *
 * A light that drifts past the rebake tolerance every frame — a wandering flame — would
 * otherwise take a bake every frame and starve everything else. Three frames is long enough
 * that a genuine move still rebakes promptly and short enough that a chronic one is demoted
 * before it has cost much.
 */
const CHRONIC_STALE_FRAMES = 3;

/** The per-slot scratch a bake round needs. Caller-owned; this runs every frame. */
export interface BakeScratch {
  readonly stale: Uint8Array;
  readonly ready: Uint8Array;
  readonly order: Int32Array;
  readonly chronic: Uint8Array;
  readonly staleRun: Uint8Array;
  readonly staleOwner: Int32Array;
}

export function createBakeScratch(pool: number): BakeScratch {
  return {
    stale: new Uint8Array(pool),
    ready: new Uint8Array(pool),
    order: new Int32Array(pool),
    chronic: new Uint8Array(pool),
    staleRun: new Uint8Array(pool),
    staleOwner: new Int32Array(pool).fill(-1),
  };
}

/** What a pool must expose for a bake round to be planned over it. */
export interface BakeablePool<M> {
  readonly pooledCount: number;
  readonly sampledCount: number;
  readonly liveMapCount: number;
  pooledLight(slot: number): number;
  mapForLight(lightIndex: number): M | undefined;
  liveOwner(slot: number): number;
  liveMap(slot: number): M | undefined;
}

/** The one thing a bake round cannot do itself: put six faces of a world into a cubemap. */
export type BakeFaces<M, L> = (map: M, light: L, casters: unknown, maxFaces: number) => number;

/** What a map must answer for staleness to be decided. */
export interface StaleCheck {
  hasBaked: boolean;
  matchesSource(
    x: number,
    y: number,
    z: number,
    range: number,
    near: number,
    sourceRadius: number,
    tolerance: number,
  ): boolean;
}

/** The light fields a bake round reads. */
export interface BakeableLight {
  x: number;
  y: number;
  z: number;
  radius: number;
  shadowNear: number;
  sourceRadius: number;
}

/**
 * Spend a frame's face budget across the pool, then refresh the live maps.
 *
 * **Every rule in here was bought with a measured frame and none of it is about a device.**
 * Bakes are spread rather than done the instant they are noticed, because walking into a courtyard
 * makes eight lights go stale at once — 48 passes over the static world in one frame, measured
 * at 89 ms and 99 ms in two consecutive frames against an 8.3 ms budget. A slot that has never
 * baked and is being *sampled* jumps the queue with the whole six, because a light with no
 * image contributes nothing and a partial cubemap is worse than none; one such jump a frame, so
 * a cluster coming into range cannot spend the whole budget at once. A slot that is stale every
 * frame is demoted after three, because a wandering flame would otherwise starve the queue.
 *
 * A second implementation of any of that is a backend whose shadows arrive at different moments
 * — which is not something a parity capture would attribute, because both frames look plausible.
 * Hence one function, and `bake` as the only thing either backend supplies.
 */
export function runPointShadowBakes<M extends StaleCheck, L extends BakeableLight>(
  pool: BakeablePool<M>,
  lights: readonly L[],
  facesPerFrame: number,
  liveFacesPerFrame: number,
  rebakeDistance: number,
  faceCount: number,
  scratch: BakeScratch,
  staticCasters: unknown,
  dynamicCasters: unknown,
  bake: BakeFaces<M, L>,
): void {
  /*
   * Across everything holding a slot, not only what is being shaded. A warm light baked now is
   * a light that joins the sampled set without a six-face bill — which is the on/off a lamp
   * used to make as it came into range.
   */
  const count = Math.min(pool.pooledCount, scratch.stale.length);
  for (let slot = 0; slot < count; slot++) {
    const lightIndex = pool.pooledLight(slot);
    const light = lightIndex >= 0 ? lights[lightIndex] : undefined;
    const map = lightIndex >= 0 ? pool.mapForLight(lightIndex) : undefined;
    const stale =
      light !== undefined &&
      map !== undefined &&
      !map.matchesSource(
        light.x,
        light.y,
        light.z,
        light.radius,
        light.shadowNear,
        light.sourceRadius,
        rebakeDistance,
      );
    scratch.stale[slot] = stale ? 1 : 0;
    scratch.ready[slot] = map !== undefined && map.hasBaked ? 1 : 0;

    /* The run is per borrower: a slot changing hands starts its patience over. */
    if (scratch.staleOwner[slot] !== lightIndex) {
      scratch.staleOwner[slot] = lightIndex;
      scratch.staleRun[slot] = 0;
    }
    /*
     * **The run decays rather than resetting, and it climbs past the threshold before it stops.**
     *
     * A light that wanders on a curve is not stale on *every* frame — near the turning points of
     * its travel it moves less in a frame than the rebake tolerance, so a run that reset to zero
     * lost the tracking allowance there and the map dropped back to two faces a frame. The shadow
     * then travelled smoothly through the fast part of the wander and stepped through the slow
     * part, which is not motion and not stillness: it reads as a vibration. Reported that way,
     * against a brazier, once the tracking allowance was in.
     *
     * So the run is hysteresis. It climbs to twice the threshold, which buys a light that has
     * earned the allowance three quiet frames before it loses it, and decays one frame at a time
     * so a light that genuinely settles stops re-baking rather than holding a budget for ever.
     */
    const previous = scratch.staleRun[slot] ?? 0;
    const run = stale
      ? Math.min(previous + 1, CHRONIC_STALE_FRAMES * 2)
      : Math.max(previous - 1, 0);
    scratch.staleRun[slot] = run;
    scratch.chronic[slot] = run >= CHRONIC_STALE_FRAMES ? 1 : 0;
  }

  const planned = planPointShadowBakes(
    scratch.stale,
    scratch.ready,
    count,
    scratch.order,
    scratch.chronic,
  );

  let faces = facesPerFrame;
  let urgentSpent = false;
  /*
   * **One wandering light finishes its cube in the frame it started it**, the same allowance a
   * light with no image at all gets, and for a reason that turns out to be the same one: a map
   * dribbled out at two faces a frame is a map nobody can sample correctly until it lands.
   *
   * A cold light cannot be sampled *at all* until its six faces are in, so it takes the whole
   * cube at once. A chronically stale one can be sampled throughout and is wrong in a quieter
   * way: `planBake` pins the origin for the whole of a resumed bake, so six faces spread over
   * three frames means the published origin steps once every third frame. The shader shoots from
   * that origin, so the shadow it draws steps with it — reported on a brazier as motion that was
   * "really fast, not smooth, snappy, and unrealistic", which is a 20 Hz sample of a flame that
   * wanders about once a second.
   *
   * Given the cube in one frame the origin moves every frame and the shadow travels instead.
   *
   * **Bounded to one light, and it has to be.** Eight braziers each taking six passes is the 48
   * passes and 89 ms `pointShadowFacesPerFrame` exists to prevent. One is the light being shaded
   * that most recently went stale, which is the one somebody is standing next to; the rest keep
   * dribbling under the ordinary budget, and their shadows step rather than travel. That is the
   * right way round: a shadow you are looking at moves, and a shadow across the square does not
   * cost the frame.
   *
   * It is spent *after* the cold and settling groups, because `planPointShadowBakes` orders the
   * chronic ones last — so a light arriving in range still gets its first image ahead of a flame
   * refining one it already has.
   *
   * **What would make it wrong** is a caster set heavy enough that six passes over it does not
   * fit the frame. Measured against a game whose whole static world is about 8,500 triangles in
   * a handful of draws; a world an order of magnitude heavier wants `pointShadowFacesPerFrame`
   * raised or this given up, and `gpuTiming` is how to tell which.
   */
  let trackingSpent = false;
  for (let i = 0; i < planned && faces > 0; i++) {
    const slot = scratch.order[i] ?? -1;
    /*
     * `pooledLight`, matching the loop that filled `stale`: resolving through the sampled list
     * here would bake the wrong light for every warm slot.
     */
    const lightIndex = slot >= 0 ? pool.pooledLight(slot) : -1;
    const light = lightIndex >= 0 ? lights[lightIndex] : undefined;
    const map = lightIndex >= 0 ? pool.mapForLight(lightIndex) : undefined;
    if (light === undefined || map === undefined) continue;

    const sampled = slot < pool.sampledCount;
    const cold = sampled && scratch.ready[slot] === 0;
    const urgent = cold && !urgentSpent;
    /* A light being shaded whose map will be stale again next frame however it is served. */
    const tracking = !cold && sampled && scratch.chronic[slot] === 1 && !trackingSpent;
    if (urgent) urgentSpent = true;
    if (tracking) trackingSpent = true;
    faces -= bake(map, light, staticCasters, urgent || tracking ? faceCount : faces);
  }

  /*
   * Live maps contain movers only and are composed with the static maps in the shader. A second
   * map exists only during an ownership crossfade.
   *
   * **Unlike a static map there is no staleness test to make** — the caster moved, that is what
   * makes it live — **but there does have to be a ceiling, and there was not one.** This loop
   * asked for the whole cubemap, per live map, every frame, outside `facesPerFrame` entirely.
   * Measured on the consumer and on three of the engine's seven demos: `pointShadow.face`
   * six times a frame, for ever, in scenes that were otherwise nine to fourteen passes. And
   * `LIVE_POINT_SHADOW_MAPS` is two with the second waking up during an ownership handoff, which
   * is precisely what running past a row of lamps is — so a courtyard paid twelve full passes over
   * the dynamic casters a frame, which is where "it is only slow in the courtyard" came from.
   *
   * The faces round-robin under the budget instead, so a mover's shadow finishes over two or
   * three frames rather than all inside one. What that costs is a shadow a frame or two behind
   * a character. What it bought back was the frame rate to see it at all.
   */
  let liveFaces = Math.max(1, liveFacesPerFrame);
  for (let slot = 0; slot < pool.liveMapCount && liveFaces > 0; slot++) {
    const owner = pool.liveOwner(slot);
    const light = owner >= 0 ? lights[owner] : undefined;
    const map = pool.liveMap(slot);
    if (light === undefined || map === undefined) continue;
    /* Never wider than the cube itself: asking for more is asking for faces that do not exist. */
    liveFaces -= bake(map, light, dynamicCasters, Math.min(liveFaces, faceCount));
  }
}
