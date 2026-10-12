/**
 * The medium between the camera and everything it can see: haze in the air, and
 * the water column when the camera is under it.
 *
 * One GLSL string rather than a copy in each program. Seven fragment shaders were
 * carrying the same seven uniform declarations and the same four lines of fog, which
 * is seven chances for the mesh under a slick to recede at a different rate than the
 * slick does — and it had already happened: the oil film's own comment claimed *"the
 * same fog every other pass applies"* while it ran a different curve.
 */

/**
 * Air is **Beer–Lambert through a haze layer that thins with height**, water keeps its
 * own squared law, and `uUnderwaterFactor` crossfades them across the surface.
 *
 * **Why the air law changed (2026-08-04).** It used to be `1 − exp(−(σd)²)`, the
 * fixed-function `GL_EXP2` curve, whose optical depth grows with the *square* of
 * distance — which is not an extinction law, it is a medium that gets denser the
 * further you look. It saturates viciously: at the day-3 density it reached 50% at
 * 63 m and **99.9% at 200 m**, so when the world grew from a 44 m band to a 232 m one
 * the whole of a 200 m descent, the sea and the islands were a single flat wash of sky
 * colour. Beer–Lambert spends the same near field over a far longer range — and it has
 * a *non-zero gradient at zero distance*, where the squared law is flat, so the first
 * twenty metres actually gain depth rather than lose it.
 *
 * **Why height matters.** Haze sits on the sea and thins upward; there is less air
 * above you the higher you stand. That is the difference between looking along a valley
 * and looking down a mountain, which is exactly the distinction this world acquired
 * when it got tall. Density is `σ₀·exp(−(y − y₀)/H)`, and the optical depth along a ray
 * is that integrated between the two endpoint heights — which collapses to the density
 * at the eye times `(1 − e⁻ᵗ)/t`, with `t` the height climbed in scale heights. The eye
 * density and `1/H` arrive precomputed from `bindAtmosphere`.
 *
 * `uFogMedium.z`, the eye's height, rather than `uCameraPos.y`, because two of the seven
 * programs (the plumes) never needed the camera position in their fragment stage, and a block
 * that declares everything it uses can be pasted anywhere.
 */
