import { LIVE_POINT_SHADOW_MAPS, MAX_POINT_LIGHTS, POINT_SHADOW_POOL } from './lightBudget.ts';
import { LivePointShadowSet } from './livePointShadowSet.ts';
import type { PointShadowSource, ResolvedPointShadows } from './pointShadowImage.ts';

/**
 * A pool of point-light shadow maps and the fixed set the shader samples.
 *
 * World lights do not own maps. They borrow one from a pool of
 * `POINT_SHADOW_POOL`, handed out to whichever lights the shading pass chose and
 * reclaimed from whichever was sampled least recently. Live maps contain moving
 * casters only, so they compose with the borrowed maps rather than overwriting
 * them. Normally one is active; both are used briefly while ownership crossfades
 * to another light.
 *
 * **It used to be one permanent map per light**, which read as the generous
 * choice and was the renderer's worst bug: a world with 50 lights allocated
 * roughly 327 MB of cubemaps so that eight of them could be read. See
 * `POINT_SHADOW_POOL` for what that did to integrated GPUs. Borrowing costs a
 * six-face bake when a light enters the sampled set after being away, and buys
 * back memory that scales with the light *budget* rather than with how many lamps
 * the day's world happened to generate.
 *
 * Nothing is lost visually, and that is the point rather than a hope: a light
 * outside the sampled set has no `samplerCube` bound to it and could not be read
 * however long its map was kept.
 *
 * Selection is adopted from the shading pass verbatim. If lighting and shadow
 * code choose independently, a small camera movement can reorder the two sets
 * and make a lamp's static shadow switch off while its illumination remains.
 */
export interface ShadowLight {
  x: number;
  y: number;
  z: number;
  /** Distance at which the light falls to zero; the map's far plane. */
  radius: number;
  /** Where casting begins. Keep small — it clips every caster, not just fixtures. */
  shadowNear: number;
  /** Physical emitter radius in metres; it controls penumbra width. */
  sourceRadius: number;
  /**
   * Whether this light is worth a cubemap at all. Defaults to true.
   *
   * The same flag `PointLightSource` carries, declared here because the renderer checks
   * it against the *shaded* set before handing out a pool slot. It used to be read only
   * while building the eligible list, so a light that declined to cast still got a map
   * whenever it was one of the lights being shaded — which is every light near the
   * camera, and so every light whose bake anybody would notice.
   */
  castsShadow?: boolean;
}

/**
 * The shader's own name for the point-shadow array.
 *
 * Exported because *both* backends address it: WebGL2 looks it up in its uniform table and
 * WebGPU looks it up in the generated binding table. One name, so the two cannot bind different
 * things.
 *
 * **It was twelve names, one per cubemap sampler**, because GLSL ES cannot index a sampler
 * array with a non-constant expression and the shader therefore declared each map separately.
 * One array texture with a layer per light needs one.
 */
export const POINT_SHADOW_SAMPLER = 'uPointShadows';

export class PointShadowSystem<M extends PointShadowSource> {
  /** The pool. Indexed by pool slot, never by world light. */
  private readonly maps: M[] = [];
  private readonly live: LivePointShadowSet<M>;
  private staticLightCount = 0;

  /** Which world light currently holds each pool slot, or -1 while free. */
  private readonly slotOwner = new Int32Array(POINT_SHADOW_POOL).fill(-1);
  /** The lights held ready but not shaded, so joining the sampled set costs no bake. */
  private readonly warm = new Int32Array(POINT_SHADOW_POOL);
  private warmCount = 0;

  /** Frame stamp of the last time each slot was wanted, for the eviction choice. */
  private readonly slotUsed = new Float64Array(POINT_SHADOW_POOL);
  /** Reverse of `slotOwner`: pool slot per world light, or -1 while unassigned. */
  private lightSlot = new Int32Array(0);
  private useStamp = 0;

  private readonly chosen = new Int32Array(MAX_POINT_LIGHTS);
  /** Shader light slot each chosen world map belongs to. */
  private readonly slots = new Int32Array(MAX_POINT_LIGHTS);
  private chosenCount = 0;

