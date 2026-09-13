import { LIVE_POINT_SHADOW_MAPS } from './lightBudget.ts';
import type { PointShadowSource, ResolvedPointShadows } from './pointShadowImage.ts';

/**
 * Two live-caster cubemaps with a continuous handoff between owning lights.
 *
 * The steady state uses one map. The second is activated only while a nearer
 * light takes ownership, allowing the old shadow to fade out as the new one
 * fades in instead of switching a moving caster in one frame.
 *
 * **Generic over the map, because none of the handoff is about a device.** Which light owns
 * which slot, how long a crossfade has run and what weight each carries are the same answers
 * whichever API holds the cubemaps, and a second copy of them is a shadow that changes hands
 * differently depending on which backend drew it.
 */

/** A quick handoff reads as motion, not as a light switching off. */
const TRANSITION_SECONDS = 0.18;
/** A challenger must be 10% nearer before ownership changes. */
const DISPLACE_RATIO = 0.81;

interface PositionedLight {
  x: number;
  y: number;
  z: number;
}

export class LivePointShadowSet<M extends PointShadowSource> {
  private readonly maps: M[] = [];
  private readonly owners = new Int32Array(LIVE_POINT_SHADOW_MAPS).fill(-1);
  private readonly weights = new Float32Array(LIVE_POINT_SHADOW_MAPS);

  private primarySlot = 0;
  private transitionFromSlot = -1;
  private transitionToSlot = -1;
  private transitionSeconds = 0;

  /**
   * `createMap` rather than a context and a size, so the pool never names a device.
   * `releaseMap` for the same reason: freeing one is the backend's business.
   */
  constructor(
    createMap: (layer: number) => M,
    private readonly releaseMap: (map: M) => void,
  ) {
    /*
     * The live maps take the array's **first** layers, and that is why they can be built here.
     *
     * They are created when the renderer is, before any world has said how many lights it has, so
     * a layer counted from the end of the array would not yet have a number. Counted from the
     * front they do: 0 and 1, always, with pool slot i at LIVE_POINT_SHADOW_MAPS + i.
     */
    for (let i = 0; i < LIVE_POINT_SHADOW_MAPS; i++) this.maps.push(createMap(i));
  }

  update(
    lights: readonly PositionedLight[],
    sampled: Int32Array,
    sampledCount: number,
    x: number,
    y: number,
    z: number,
    frameDt: number,
  ): void {
    if (this.transitionFromSlot >= 0) {
      const fromOwner = this.owners[this.transitionFromSlot] ?? -1;
      const toOwner = this.owners[this.transitionToSlot] ?? -1;
      if (!isSampled(toOwner, sampled, sampledCount)) {
        this.owners[this.transitionToSlot] = -1;
        this.weights[this.transitionToSlot] = 0;
        this.weights[this.transitionFromSlot] = 1;
        this.clearTransition();
      } else if (!isSampled(fromOwner, sampled, sampledCount)) {
        this.finishTransition();
      } else {
        this.transitionSeconds += frameDt;
        const t = Math.min(this.transitionSeconds / TRANSITION_SECONDS, 1);
        this.weights[this.transitionFromSlot] = 1 - t;
        this.weights[this.transitionToSlot] = t;
        if (t >= 1) this.finishTransition();
      }
      if (this.transitionFromSlot >= 0) return;
    }

    let nearest = -1;
    let nearestDistance = Infinity;
    for (let slot = 0; slot < sampledCount; slot++) {
      const worldIndex = sampled[slot] ?? -1;
      const light = worldIndex >= 0 ? lights[worldIndex] : undefined;
      if (light === undefined) continue;
      const dx = light.x - x;
      const dy = light.y - y;
      const dz = light.z - z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < nearestDistance) {
        nearest = worldIndex;
        nearestDistance = distance;
      }
    }

    if (nearest < 0) {
      this.owners.fill(-1);
      this.weights.fill(0);
      this.clearTransition();
      return;
    }

    const current = this.owners[this.primarySlot] ?? -1;
    if (current < 0 || !isSampled(current, sampled, sampledCount)) {
      this.owners.fill(-1);
      this.weights.fill(0);
      this.owners[this.primarySlot] = nearest;
      this.weights[this.primarySlot] = 1;
      /* The image in that map was baked around whichever light held the slot before, so it is
         another lamp's shadow standing under this one until a bake replaces it. See `take`. */
      this.take(this.primarySlot, current);
      this.clearTransition();
      return;
    }

    if (nearest === current) return;
    const currentLight = lights[current];
    if (currentLight !== undefined) {
      const dx = currentLight.x - x;
      const dy = currentLight.y - y;
      const dz = currentLight.z - z;
      const currentDistance = dx * dx + dy * dy + dz * dz;
      if (nearestDistance >= currentDistance * DISPLACE_RATIO) return;
    }