export const FOG_GLSL = `
uniform vec3 uFogColor;
/**
 * The haze: its extinction per metre **at the camera's own height**, not at the base; its
 * reciprocal scale height per metre, 0 for a uniform medium; the camera's height, so a fragment's
 * own height is one subtraction away; and the water column's own density.
 *
 * **Four numbers in one vector rather than four uniforms**, and the reason is a phone: a scalar
 * costs a whole row of the uniform grid, and the lit stage at its eight-light rung must fit the 256
 * rows an Adreno 740 offers (uniformVectorBudget.ts). Packed, the haze's eight scalars cost two
 * rows where they cost eight, which is what paid for the second layer and the sun's glow below.
 */
uniform vec4 uFogMedium;
/** Where haze begins, where a linear ramp is total, and the mode: 0 a medium, 1 a ramp. */
uniform vec4 uFogRange;
uniform vec3 uUnderwaterColor;
uniform float uUnderwaterFactor;
/**
 * The second layer's extinction per metre at the camera's height and its falloff; then the least of
 * a surface the haze must leave, Atmosphere.fogMaxOpacity's complement, and the distance past which
 * it hides nothing (0 is none). **Every lane is none at zero**, and so are uFogGlow's: a program a
 * binder never wrote these into draws the haze it drew before they existed, rather than none.
 */
uniform vec4 uFogLayer2;
/** The sun's glow in the haze: its colour, black for none, and the exponent of its lobe. */
uniform vec4 uFogGlow;
/** Surface → the glow's light, and how far past the haze's start the glow begins. */
uniform vec4 uFogGlowDir;

/** What distance converges toward: the day's haze, or the water column. */
vec3 mediumColor() {
  return mix(uFogColor, uUnderwaterColor, uUnderwaterFactor);
}

/**
 * The haze's optical depth from where it begins along the ray to a point at height pointY, dist
 * metres away: each layer's density at the eye carried over what is left of the ray, with the
 * second layer only where there is one. The fog and the sun's glow both integrate it.
 */
float hazeDepth(float dist, float pointY) {
  // Where the medium begins along the ray: uFogRange.x, the linear mode's slot, which this mode
  // never read before Atmosphere.fogStart. The ray is integrated from there on, at the density
  // of that point; at a start of 0 every term is the one it always was. See render/fog.ts.
  float start = min(uFogRange.x, dist);
  float before = dist > 0.0 ? start / dist : 0.0;
  float t = (pointY - uFogMedium.z) * uFogMedium.y;
  float rest = t * (1.0 - before);
  // (1 - e^-t)/t, which tends to 1 as the ray levels out. Guarded rather than
  // branched: at t = 0 the quotient is 0/0, and 1e-4 of a scale height is 8 mm.
  float denom = abs(rest) < 1e-4 ? 1e-4 : rest;
  float depth = uFogMedium.x * exp(-t * before) * (dist - start) * (1.0 - exp(-denom)) / denom;
  if (uFogLayer2.x > 0.0) {
    float t2 = (pointY - uFogMedium.z) * uFogLayer2.y;
    float rest2 = t2 * (1.0 - before);
    float denom2 = abs(rest2) < 1e-4 ? 1e-4 : rest2;
    depth += uFogLayer2.x * exp(-t2 * before) * (dist - start) * (1.0 - exp(-denom2)) / denom2;
  }
  return depth;
}

/**
 * How much of a surface standing at height pointY, dist metres away, is lost to
 * the medium in between. 0 is perfectly clear, 1 is the medium's own colour.
 */
float mediumFog(float dist, float pointY) {
  /* Past the cutoff the air hides nothing, in either mode; the water column keeps its own law. */
  bool cut = uFogLayer2.w > 0.0 && dist > uFogLayer2.w;
  /*
   * A depth ramp rather than a medium, for worlds authored against one.
   *
   * Beer-Lambert is the honest model and stays the default: it integrates something
   * physically there, so extinction begins at the eye and never stops. A linear near/far
   * fog is not that — it is a *look*, with a hard start distance before which the air is
   * perfectly clear, and it is what the fixed-function pipeline offered and what several
   * renderers still expose. Approximating one with the other is not a matter of tuning:
   * matched at half occlusion, the exponential curve still lays haze over everything
   * inside near, where the ramp lays none, and near-field colour desaturates toward the
   * fog colour with nothing to show for it.
   *
   * Height falloff has no meaning here and is ignored: a ramp is defined on distance
   * alone.
   */
  if (uFogRange.z == 1.0) {
    float span = max(uFogRange.y - uFogRange.x, 1e-4);
    float ramp = cut ? 0.0 : min(clamp((dist - uFogRange.x) / span, 0.0, 1.0), 1.0 - uFogLayer2.z);
    if (uUnderwaterFactor <= 0.0) return ramp;
    float wetLinear = uFogMedium.w * dist;
    return mix(ramp, 1.0 - exp2(-wetLinear * wetLinear * 1.442695), uUnderwaterFactor);
  }

  // Beer-Lambert through both layers, leaving at least uFogLayer2.z of the surface: a floor on
  // what survives rather than a ceiling on the depth, so the curve keeps its shape above it.
  float air = cut ? 0.0 : 1.0 - max(exp(-hazeDepth(dist, pointY)), uFogLayer2.z);
  if (uUnderwaterFactor <= 0.0) return air;
  // Water is its own medium and keeps its own curve, so crossing the surface
  // changes nothing about how the water column reads.
  float wet = uFogMedium.w * dist;
  return mix(air, 1.0 - exp2(-wet * wet * 1.442695), uUnderwaterFactor);
}

/**
 * The sun's light the haze scatters toward the eye along a ray to a point at height pointY, dist
 * metres away in the direction toPoint: added to a surface after its fog, never mixed. A lobe of
 * cos^exponent about the light, by as much of the ray past the glow's own start as the haze hides —
 * the haze's depth per metre carried over that stretch. None in a linear ramp, past the cutoff, or
 * under water, which keeps its own medium.
 */
vec3 mediumGlow(float dist, float pointY, vec3 toPoint) {
  if (uFogRange.z == 1.0 || max(max(uFogGlow.r, uFogGlow.g), uFogGlow.b) <= 0.0) return vec3(0.0);
  if (uFogLayer2.w > 0.0 && dist > uFogLayer2.w) return vec3(0.0);
  float span = dist - min(uFogRange.x, dist);
  if (span <= 0.0) return vec3(0.0);
  float perMetre = hazeDepth(dist, pointY) / span;
  float hidden = 1.0 - exp(-perMetre * max(span - uFogGlowDir.w, 0.0));
  float lobe = pow(clamp(dot(toPoint, uFogGlowDir.xyz), 0.0, 1.0), uFogGlow.a);
  return uFogGlow.rgb * (lobe * hidden * (1.0 - uUnderwaterFactor));
}
`;
