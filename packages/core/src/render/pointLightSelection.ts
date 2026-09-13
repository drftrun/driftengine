/** Allocation-free selection and packing of point lights for a fixed shader budget. */

import { POINT_LIGHT_COS_INNER, POINT_LIGHT_COS_OUTER } from './clusteredLights.ts';
import { MAX_POINT_LIGHTS, POINT_SHADOW_POOL } from './lightBudget.ts';

export const DEFAULT_POINT_LIGHT_VIEW_RANGE = 180;

/**
 * How far out a light fades to nothing, in metres before its cull distance.
 *
 * One of the two boundaries a light can cross. The range is deliberately vast, so that
 * a light never surprises the player by switching on in front of them — and a vaster
 * range only helps if arriving at it is a ramp.
 */
const FADE_BAND_M = 40;

/**
 * How near the first excluded light has to be before the last chosen ones dim.
 *
 * The other boundary, and the one that actually flickers. A world carries more lights
 * than `MAX_POINT_LIGHTS`, so somebody is always last, and membership used to be a
 * step: the light holding the final slot contributed everything and the one behind it
 * nothing. Ordinary camera drift traded them, and both the light and its shadow
 * switched — reported, plainly, as lights that behave like on/off switches.
 *
 * Measured in a lamp-lit courtyard: six lamps and a brazier sit inside 8.7 m
 * against a budget of eight, and a gate's two lights are 12.52 m away *each*,
 * equidistant by construction. They straddle the cut, so exactly one of them was ever
 * rendered and which one flipped as the camera orbited: one post shadowed, the
 * identical one beside it bare.
 *
 * Hysteresis was tried here first and cannot fix this. A slower swap is still a swap
 * and the loser is still hard off, and worse, an incumbent's advantage puts the
 * newcomer's arrival *inside* the band rather than at its edge, so the crossfade it
 * was paired with reintroduced the pop it exists to remove. Fading against the
 * boundary subsumes it: at the tie both contenders are at nothing, so the trade is
 * free, and nothing is sticky because nothing visible is at stake.
 *
 * Three metres dims only what is genuinely contested. A row of lamps every twelve
 * metres never notices; two lights the same distance away always do. It is also long
 * enough at running pace to cover a six-face bake, so a light finishes its shadow map
 * while it is still too dim to show one.
 */
const CONTENTION_BAND_M = 3;

/** Sort keys for the shadow list, which is ordered independently of the shaded one. */
const shadowRank = new Float32Array(POINT_SHADOW_POOL);

export interface PointLightSource {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  /** Distance in metres at which illumination falls to zero. */
  radius: number;
  /** Colour modulation amplitude; zero keeps a steady source. */
  flicker: number;
  /** Shadow cubemap near plane in metres. */
  shadowNear: number;
  /** Physical emitter radius in metres, used to derive penumbra width. */
  sourceRadius: number;
  /**
   * Where a spot points, as a world-space direction. Absent makes this a point light.
   *
   * Normalised here rather than trusted, because an un-normalised direction scales the cosine the
   * cone is compared against and shows as a cone of the wrong width — which reads as the angle
   * having been set wrong rather than as the vector.
   */
  dirX?: number;
  dirY?: number;
  dirZ?: number;
  /**
   * The cone's inner and outer half-angles in degrees. Full brightness inside the inner, nothing
   * outside the outer, a smooth edge between.
   *
   * **A narrow cone is not free**, and the cost is the shadow rather than the shading. A spot's
   * shadow takes a layer of the same octahedral array a point light's does, and that layer covers
   * the whole sphere — so a 45 degree cone uses about 15% of it, roughly 0.38 of the linear
   * resolution, and a 10 degree cone about 0.13. Comfortable for a lamp; visibly coarse for a
   * stage spotlight, which is the measurement that would justify giving spots a perspective map.
   */
  coneInnerDeg?: number;
  coneOuterDeg?: number;
  /**
   * Which photometric profile shapes this light, as a row of the atlas `setIesProfiles` uploaded.
   *
   * **Applies to a point light as well as a spot.** A bare bulb has a measured distribution too,
   * and a fixture's own profile is usually a better description of it than any cone. Absent, or
   * negative, is a light with no profile.
   */
  iesProfile?: number;
  /**
   * Whether this light is worth a shadow cubemap. Defaults to true.
   *
   * A light whose `radius` is animated invalidates its own map every frame —
   * `matchesSource` compares the range, because the range *is* the cube's far plane —
   * so it is perpetually stale and takes bake budget forever. With a fixed budget of a
   * couple of faces a frame, a handful of those starve every real lamp in the world,
   * and only the one nearest light ever finishes a bake.
   *
   * That is not hypothetical: pulsing floor markers animate a squared fade into
   * `radius` every frame, and a courtyard full of them left exactly one lamp casting.
   * They are floor lighting 35 cm off the deck and were never meant to cast at all.
   */
  castsShadow?: boolean;
}

