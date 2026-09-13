/** Filtering the directional cascade, with receiver-plane depth gradient compensation. */
import { DIRECTIONAL_SHADOW_FADE_START, MAX_SHADOW_FILTER_TAPS } from '../../renderQuality.ts';

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

float directionalVisibility(float receiverDepth, float compareDepth, float storedDepth) {
  if (compareDepth <= storedDepth) return 1.0;
  float rayDistance = max(receiverDepth - storedDepth, 0.0) * uShadowDepthSpan;
  float groundDistance = rayDistance * length(uDirectionalDir.xz);
  return 1.0 - shadowReach(groundDistance, uShadowMaxDistance);
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

  // Near a surface's own light terminator its direct-light term is already
  // approaching zero, while the orthographic projection of that surface
  // collapses toward a line. No finite contact-safe bias can represent that
  // slope reliably. Fade only the shadow modulation through this narrow band;
  // the Lambert term still supplies the physically dominant falloff.
  float receiverFade = smoothstep(0.08, 0.20, directionalNdl);
  if (receiverFade <= 0.0) return 1.0;

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
    float staticDepth = textureLod(uStaticShadowMap, sampleUv, 0.0).r;
    float dynamicDepth = textureLod(uDynamicShadowMap, sampleUv, 0.0).r;
    staticLit += directionalVisibility(tapReceiverDepth, compare, staticDepth);
    if (uPeeledShadowEnabled != 0) {
      float peeledDepth = textureLod(uPeeledShadowMap, sampleUv, 0.0).r;
      peeledLit += directionalVisibility(tapReceiverDepth, compare, peeledDepth);
    } else {
      peeledLit += 1.0;
    }
    dynamicLit += directionalVisibility(tapReceiverDepth, compare, dynamicDepth);
  }
  float tapCount = float(max(uShadowFilterTaps, 1));
  staticLit /= tapCount;
  peeledLit /= tapCount;
  dynamicLit /= tapCount;

  // Independent layers preserve every recorded fact at an overlap: each
  // caster keeps its own distance fade, and their transmissions compose
  // monotonically. The peeled layer holds the second static occluder that a
  // conventional one-depth map would discard; movers remain independent too.
  float lit = staticLit * peeledLit * dynamicLit;

  return mix(1.0, lit, uShadowStrength * edgeFade * lowElevationFade * receiverFade);
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
