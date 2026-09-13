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
 * `uFogEyeY` rather than `uCameraPos.y` because two of the seven programs (the plumes)
 * never needed the camera position in their fragment stage, and a block that declares
 * everything it uses can be pasted anywhere.
 */
export const FOG_GLSL = `
uniform vec3 uFogColor;
/** Extinction per metre **at the camera's own height**, not at the base. */
uniform float uFogDensity;
/** Reciprocal scale height of the haze, per metre. 0 is a uniform medium. */
uniform float uFogHeightFalloff;
/** The camera's height, so a fragment's own height is one subtraction away. */
uniform float uFogEyeY;
uniform vec3 uUnderwaterColor;
uniform float uUnderwaterFogDensity;
uniform float uUnderwaterFactor;
/** 0 integrates a medium (Beer-Lambert); 1 ramps linearly between near and far. */
uniform int uFogMode;
/** Linear mode only: where haze begins, and where it is total. */
uniform float uFogNear;
uniform float uFogFar;

/** What distance converges toward: the day's haze, or the water column. */
vec3 mediumColor() {
  return mix(uFogColor, uUnderwaterColor, uUnderwaterFactor);
}

/**
 * How much of a surface standing at height pointY, dist metres away, is lost to
 * the medium in between. 0 is perfectly clear, 1 is the medium's own colour.
 */
float mediumFog(float dist, float pointY) {
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
  if (uFogMode == 1) {
    float span = max(uFogFar - uFogNear, 1e-4);
    float ramp = clamp((dist - uFogNear) / span, 0.0, 1.0);
    if (uUnderwaterFactor <= 0.0) return ramp;
    float wetLinear = uUnderwaterFogDensity * dist;
    return mix(ramp, 1.0 - exp2(-wetLinear * wetLinear * 1.442695), uUnderwaterFactor);
  }

  float t = (pointY - uFogEyeY) * uFogHeightFalloff;
  // (1 - e^-t)/t, which tends to 1 as the ray levels out. Guarded rather than
  // branched: at t = 0 the quotient is 0/0, and 1e-4 of a scale height is 8 mm.
  float denom = abs(t) < 1e-4 ? 1e-4 : t;
  float air = 1.0 - exp(-uFogDensity * dist * (1.0 - exp(-denom)) / denom);
  if (uUnderwaterFactor <= 0.0) return air;
  // Water is its own medium and keeps its own curve, so crossing the surface
  // changes nothing about how the water column reads.
  float wet = uUnderwaterFogDensity * dist;
  return mix(air, 1.0 - exp2(-wet * wet * 1.442695), uUnderwaterFactor);
}
`;