export interface PointLightBuffer {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly radii: Float32Array;
  /**
   * Each selected light's emitter radius, in metres, packed beside its falloff radius.
   *
   * **A light has a size, and a highlight has to know it.** The shading treated every source as
   * a mathematical point, so its reflection in a polished surface was a point too: smaller than
   * a fragment, landing in some pixels and not their neighbours. That is the bright speckle a
   * dark glossy model shows under a close lamp, and it cannot be filtered away afterwards
   * because the information was never sampled. A real emitter subtends an angle, and a headlight
   * a few centimetres from a wing subtends a very large one.
   *
   * `sourceRadius` already said this and only the shadow pass was listening, which is why the
   * penumbra was right and the highlight was not.
   */
  readonly sourceRadii: Float32Array;
  /**
   * How many sources were offered this frame, against the `count` that won a slot.
   *
   * **Reported from outside, and it turned an afternoon into a glance.** A scene was submitting
   * 63 lights against a budget of 10, so the whole budget went to static scenery between 7 and
   * 23 metres away and the rig that answered the music never got a slot. Nothing flickered and
   * nothing warned, because the selection did exactly what it documents; the symptom reported by
   * a person was "the lights are poor", which leads nobody to a light budget. The count had to be
   * recovered by walking the array in a console.
   *
   * Reading it costs nothing and it is the only figure that makes the ratio visible: 63 offered
   * and 10 bound is a scene to prune, 12 offered and 10 bound is a scene that is fine.
   */
  considered: number;
  count: number;
  readonly sourceIndex: Int32Array;
  /**
   * How present each chosen light is, 0 to 1, against the two boundaries it can be
   * crossing: the edge of view range, and the budget cut it shares with the nearest
   * light that missed the set.
   *
   * Deliberately not folded into `colors`. Most of the shading is a colour multiply
   * and would not care, but the emissive term is not — a lit inlay is dimmed by
   * *whichever* lamp shadows it hardest, regardless of that lamp's colour, so a light
   * arriving at zero brightness would still switch a shadow onto the start line. The
   * weight has to reach the shader as itself.
   */
  readonly weights: Float32Array;
  /**
   * Three per slot: where a spot points, normalised. Zeroes for a point light.
   *
   * Filled for every slot rather than only for spots, because a slot keeps whatever the last light
   * to hold it wrote — and a stale direction on a light that is now a point is a cone pointing
   * somewhere it was never aimed.
   */
  readonly directions: Float32Array;
  /** Two per slot: the cosine of the inner cone angle, then of the outer. */
  readonly coneCos: Float32Array;
  /** One per slot: a row of the photometric atlas, or −1 for a light with no profile. */
  readonly iesProfiles: Float32Array;
  /** Internal insertion-sort storage; exposed only to keep one flat object. */
  readonly scratchDistance: Float32Array;
  /**
   * The nearest `POINT_SHADOW_POOL` lights, nearest first — a superset of the shaded
   * ones, and the reason a light no longer pops when it enters the sampled set.
   *
   * Before the shadow pool every light owned a permanent cubemap, so being chosen for
   * shading meant the shadow was already correct. Borrowed maps broke that: joining
   * the set meant evicting somebody and baking six faces at two a frame. The pool has
   * always had four slots more than the shader can bind; these are the lights they are
   * for, kept baked *before* they are wanted.
   */
  readonly shadowIndex: Int32Array;
  shadowCount: number;
}