  /** Batched array uniforms; WebGL exposes each array at its `[0]` location. */
  private readonly far = new Float32Array(MAX_POINT_LIGHTS);
  private readonly near = new Float32Array(MAX_POINT_LIGHTS);
  private readonly sourceRadius = new Float32Array(MAX_POINT_LIGHTS);
  /** How present each bound map is, so a re-baked one arrives rather than appears. */
  private readonly presence = new Float32Array(MAX_POINT_LIGHTS);

  /**
   * `createMap` rather than a context and a size, so the pool never names a device.
   *
   * The whole of this class is pooling, staleness and selection — decisions a second backend
   * must make identically or its shadows change hands at different moments. Taking a factory is
   * what lets both share it; see `PointShadowSource`.
   */
  constructor(
    private readonly createMap: (layer: number) => M,
    private readonly releaseMap: (map: M) => void,
  ) {
    this.live = new LivePointShadowSet(createMap, releaseMap);
  }

  /**
   * Size the pool and forget every assignment. Called once the light count is known.
   *
   * The pool is capped at `POINT_SHADOW_POOL` however many lights the caller has,
   * and at the light count when that is smaller — a world with three lamps has no
   * use for twelve cubemaps.
   */
  prepareStaticMaps(lightCount: number): void {
    const wanted = Math.min(lightCount, POINT_SHADOW_POOL);
    while (this.maps.length < wanted) {
      /* Pool slot i takes layer LIVE + i; the live maps hold 0 and 1. See PointShadowArray. */
      this.maps.push(this.createMap(LIVE_POINT_SHADOW_MAPS + this.maps.length));
    }
    if (this.lightSlot.length < lightCount) this.lightSlot = new Int32Array(lightCount);
    this.lightSlot.fill(-1);
    this.slotOwner.fill(-1);
    this.slotUsed.fill(0);
    this.staticLightCount = lightCount;
  }

  /**
   * The map a light is currently borrowing, if any.
   *
   * A pure lookup: assignment happens once a frame in `sync`, because handing out
   * slots from here would let a caller iterating lights evict the map it is about
   * to read.
   */
  mapForLight(lightIndex: number): M | undefined {
    if (lightIndex < 0 || lightIndex >= this.staticLightCount) return undefined;
    const slot = this.lightSlot[lightIndex] ?? -1;
    return slot < 0 ? undefined : this.maps[slot];
  }

  /** Adopt the shading pass's world-light list, including its exact order. */
  sync(
    activeWorldIndices: Int32Array,
    activeCount: number,
    warmWorldIndices?: Int32Array,
    warmCount = 0,
  ): void {
    this.chosenCount = 0;
    const limit = Math.min(activeCount, MAX_POINT_LIGHTS);
    for (let shaderSlot = 0; shaderSlot < limit; shaderSlot++) {
      const worldIndex = activeWorldIndices[shaderSlot] ?? -1;
      if (worldIndex < 0 || worldIndex >= this.staticLightCount) continue;
      this.chosen[this.chosenCount] = worldIndex;
      this.slots[this.chosenCount] = shaderSlot;
      this.chosenCount++;
    }

    /*
     * The lights about to be wanted, given slots and baked before they are.
     *
     * Every light owned a permanent map before the pool, so joining the sampled set
     * meant its shadow was already correct. Borrowing broke that: joining meant
     * evicting somebody and baking six faces at two a frame, which is the on/off as a
     * lamp comes into range. The pool has always carried four slots more than the
     * shader can bind, and until now they only absorbed churn — these are the lights
     * they were for.
     *
     * Warm lights hold a slot and take bake budget. They are never bound: `sampledCount`
     * still counts only what the shader reads.
     */
    this.warmCount = 0;
    if (warmWorldIndices !== undefined) {
      const warmLimit = Math.min(warmCount, this.maps.length);
      for (let i = 0; i < warmLimit; i++) {
        const worldIndex = warmWorldIndices[i] ?? -1;
        if (worldIndex < 0 || worldIndex >= this.staticLightCount) continue;
        /*
         * Already being shaded, so it is not warming for anything: it holds its slot
         * from the loop above and it is baked across `pooledCount` either way.
         *
         * Without this the two lists overlap almost entirely — the shadow list is the
         * lights inside their own radius, and a light that close is nearly always in
         * the shaded set already — so `pooledCount` counted the same lights twice, and
         * `bakeStale` being pool-length meant the genuinely extra ones fell off the
         * end. The spare slots the pool carries for exactly this never held anything.
         */
        let shaded = false;
        for (let k = 0; k < this.chosenCount; k++) {
          if (this.chosen[k] === worldIndex) {
            shaded = true;
            break;
          }
        }
        if (shaded) continue;
        this.warm[this.warmCount] = worldIndex;
        this.warmCount++;
      }
    }

    this.assignSlots();
  }