    const nextSlot = 1 - this.primarySlot;
    const displaced = this.owners[nextSlot] ?? -1;
    this.owners[nextSlot] = nearest;
    this.weights[nextSlot] = 0;
    this.take(nextSlot, displaced);
    this.transitionFromSlot = this.primarySlot;
    this.transitionToSlot = nextSlot;
    this.transitionSeconds = 0;
  }

  /**
   * A slot changing hands throws its image away, exactly as a pool slot does.
   *
   * **`PointShadowSystem` does this and this class did not**, and the asymmetry is what let a
   * lamp cast a shadow with nothing making it. A live map holds only movers, baked around the
   * light that owned the slot — so a slot handed to a different lamp keeps `hasBaked` true and
   * publishes an image of a mover standing where it stood *near the other light*, at whatever
   * weight the handover gave it. That map's own pool comment states the rule for the static
   * half: sampling a slot before its new owner's bake lands reads "another lamp's shadow, from
   * somewhere else entirely". It is the same rule here and it was not applied.
   *
   * A no-op when the slot was free or is being handed back to the same light, so a steady state
   * does not throw away a good image every frame.
   */
  private take(slot: number, previousOwner: number): void {
    if (previousOwner < 0 || previousOwner === this.owners[slot]) return;
    this.maps[slot]?.forget();
  }

  owner(slot: number, sampled: Int32Array, sampledCount: number): number {
    const owner = this.owners[slot] ?? -1;
    return isSampled(owner, sampled, sampledCount) ? owner : -1;
  }

  map(slot: number): M | undefined {
    return this.maps[slot];
  }

  /**
   * Settle the live pair's shader slots and parameters into the caller's arrays.
   *
   * The maps themselves stay here and are handed out by `map`, because binding a cubemap is
   * the one part of this that differs between backends — see `ResolvedPointShadows`.
   */
  resolve(
    sampled: Int32Array,
    shaderSlots: Int32Array,
    sampledCount: number,
    out: ResolvedPointShadows,
  ): void {
    out.liveLayers.fill(-1);
    out.liveFar.fill(1);
    out.liveNear.fill(0.01);
    out.liveSourceRadius.fill(0);
    /*
     * Zero, then written under the owning light below. The weights used to be a straight copy of
     * this set's own two, because the arrays were addressed by live slot; they are addressed by
     * light now, so a copy would put live slot 1's weight on light 1 — a light that has no live
     * map at all in most frames.
     */
    out.liveWeights.fill(0);

    for (let liveSlot = 0; liveSlot < LIVE_POINT_SHADOW_MAPS; liveSlot++) {
      const map = this.maps[liveSlot];
      const owner = this.owners[liveSlot] ?? -1;
      let shaderSlot = -1;
      for (let sampledSlot = 0; sampledSlot < sampledCount; sampledSlot++) {
        if (sampled[sampledSlot] === owner) {
          shaderSlot = shaderSlots[sampledSlot] ?? -1;
          break;
        }
      }
      if (map === undefined || shaderSlot < 0 || shaderSlot >= out.liveLayers.length) continue;
      /*
       * **A map with no image yet contributes nothing**, which is the guard the static pool
       * carries in `PointShadowSystem.resolve` and this half was missing. A bake is spread over
       * frames against a budget, so a live map can be selected before it holds anything — and
       * what a layer holds before its first bake is a zero depth, which the shader reads as an
       * occluder pressed against the lamp. The index stays −1, the path the shader already takes
       * for a light with no map at all.
       */
      if (!map.hasBaked) continue;
      out.liveLayers[shaderSlot] = map.layer;
      out.liveFar[shaderSlot] = map.far;
      out.liveNear[shaderSlot] = map.near;
      out.liveSourceRadius[shaderSlot] = map.sourceRadius;
      /*
       * The handover weight *and* the image's own arrival, multiplied.
       *
       * They answer different questions and both have to be asked: the weight is how far this
       * slot is through a crossfade, and the presence is how long its image has existed. A
       * freshly forgotten map that has just re-baked is at full crossfade weight and no
       * presence, so without the second factor a whole mover's shadow switches on in one frame
       * under a lamp that never moved — which is the pop `advance` exists to remove.
       */
      out.liveWeights[shaderSlot] = (this.weights[liveSlot] ?? 0) * map.presence;
    }
  }

  /**
   * Ramp both live images toward full presence.
   *
   * **This did not exist, and its absence meant a moving caster was never shadowed by a point
   * light at all.** `resolve` publishes `crossfade weight * presence`, and presence is the map's
   * own arrival ramp — which only moves when something advances it. `PointShadowSystem.advance`
   * walks *its* pool, and these two are not in it, so the ramp stayed at zero for every frame this
   * engine has ever rendered. The shader multiplied a correct occlusion by a weight of zero.
   *
   * Nothing about it was visible from either side. The layer is baked, the layer index and far
   * plane are published, `hasBaked` is true and the crossfade weight is 1 — every part reports
   * itself healthy, and the product of them is nothing. It was found by reading the resolved
   * weights off a live renderer rather than by reading this file, and the octahedral layer had the
   * caster in it the whole time.
   *
   * The pair is advanced whether or not either is owned: an unowned slot has no image, `advance`
   * on it is the branch that holds the ramp at zero, and skipping it here would be a second place
   * that has to know which slots are live.
   */
  advance(dt: number): void {
    for (const map of this.maps) map.advance(dt);
  }

  /** See `PointShadowSystem.forgetEveryImage`: the storage under these maps was replaced. */
  forgetEveryImage(): void {
    for (const map of this.maps) map.forget();
  }

  dispose(): void {
    for (const map of this.maps) this.releaseMap(map);
  }

  private finishTransition(): void {
    const fromSlot = this.transitionFromSlot;
    const toSlot = this.transitionToSlot;
    if (fromSlot < 0 || toSlot < 0) return;
    this.owners[fromSlot] = -1;
    this.weights[fromSlot] = 0;
    this.weights[toSlot] = 1;
    this.primarySlot = toSlot;
    this.clearTransition();
  }

  private clearTransition(): void {
    this.transitionFromSlot = -1;
    this.transitionToSlot = -1;
    this.transitionSeconds = 0;
  }
}

function isSampled(worldIndex: number, sampled: Int32Array, sampledCount: number): boolean {
  for (let slot = 0; slot < sampledCount; slot++) {
    if (sampled[slot] === worldIndex) return true;
  }
  return false;
}