/**
 * A buffer for the selection to fill, sized to what the caller can actually bind.
 *
 * **`capacity` exists because clustered lighting can carry far more than the shader's uniform
 * arrays.** The froxel table takes up to `MAX_CLUSTERED_LIGHTS`, and this helper used to hand it
 * sixteen whatever a world offered — so the capability was real and unreachable through the one
 * path every consumer uses. A consumer with `RenderQuality.clusteredLights` on asks for a wider
 * buffer; everything else takes the default and is unchanged.
 *
 * **`scratchDistance` grows with it**, and that is not incidental: the shaded list is kept sorted
 * in it, so a buffer wider than the array holding its distances writes past the end. It was sized
 * from `POINT_SHADOW_POOL` because the pool happened to be the larger of the two.
 */
export function createPointLightBuffer(capacity: number = MAX_POINT_LIGHTS): PointLightBuffer {
  const shaded = Math.max(1, Math.floor(capacity));
  return {
    positions: new Float32Array(shaded * 3),
    colors: new Float32Array(shaded * 3),
    radii: new Float32Array(shaded),
    sourceRadii: new Float32Array(shaded),
    considered: 0,
    count: 0,
    sourceIndex: new Int32Array(shaded),
    weights: new Float32Array(shaded),
    directions: new Float32Array(shaded * 3),
    coneCos: new Float32Array(shaded * 2),
    /* −1 rather than 0, because row 0 is a real fixture and a light that asked for none must not
       be shaped by whichever profile happened to load first. */
    iesProfiles: new Float32Array(shaded).fill(-1),
    scratchDistance: new Float32Array(Math.max(shaded, POINT_SHADOW_POOL)),
    shadowIndex: new Int32Array(POINT_SHADOW_POOL),
    shadowCount: 0,
  };
}

/**
 * Select nearest lights whose influence may still be visible and pack them in
 * shader order. The caller owns `out`; no sort arrays or temporary objects are
 * created in this per-frame path.
 *
 * **Two points, because the two lists answer two questions.** `x, y, z` is where the frame is
 * being *shaded* from — the camera — and it orders and culls the shaded list. `castX, castY,
 * castZ` is where whatever might *cast* is standing, and it orders and culls the shadow pool.
 * `AGENTS.md` had already decided which point the pool belongs to: *"a character's shadow only
 * has to exist near the light they are standing at"* — they, not the viewer.
 *
 * They were one argument until 2026-08-25, and a third-person camera is exactly where that
 * hurts: it sits behind its subject, so a fire the subject is standing next to got **no map at
 * all** whenever the camera was further from it than the fire's radius. The scene stayed
 * perfectly lit, which is why nobody could tell it from a bake that never ran.
 *
 * What it gives up: three more numbers on an already-long parameter list, spelled as numbers
 * rather than a vector to match the point above it. What would make it wrong: a consumer with
 * several casters far apart, which one point cannot describe — the pool would then want a set of
 * reference points and a rank over the nearest of them, which is a bigger change than this one
 * and is not what any consumer here has.
 *
 * The default is the shading point, so an existing caller selects bit-identically: `castX = x`
 * makes the distance the *same arithmetic on the same operands*, not merely a close number.
 */