  /**
   * Give every chosen light a pool slot, evicting the least recently wanted.
   *
   * One stamp for the whole call, so every light chosen this frame is equally
   * recent and `claimSlot` can refuse to evict any of them.
   */
  private assignSlots(): void {
    this.useStamp++;
    // Sampled first, so a warm light can never take a slot from one being shaded.
    for (let k = 0; k < this.chosenCount; k++) this.give(this.chosen[k] ?? -1);
    for (let k = 0; k < this.warmCount; k++) this.give(this.warm[k] ?? -1);
  }

  private give(light: number): void {
    if (light < 0) return;
    const existing = this.lightSlot[light] ?? -1;
    const slot = existing >= 0 ? existing : this.claimSlot(light);
    if (slot >= 0) this.slotUsed[slot] = this.useStamp;
  }

  /**
   * Take a free slot, or the one wanted longest ago.
   *
   * Slots already stamped with this frame belong to lights the shader is about to
   * read, so they are never candidates. The pool has more slots than
   * `MAX_POINT_LIGHTS`, so a candidate always exists.
   */
  private claimSlot(light: number): number {
    let best = -1;
    let bestStamp = Infinity;
    for (let slot = 0; slot < this.maps.length; slot++) {
      if ((this.slotUsed[slot] ?? 0) === this.useStamp) continue;
      if ((this.slotOwner[slot] ?? -1) < 0) {
        best = slot;
        break;
      }
      const stamp = this.slotUsed[slot] ?? 0;
      if (stamp < bestStamp) {
        bestStamp = stamp;
        best = slot;
      }
    }
    if (best < 0) return -1;
    const previous = this.slotOwner[best] ?? -1;
    if (previous >= 0) {
      this.lightSlot[previous] = -1;
      // The image belongs to the light losing the slot, not to the one taking it.
      // Left in place it is sampled as the new light's shadow until a re-bake lands.
      this.maps[best]?.forget();
    }
    this.slotOwner[best] = light;
    this.lightSlot[light] = best;
    return best;
  }

  /** Ramp every pooled image toward full presence. See `PointShadowMap.advance`. */
  /**
   * Ramp every image toward full presence: the pool's, **and the live pair's**.
   *
   * The second half was missing, and it is the whole of why a moving caster was never shadowed by
   * a point light. `this.maps` is the pool; the live pair belongs to `LivePointShadowSet`, which
   * publishes `crossfade weight * presence` and therefore published zero for ever. Every other
   * part of that path reports itself healthy, which is what made it survive.
   */
  advance(dt: number): void {
    for (const map of this.maps) map.advance(dt);
    this.live.advance(dt);
  }

  get sampledCount(): number {
    return this.chosenCount;
  }

  /** How many lights hold a slot this frame: the shaded ones plus the warming ones. */
  get pooledCount(): number {
    return this.chosenCount + this.warmCount;
  }

  /**
   * A light holding a slot, shaded ones first.
   *
   * The renderer bakes across this rather than across `sampledCount`, which is the
   * whole point: a warm light's map is baked *before* it is bound, so being chosen
   * for shading never costs six face passes.
   */
  pooledLight(index: number): number {
    if (index < this.chosenCount) return this.chosen[index] ?? -1;
    return this.warm[index - this.chosenCount] ?? -1;
  }

  sampledLight(slot: number): number {
    return slot >= 0 && slot < this.chosenCount ? (this.chosen[slot] ?? -1) : -1;
  }

