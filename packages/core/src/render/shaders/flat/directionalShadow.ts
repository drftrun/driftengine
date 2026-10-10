/** Filtering the directional cascade, with receiver-plane depth gradient compensation. */
import { DIRECTIONAL_SHADOW_FADE_START, MAX_SHADOW_FILTER_TAPS } from '../../renderQuality.ts';
import {
  SUN_DYNAMIC_LAYER,
  SUN_GLASS_MOVING_LAYER,
  SUN_GLASS_STATIC_LAYER,
  SUN_PEELED_LAYER,
  SUN_STATIC_LAYER,
} from '../../shadowMap.ts';
import { FROST_RADIUS_CAP, FROST_SPREAD } from '../../glassShadow.ts';

export const DIRECTIONALSHADOW_GLSL = `vec2 receiverPlaneDepthGradient(vec3 p) {
  vec3 dx = dFdx(p);
  vec3 dy = dFdy(p);
  float determinant = dx.x * dy.y - dx.y * dy.x;
  /*
   * **A relative floor, because the absolute one it replaces could not fire.**
   *
   * This determinant is the area scaling of screen space into the light's UV, so its own
   * magnitude is a UV-per-pixel squared — on a 2048 map under an ordinary camera, around 1e-6.
   * A fixed 1e-8 guard is therefore one percent of the quantity it is guarding and only ever
   * catches an exactly singular quad; the ratio blows up long before it, and what comes back is
   * not a gradient but the amplified rounding error in two derivatives that nearly cancel.
   *
   * Compared against the product of the two derivative lengths instead, this is the sine of the
   * angle between them, which is dimensionless and means the same thing at any map size, any
   * resolution and any sun. The two go parallel where the receiving plane collapses toward a
   * line in light space — a surface edge-on to the sun, which is a large deck under a low one —
   * and that is the configuration the bands were reported in.
   */
  float conditioning = length(dx.xy) * length(dy.xy);
  if (abs(determinant) < 1e-4 * conditioning) return vec2(0.0);
  return vec2(
    (dx.z * dy.y - dx.y * dy.z) / determinant,
    (dx.x * dy.z - dx.z * dy.x) / determinant
  );
}

/* One stored depth against a receiver, in a map spanning \`span\` metres of depth. */
float directionalVisibilityAt(float receiverDepth, float compareDepth, float storedDepth, float span) {
  if (compareDepth <= storedDepth) return 1.0;
  float rayDistance = max(receiverDepth - storedDepth, 0.0) * span;
  float groundDistance = rayDistance * length(uDirectionalDir.xz);
  return 1.0 - shadowReach(groundDistance, uShadowMaxDistance);
}

float directionalVisibility(float receiverDepth, float compareDepth, float storedDepth) {
  return directionalVisibilityAt(receiverDepth, compareDepth, storedDepth, uShadowDepthSpan);
}

/* How far inside its square a receiver stands in a layer's map: 1 well inside, 0 at its border. */
float sunMapFade(vec3 p) {
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 0.0;
  vec2 fromCentre = abs(p.xy - 0.5) * 2.0;
  return (1.0 - smoothstep(0.72, 0.98, max(fromCentre.x, fromCentre.y))) *
    (1.0 - smoothstep(0.90, 1.0, p.z));
}

/*
 * The moving layer at its own place, where it has a matrix of its own (movingSun.ts): the coarse
 * test of shadowFactor, and its filter, each against the moving map's own depth span, and lit by
 * how far inside the moving map's square the receiver stands rather than cut at its border.
 */
float movingSunCoarse(vec3 pm, float span) {
  float inside = sunMapFade(pm);
  if (inside <= 0.0) return 1.0;
  float stored = textureLod(uSunShadows, vec3(pm.xy, ${SUN_DYNAMIC_LAYER}.0), 0.0).r;
  return mix(1.0, directionalVisibilityAt(pm.z, pm.z - 1.0 / span, stored, span), inside);
}

float movingSunFiltered(vec3 pm, vec2 gradient, float span) {
  float inside = sunMapFade(pm);
  if (inside <= 0.0) return 1.0;
  float texel = 1.35 / uShadowMapSize;
  float slopeLimit = 9.1 / uShadowMapSize;
  float lit = 0.0;
  for (int i = 0; i < ${MAX_SHADOW_FILTER_TAPS}; i++) {
    if (i >= uShadowFilterTaps) break;
    vec2 sampleUv = pm.xy + DIRECTIONAL_PCF_OFFSETS[i] * texel;
    vec2 texelCentre = (floor(sampleUv * uShadowMapSize) + 0.5) / uShadowMapSize;
    float slopeOffset = clamp(dot(gradient, texelCentre - pm.xy), -slopeLimit, slopeLimit);
    float tapReceiverDepth = pm.z + slopeOffset;
    float stored = textureLod(uSunShadows, vec3(sampleUv, ${SUN_DYNAMIC_LAYER}.0), 0.0).r;
    lit += directionalVisibilityAt(tapReceiverDepth, tapReceiverDepth - 0.14 / span, stored, span);
  }
  return mix(1.0, lit / float(max(uShadowFilterTaps, 1)), inside);
}

float shadowFactor(float directionalNdl) {
  if (uShadowStrength <= 0.0) return 1.0;

  /*
   * The receiver's position and its plane gradient, computed **above every early return
   * that depends on a varying** — which is what makes the derivatives inside
   * \`receiverPlaneDepthGradient\` legal.
   *
   * \`dFdx\` is only defined under uniform control flow. GLSL leaves a derivative reached
   * through a varying-dependent branch undefined and compiles it anyway; **WGSL makes it an
   * error and refuses the whole module**:
   *
   *     error: 'dpdx' must only be called from uniform control flow
   *
   * So this used to sit after four early returns, three of them varying-dependent, and the
   * shader could not be translated at all. It is the same requirement \`AGENTS.md\` records
   * on 2026-08-07 for \`texture()\` in a non-uniform branch, arriving from the other side:
   * there a compiler was free to flatten the branch and charge for every arm, here it simply
   * declines. Hoisting satisfies both.
   *
   * The \`uShadowStrength\` test above stays where it is because it reads a uniform, and a
   * branch on a uniform is uniform control flow.
   *
   * The cost is the gradient computed on fragments that then return early: two derivatives
   * and six multiplies, against a pass that was already sampling the map twelve times.
   */
  vec3 p = vLightPos.xyz / vLightPos.w;
  p = p * 0.5 + 0.5;
  vec2 depthGradient = receiverPlaneDepthGradient(p);
  /* The moving layer's own place and plane where it has a matrix of its own (movingSun.ts), taken
     here beside the static layer's for the same reason: above every varying-dependent return. */
  vec3 pm = p;
  vec2 movingGradient = depthGradient;
  if (MOVING_SUN) {
    pm = movingSunAt();
    movingGradient = receiverPlaneDepthGradient(pm);
  }

  // Near a surface's own light terminator its direct-light term is already
  // approaching zero, while the orthographic projection of that surface
  // collapses toward a line. No finite contact-safe bias can represent that
  // slope reliably, so through this band the fine filter below hands over to the
  // coarse test after it. \`directionalNdl\` is the surface's own, before any normal
  // map: the band is about the receiving plane, and a map's tilt says nothing about it.
  float receiverFade = smoothstep(0.08, 0.20, directionalNdl);
  /* A surface turned from the light takes none of it, so there is nothing to shadow; what reads
     this there is the emissive share, which has always seen such a surface as unshadowed. */
  if (directionalNdl <= 0.0) return 1.0;

  // The receiver stays at its real position, computed above. A normal offset changes
  // direction at a hard mesh edge and tears one continuous shadow where it crosses from
  // a top onto a side. Receiver-plane compensation and the light-axis residual
  // below handle acne without moving adjacent faces apart.
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;

  // Fade toward lit near the frustum border instead of cutting at it. The map
  // only covers a radius around the viewer, and a hard edge makes distant
  // shadows blink out the moment geometry crosses it — which reads as flashing,
  // not as distance.
  vec2 fromCentre = abs(p.xy - 0.5) * 2.0;
  float edgeFade = 1.0 - smoothstep(0.72, 0.98, max(fromCentre.x, fromCentre.y));
  // The far plane needs the same treatment, or shadows vanish by depth instead.
  edgeFade *= 1.0 - smoothstep(0.90, 1.0, p.z);
  if (edgeFade <= 0.0) return 1.0;

  /*
   * Fade the directional shadow once, by source elevation.
   *
   * Source elevation is shared by the whole map, so low-angle stripes disappear
   * without creating a hard length cut. Per-caster distance fade is handled
   * independently below for static and moving geometry.
   */
  float shadowSlope = length(uDirectionalDir.xz) / max(uDirectionalDir.y, 0.001);
  float lowElevationFade = 1.0 - smoothstep(
    uShadowMaxSlope * ${DIRECTIONAL_SHADOW_FADE_START.toFixed(2)},
    uShadowMaxSlope,
    shadowSlope
  );
  if (lowElevationFade <= 0.0) return 1.0;

  /*
   * **The coarse test: is there anything a metre or more between this point and the sun.**
   *
   * One tap at the receiver's own texel, with a metre of tolerance where the filter below allows
   * fourteen centimetres. It cannot see a contact shadow, and it does not need the plane's slope:
   * a grazing plane's own depth moves about a centimetre times the tangent of its angle to the
   * light across a texel, which stays under a metre down to a hundredth of n·l on a map with
   * centimetre texels. What it does see is a roof.
   *
   * **This band used to return fully lit**, on the argument that the Lambert term was already
   * near zero there. Under a high sun that is every vertical wall: at 70° of elevation a wall's
   * n·l is at most 0.34, and one turned from the sun's bearing sits inside the band. A gallery's
   * back wall under its vault took the sun through the vault, and so did the faces of its
   * columns, which read as lit stone in shade; with a normal map carrying that n·l per texel it
   * was a field of white specks. What would make this wrong is a map whose texels are tens of
   * centimetres, where a grazing plane's own depth moves more than the tolerance and the band
   * draws the acne it exists to avoid.
   */
  float coarseCompare = p.z - 1.0 / uShadowDepthSpan;
  float coarse =
    directionalVisibility(p.z, coarseCompare, textureLod(uSunShadows, vec3(p.xy, ${SUN_STATIC_LAYER}.0), 0.0).r) *
    (MOVING_SUN ? movingSunCoarse(pm, movingSunSpan()) :
      directionalVisibility(p.z, coarseCompare, textureLod(uSunShadows, vec3(p.xy, ${SUN_DYNAMIC_LAYER}.0), 0.0).r));
  if (uPeeledShadowEnabled != 0) {
    coarse *= directionalVisibility(p.z, coarseCompare, textureLod(uSunShadows, vec3(p.xy, ${SUN_PEELED_LAYER}.0), 0.0).r);
  }
  float strength = uShadowStrength * edgeFade * lowElevationFade;
  if (receiverFade <= 0.0) return mix(1.0, coarse, strength);

  float texel = 1.35 / uShadowMapSize;
  /*
   * How far the plane compensation below may carry a tap's depth, in the map's own units.
   *
   * **The compensation is a product of an unbounded gradient and a bounded offset, and only one
   * of the two was ever bounded.** A tap lands at most 1.85 texels from the receiver — the
   * filter radius plus the texel-centre snap — so a gradient that has blown up turns a fraction
   * of a texel into a depth swing of whole map units. The comparison then flips on alternate
   * shadow texels, and what draws is a run of hard straight stripes lying along the map's texel
   * grid: oblique on screen, because that grid is turned by the sun rather than by the camera,
   * and only where the map holds an occluder at all, because a tap that reads the far plane is
   * lit whatever depth it compares against. Reported exactly that way — bands near the shadows,
   * not everywhere, and only at some hours of the day.
   *
   * Nine texels' worth of depth, which is not a taste. The receiver fade above already gives up
   * below a directional n·l of 0.20, a surface 78 degrees off the sun, whose plane climbs 4.9
   * units of depth per unit across the map. Over the 1.85 texels a tap can reach that is 9.1, so
   * this bound sits above every slope the shader still draws a shadow on and below the ones it
   * cannot represent. Stated against uShadowMapSize rather than in metres so it tracks the texel
   * it is derived from: a 1024 map has texels twice as long and gets twice the allowance.
   */
  float slopeLimit = 9.1 / uShadowMapSize;
  // Each PCF tap lands at a different point on the receiving plane. Following
  // that plane's depth removes the striped self-shadowing a single constant
  // comparison creates on large grazing surfaces, without increasing the
  // contact gap. The residual 14 cm tolerance is projection-size independent;
  // unlike the old normalised bias, it cannot silently grow toward a metre.
  float staticLit = 0.0;
  float peeledLit = 0.0;
  float dynamicLit = 0.0;
  for (int i = 0; i < ${MAX_SHADOW_FILTER_TAPS}; i++) {
    if (i >= uShadowFilterTaps) break;
    vec2 offset = DIRECTIONAL_PCF_OFFSETS[i] * texel;
    vec2 sampleUv = p.xy + offset;
    // Depth textures use NEAREST filtering, so the fetched depth belongs to
    // the centre of the containing texel, not to the continuous Poisson UV.
    // Following the continuous UV leaves up to half a texel of uncompensated
    // plane slope; on a grazing face that becomes the repeating light/dark
    // ribs seen as the receiver crosses shadow texels.
    vec2 texelCentre = (floor(sampleUv * uShadowMapSize) + 0.5) / uShadowMapSize;
    /* Clamped, not the raw product: see slopeLimit above. Compensation this large is already past
       the slope the receiver fade draws anything on, so the clamp costs no picture. */
    float slopeOffset = clamp(dot(depthGradient, texelCentre - p.xy), -slopeLimit, slopeLimit);
    float tapReceiverDepth = p.z + slopeOffset;
    float compare = tapReceiverDepth - 0.14 / uShadowDepthSpan;
    /*
     * \`textureLod\` rather than \`texture\`, by the rule \`AGENTS.md\` records on 2026-08-07:
     * this loop is reached through a branch on \`vLightPos\`, which is not uniform, and an
     * implicit derivative there is undefined. **WGSL does not merely leave it undefined, it
     * refuses to compile the module**: *"'textureSample' must only be called from uniform
     * control flow"*.
     *
     * Bit-for-bit identical on WebGL2 for the same reason the point-light samples were:
     * \`shadowMap.ts\` allocates these with one storage level and \`NEAREST\` filtering, so
     * there is no mip to select and level zero is the only thing \`texture\` could have read.
     */
    float staticDepth = textureLod(uSunShadows, vec3(sampleUv, ${SUN_STATIC_LAYER}.0), 0.0).r;
    staticLit += directionalVisibility(tapReceiverDepth, compare, staticDepth);
    if (uPeeledShadowEnabled != 0) {
      float peeledDepth = textureLod(uSunShadows, vec3(sampleUv, ${SUN_PEELED_LAYER}.0), 0.0).r;
      peeledLit += directionalVisibility(tapReceiverDepth, compare, peeledDepth);
    } else {
      peeledLit += 1.0;
    }
    /* The moving layer here where it shares the static one's place; at its own below otherwise.
       Branched on the switch itself, never its negation: see overridableConstants in transform.mjs. */
    if (MOVING_SUN) {
    } else {
      float dynamicDepth = textureLod(uSunShadows, vec3(sampleUv, ${SUN_DYNAMIC_LAYER}.0), 0.0).r;
      dynamicLit += directionalVisibility(tapReceiverDepth, compare, dynamicDepth);
    }
  }
  float tapCount = float(max(uShadowFilterTaps, 1));
  staticLit /= tapCount;
  peeledLit /= tapCount;
  dynamicLit = MOVING_SUN ? movingSunFiltered(pm, movingGradient, movingSunSpan()) : dynamicLit / tapCount;

  // Independent layers preserve every recorded fact at an overlap: each
  // caster keeps its own distance fade, and their transmissions compose
  // monotonically. The peeled layer holds the second static occluder that a
  // conventional one-depth map would discard; movers remain independent too.
  float lit = staticLit * peeledLit * dynamicLit;

  return mix(1.0, mix(coarse, lit, receiverFade), strength);
}

/*
 * One of the sun's two glass layers at receiver p: how milky the nearest pane is and how far behind
 * it this receiver stands, the spread that follows (glassShadow.ts's frostRadius, capped), and the
 * tint's level for that spread. Then glassShadow.ts's spreadTint: the outline from taps at the base
 * radius — where the clear pane's patch ends — and the colour from the spread taps, each read coarse,
 * unmixed from the ground around it and weighed by the pane's share of it, so a frosted patch mixes
 * its panes' colours and keeps the light the clear one lets through. What it gives up is a pane lying
 * behind the receiver lending it colour within the spread, which only a receiver between two panes
 * meets. One function for both layers, because two copies were most of the lit shaders' growth.
 */
vec3 sunGlassLayer(vec3 p, float paneLayer, float tintLayer, float bias, float texel, float uvPerMetre, float span) {
  float tintSize = float(textureSize(uSunGlassTints, 0).x);
  float clarity = textureLod(uSunGlassTints, vec3(p.xy, tintLayer), 0.0).a;
  float behind =
    max(p.z - textureLod(uSunShadows, vec3(p.xy, paneLayer), 0.0).r, 0.0) * span;
  float radius = clamp(
    (1.0 - clarity) * ${FROST_SPREAD.toFixed(6)} * behind * uvPerMetre,
    texel,
    texel * ${FROST_RADIUS_CAP.toFixed(1)}
  );
  float lod = log2(max(radius * tintSize, 1.0));
  float cover = 0.0;
  vec3 colour = vec3(0.0);
  float found = 0.0;
  for (int i = 0; i < ${MAX_SHADOW_FILTER_TAPS}; i++) {
    if (i >= uShadowFilterTaps) break;
    vec2 offset = DIRECTIONAL_PCF_OFFSETS[i];
    vec2 edgeUv = p.xy + offset * texel;
    cover += p.z > textureLod(uSunShadows, vec3(edgeUv, paneLayer), 0.0).r + bias ? 1.0 : 0.0;
    /* The spread taps weigh by the pane's unmixed share rather than a depth test: continuous, so a
       colour crossing between two panes blends rather than stepping through sixteen bands. */
    vec4 pane = glassUnmix(textureLod(uSunGlassTints, vec3(p.xy + offset * radius, tintLayer), lod), clarity);
    colour += pane.rgb * pane.a;
    found += pane.a;
  }
  float taps = float(max(uShadowFilterTaps, 1));
  return mix(vec3(1.0), found > 0.0 ? colour / found : vec3(1.0), cover / taps);
}

/*
 * What the sun's light keeps of itself through glass at this receiver: glassShadow.ts's tap rule
 * and frost spread, over shadowFactor's own taps. A tap counts a pane only when the receiver is
 * farther from the sun than that pane (the glass depth layers), so a surface on the sun's side of a
 * pane, and the pane itself, keep the sun's own colour; the taps average with equal weight, so the
 * spread moves light rather than losing it. Frost widens the taps by how far behind the nearest pane
 * the receiver is, capped, with the tap count unchanged. What it gives up is spread past the edge of
 * an opaque frame's shadow, which this lookup never sees. Faded with the opaque shadow's own fades.
 */
vec3 sunGlassLookup(float directionalNdl) {
  vec3 p = vLightPos.xyz / vLightPos.w;
  p = p * 0.5 + 0.5;
  /* Map units per metre along the receiver, from derivatives taken first in uniform control flow,
     so a frost spread stated in metres lands the same whatever size of light matrix a consumer built. */
  float uvPerMetre = length(dFdx(p.xy)) / max(length(dFdx(vWorldPos)), 1e-6);
  /* The moving glass at its own place where its layer has a matrix of its own: movingSun.ts. */
  vec3 pm = p;
  float movingPerMetre = uvPerMetre;
  if (MOVING_SUN) {
    pm = movingSunAt();
    movingPerMetre = length(dFdx(pm.xy)) / max(length(dFdx(vWorldPos)), 1e-6);
  }
  if (uShadowStrength <= 0.0 || textureSize(uSunGlassTints, 0).x <= 1) return vec3(1.0);
  if (directionalNdl <= 0.0) return vec3(1.0);
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return vec3(1.0);
  vec2 fromCentre = abs(p.xy - 0.5) * 2.0;
  float edgeFade = 1.0 - smoothstep(0.72, 0.98, max(fromCentre.x, fromCentre.y));
  edgeFade *= 1.0 - smoothstep(0.90, 1.0, p.z);
  float shadowSlope = length(uDirectionalDir.xz) / max(uDirectionalDir.y, 0.001);
  float lowElevationFade = 1.0 - smoothstep(
    uShadowMaxSlope * ${DIRECTIONAL_SHADOW_FADE_START.toFixed(2)},
    uShadowMaxSlope,
    shadowSlope
  );
  float strength = uShadowStrength * edgeFade * lowElevationFade;
  if (strength <= 0.0) return vec3(1.0);

  float bias = 0.14 / uShadowDepthSpan;
  float texel = 1.35 / uShadowMapSize;
  vec3 staticTint = sunGlassLayer(p, ${SUN_GLASS_STATIC_LAYER}.0, 0.0, bias, texel, uvPerMetre, uShadowDepthSpan);
  vec3 movingTint = MOVING_SUN && sunMapFade(pm) <= 0.0
    ? vec3(1.0)
    : sunGlassLayer(
      pm,
      ${SUN_GLASS_MOVING_LAYER}.0,
      1.0,
      MOVING_SUN ? 0.14 / movingSunSpan() : bias,
      texel,
      movingPerMetre,
      MOVING_SUN ? movingSunSpan() : uShadowDepthSpan
    );
  return mix(vec3(1.0), staticTint * movingTint, strength);
}

/* The way in, asking first whether this build reads glass at all (GLASS_SHADOWS). A constant, so
   the lookup's derivatives are still taken in uniform control flow. */
vec3 sunGlassTint(float directionalNdl) {
  if (GLASS_SHADOWS) return sunGlassLookup(directionalNdl);
  return vec3(1.0);
}
#endif

/**
 * Value noise on a world position, for the grain term.
 *
 * Its own hash rather than the one the plume shaders use, because those work in 2D and
 * grain on a solid has to be three-dimensional — a 2D pattern projected onto a turning
 * object slides across its faces, which is precisely the "painted on" look this exists
 * to avoid.
 */`;