export function selectPointLights(
  sources: readonly PointLightSource[],
  x: number,
  y: number,
  z: number,
  out: PointLightBuffer,
  timeSeconds = 0,
  viewRange = DEFAULT_POINT_LIGHT_VIEW_RANGE,
  castX = x,
  castY = y,
  castZ = z,
): void {
  out.count = 0;
  out.shadowCount = 0;
  /*
   * How many the shaded list holds, read off the buffer rather than from the shader's budget.
   * A caller that asked for a wider one gets it; the default is `MAX_POINT_LIGHTS` exactly.
   */
  const shadedCapacity = out.radii.length;
  /* Everything offered, whether or not it wins a slot or is even in range. See `considered`. */
  out.considered = sources.length;
  /*
   * The nearest light that did not make the set: the boundary the last chosen ones
   * fade against. `Infinity` while the world has fewer lights in range than the
   * shader binds, which is the case where nothing is contested and nothing dims.
   */
  let cutSq = Infinity;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const light = sources[sourceIndex];
    if (light === undefined) continue;
    /*
     * A light with no radius illuminates nothing, and it must not take a slot from
     * one that does. Consumers switch sources on and off by their radius — an oil
     * slick is dark until it catches, a floor marker until it is stood on — so a world
     * carries far more sources than it ever lights at once, and without this a
     * character standing among forty dark markers would have the braziers around them
     * pushed out of the buffer by markers emitting nothing.
     */
    if (light.radius <= 0) continue;
    const dx = light.x - x;
    const dy = light.y - y;
    const dz = light.z - z;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    const cullDistance = viewRange + light.radius;
    if (distanceSq > cullDistance * cullDistance) continue;

    /*
     * Two lists, kept apart on purpose.
     *
     * The **shaded** list is the shader's nearest `MAX_POINT_LIGHTS`, culled at
     * `viewRange + radius` so a light fades out rather than cutting at its own edge.
     *
     * The **shadow** list is who gets a cubemap, and it uses a different, stricter
     * test: a light only qualifies inside its own radius, where the falloff
     * `1 - dist / radius` means it is actually lighting anything. That is `decb3a2`'s
     * rule — *"Acquisition now uses the same range test as release"* — which the pool
     * rewrite lost by driving slots from the shaded list instead. A lamp a hundred
     * metres away then takes a pool slot, thrashes it, and starves the lamp overhead
     * of the map it needs: flashing squares when that bug first shipped, shadows that
     * exist only near an emitter now.
     *
     * Sharing one sorted list is what made them drift apart, so they do not share one.
     */
    let slot = out.count;
    while (slot > 0 && (out.scratchDistance[slot - 1] ?? 0) > distanceSq) slot--;
    if (slot >= shadedCapacity) {
      // Rejected outright, so it is a candidate for the boundary the set fades against.
      if (distanceSq < cutSq) cutSq = distanceSq;
    } else {
      // Full, so making room drops whoever was last off the end — and that is the
      // nearest light not in the set unless something nearer is rejected later.
      if (out.count >= shadedCapacity) {
        const displaced = out.scratchDistance[shadedCapacity - 1] ?? Infinity;
        if (displaced < cutSq) cutSq = displaced;
      }
      const last = Math.min(out.count, shadedCapacity - 1);
      for (let index = last; index > slot; index--) {
        out.scratchDistance[index] = out.scratchDistance[index - 1] ?? 0;
        out.radii[index] = out.radii[index - 1] ?? 0;
        out.sourceRadii[index] = out.sourceRadii[index - 1] ?? 0;
        out.sourceIndex[index] = out.sourceIndex[index - 1] ?? -1;
        for (let component = 0; component < 3; component++) {
          out.positions[index * 3 + component] = out.positions[(index - 1) * 3 + component] ?? 0;
          out.colors[index * 3 + component] = out.colors[(index - 1) * 3 + component] ?? 0;
          out.directions[index * 3 + component] = out.directions[(index - 1) * 3 + component] ?? 0;
        }
        out.coneCos[index * 2] = out.coneCos[(index - 1) * 2] ?? 0;
        out.coneCos[index * 2 + 1] = out.coneCos[(index - 1) * 2 + 1] ?? 0;
        out.iesProfiles[index] = out.iesProfiles[index - 1] ?? -1;
      }
      out.scratchDistance[slot] = distanceSq;
      out.sourceIndex[slot] = sourceIndex;
      out.radii[slot] = light.radius;
      out.sourceRadii[slot] = Math.max(light.sourceRadius, 0);
      out.positions[slot * 3] = light.x;
      out.positions[slot * 3 + 1] = light.y;
      out.positions[slot * 3 + 2] = light.z;
      const scale = flickerScale(light, timeSeconds);
      out.colors[slot * 3] = light.r * scale;
      out.colors[slot * 3 + 1] = light.g * scale;
      out.colors[slot * 3 + 2] = light.b * scale;

      /*
       * **Normalised here rather than trusted**, because the cone is a comparison against a cosine
       * and an un-normalised direction scales that cosine — so a vector of length 2 gives a cone of
       * the wrong width, which reads as the angle having been set wrong rather than the vector.
       * A zero-length direction is a light that declared no cone, and it takes the open pair.
       */
      const dx = light.dirX ?? 0;
      const dy = light.dirY ?? 0;
      const dz = light.dirZ ?? 0;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const aimed = length > 1e-6 && light.coneOuterDeg !== undefined;
      const inverse = aimed ? 1 / length : 0;
      out.directions[slot * 3] = dx * inverse;
      out.directions[slot * 3 + 1] = dy * inverse;
      out.directions[slot * 3 + 2] = dz * inverse;
      if (aimed) {
        /*
         * Clamped so the inner edge never passes the outer. A caller that swaps them would
         * otherwise get `smoothstep` with its edges inverted, which is a cone that is dark in the
         * middle and bright at the rim — a picture nobody would attribute to two numbers being the
         * wrong way round.
         */
        const outerDeg = Math.min(89.9, Math.max(0, light.coneOuterDeg ?? 45));
        const innerDeg = Math.min(outerDeg, Math.max(0, light.coneInnerDeg ?? outerDeg * 0.75));
        out.coneCos[slot * 2] = Math.cos((innerDeg * Math.PI) / 180);
        out.coneCos[slot * 2 + 1] = Math.cos((outerDeg * Math.PI) / 180);
      } else {
        out.coneCos[slot * 2] = POINT_LIGHT_COS_INNER;
        out.coneCos[slot * 2 + 1] = POINT_LIGHT_COS_OUTER;
      }
      /*
       * The profile applies to a point light as readily as to a spot: a bare bulb has a measured
       * distribution too, and the arithmetic does not care whether a cone is also being applied.
       * Restricting it to spots would be a smaller feature for no saving.
       */
      out.iesProfiles[slot] = light.iesProfile ?? -1;

      if (out.count < shadedCapacity) out.count++;
    }

    /*
     * Inside its own radius, so it is lighting something and therefore has something
     * to cast. Nearest first, capped at the pool, and independent of whether the
     * shader had a slot left for it.
     *
     * **Measured from the caster and not from the camera**, and the guard and the rank read the
     * same point on purpose: reading two would fill the pool nearest-to-camera and then evict
     * the very lamp the subject is standing under, which is the shape of every pool bug this
     * file already carries a paragraph about.
     *
     * Computed unconditionally rather than behind `castX === x`. At the default the operands are
     * identical, so this is the same product of the same subtractions and the result is bit
     * identical — a branch would buy a few flops per light and cost the guarantee that a caller
     * who says nothing gets exactly what it got before.
     */
    // A light that animates its radius, or is simply not meant to cast, never takes
    // a slot: it would be stale every frame and starve the lamps that do cast.
    if (light.castsShadow === false) continue;
    const cx = light.x - castX;
    const cy = light.y - castY;
    const cz = light.z - castZ;
    const castDistanceSq = cx * cx + cy * cy + cz * cz;
    if (castDistanceSq >= light.radius * light.radius) continue;
    let shadowSlot = out.shadowCount;
    while (shadowSlot > 0 && (shadowRank[shadowSlot - 1] ?? 0) > castDistanceSq) shadowSlot--;
    if (shadowSlot >= POINT_SHADOW_POOL) continue;
    const lastShadow = Math.min(out.shadowCount, POINT_SHADOW_POOL - 1);
    for (let index = lastShadow; index > shadowSlot; index--) {
      shadowRank[index] = shadowRank[index - 1] ?? 0;
      out.shadowIndex[index] = out.shadowIndex[index - 1] ?? -1;
    }
    shadowRank[shadowSlot] = castDistanceSq;
    out.shadowIndex[shadowSlot] = sourceIndex;
    if (out.shadowCount < POINT_SHADOW_POOL) out.shadowCount++;
  }

  /*
   * How present each of them is, now that the set — and with it the boundary — is
   * known. A second pass over at most eight entries, which is why the cut can be a
   * fact about the whole frame rather than a guess made light by light.
   *
   * The two boundaries are independent and a light can be near both, so it takes
   * whichever says it is fainter.
   */
  const cut = Math.sqrt(cutSq);
  for (let index = 0; index < out.count; index++) {
    const distance = Math.sqrt(out.scratchDistance[index] ?? 0);
    const cullDistance = viewRange + (out.radii[index] ?? 0);
    const arriving = (cullDistance - distance) / FADE_BAND_M;
    const contested = (cut - distance) / CONTENTION_BAND_M;
    out.weights[index] = Math.max(0, Math.min(1, arriving, contested));
  }
}

function flickerScale(light: PointLightSource, timeSeconds: number): number {
  if (light.flicker <= 0) return 1;
  const phase = light.x * 0.7 + light.z * 1.3;
  const wobble =
    Math.sin(timeSeconds * 11.3 + phase) * 0.55 + Math.sin(timeSeconds * 27.7 + phase * 2.1) * 0.45;
  return 1 + light.flicker * wobble;
}