  /**
   * Select the live shadow around a moving caster and advance any ownership
   * crossfade. The position is caller-provided and has no gameplay meaning to
   * the engine.
   */
  updateLiveSelection(
    lights: readonly ShadowLight[],
    x: number,
    y: number,
    z: number,
    frameDt: number,
  ): void {
    this.live.update(lights, this.chosen, this.chosenCount, x, y, z, frameDt);
  }

  get liveMapCount(): number {
    return LIVE_POINT_SHADOW_MAPS;
  }

  liveOwner(slot: number): number {
    return this.live.owner(slot, this.chosen, this.chosenCount);
  }

  liveMap(slot: number): M | undefined {
    return this.live.map(slot);
  }

  /**
   * Bind every selected map and upload its metadata as whole arrays.
   *
   * WebGL reports an active uniform array only as `name[0]`. Looking up
   * `name[1]` in the cached uniform table therefore returns nothing; uploading
   * each element that way left slots 1–7 at zero and made their shadows vanish.
   */
  /**
   * Settle every shader slot's map choice and parameters into the caller's arrays.
   *
   * **The arrays are the decision and the cubemaps are the binding.** Which light samples which
   * slot, whether its image has landed and how present it is are answers this pool computes;
   * turning them into `uniform1fv` or into bytes of a uniform block is all that differs between
   * backends. A caller walks `mapForShaderSlot` for the textures.
   */
  resolve(out: ResolvedPointShadows): void {
    out.layers.fill(-1);
    out.far.fill(1);
    out.near.fill(0.01);
    out.sourceRadius.fill(0);
    out.presence.fill(0);

    for (let k = 0; k < MAX_POINT_LIGHTS; k++) {
      const map = this.mapForShaderSlot(k);
      /*
       * A map with no image yet contributes nothing, exactly as an unassigned one does.
       *
       * Bakes are spread over frames rather than all done the moment they are noticed (see
       * `pointShadowBudget.ts`), so a light can be selected a frame or two before its cubemap
       * exists. Sampling it then would read whatever the pool slot held previously — another
       * lamp's shadow, from somewhere else entirely — which is far worse than the light simply
       * not casting for two frames. The index stays −1, which is the path the shader already
       * takes for a light with no map at all.
       */
      if (map === undefined || !map.hasBaked) continue;
      /*
       * `slots[k]` is the shading pass's own index for this light, which is the `i` the shader
       * loops over — so it is the index everything about this map is written under. The chosen
       * order and the shading order are not the same order, and writing under `k` here would
       * hand light 2 the parameters of light 0 in any scene where they differ.
       */
      const light = this.slots[k] ?? -1;
      if (light < 0 || light >= out.layers.length) continue;
      out.far[light] = map.far;
      out.near[light] = map.near;
      out.sourceRadius[light] = map.sourceRadius;
      out.presence[light] = map.presence;
      out.layers[light] = map.layer;
    }

    this.live.resolve(this.chosen, this.slots, this.chosenCount, out);
  }

  /**
   * The map a shader slot samples, or undefined.
   *
   * Separate from `resolve` because a backend needs it for the *texture* while the arrays are
   * already settled, and because a slot with no map still has to be filled with something —
   * see `emptyTexture.ts` on one side and the one-texel cube on the other.
   */
  mapForShaderSlot(slot: number): M | undefined {
    const lightIndex = slot < this.chosenCount ? (this.chosen[slot] ?? -1) : -1;
    return this.mapForLight(lightIndex);
  }

  /**
   * Throw away every baked image, keeping the maps and their layers.
   *
   * For a backend that had to rebuild the storage under them — the array is immutable once
   * allocated, so growing it for a bigger world replaces the pixels with nothing. A map that
   * still reported `hasBaked` afterwards would be sampled, and what it would read is whatever
   * the new allocation happens to contain.
   */
  forgetEveryImage(): void {
    for (const map of this.maps) map.forget();
    this.live.forgetEveryImage();
  }

  dispose(): void {
    for (const map of this.maps) this.releaseMap(map);
    this.live.dispose();
  }
}
