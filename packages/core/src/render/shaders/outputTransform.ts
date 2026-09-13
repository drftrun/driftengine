/**
 * The grade every forward pass applies when it is the last one to touch the frame.
 *
 * **One GLSL string rather than a copy in each program**, for the reason `fog.ts` gives about
 * itself and for a sharper one here: this is not a look, it is a *conversion*, and two passes
 * converting differently is a scene where the smoke and the wall it drifts past disagree about
 * what a colour means. That is exactly the state this engine was in until this file existed.
 * `flat.ts` carried the whole thing privately, and `renderer.ts` said so in its own words at the
 * mesh pass's upload site: *"full grading needs the composite. Without it the sky, the
 * particles, the film and the water are still ungraded beside a world that is."*
 *
 * **What that costs a consumer with no composite, which is the case this closes.** A pass that
 * writes linear values into an 8-bit target has them read back as if they were already display
 * values, which is not a subtle shift: `#ff8d72` reaches the screen as `(255, 68, 43)` instead
 * of `(213, 125, 97)`, a saturated red where the author asked for a warm salmon, and it clips.
 * Found on a site port whose sparkle field went from additive and fogged, where it was too dim
 * to show, to alpha blended and unfogged, where it was the brightest thing in the frame.
 *
 * **Blending happens after this, in display space, and that is the same thing three.js does.**
 * three.js tone maps and converts inside every material's own fragment stage, so a blended draw
 * there composites graded against graded too. It is a real difference from grading once at a
 * composite, where blending happens in scene units, and it is the difference a consumer asks
 * for when it turns the composite off.
 *
 * **A pass must apply this only when it is genuinely last.** With a scene target the resolve
 * grades, so a pass that also graded would apply a curve to its own output; every upload site
 * gates on the same `gradeHere` the mesh pass uses.
 */

/**
 * `uOutputTransform` and `uOutputExposure`, the fit, and `applyOutputTransform`.
 *
 * Declares its own two uniforms, so including it is the whole of what a fragment stage has to
 * do besides calling it. Both are ints and floats rather than defines because the choice is a
 * caller's, per draw, and a permutation per output transform would double a pipeline count for
 * a branch that costs one compare.
 */
export const OUTPUT_TRANSFORM_GLSL = `
/** 0 none, 1 sRGB, 2 ACES then sRGB. See renderQuality.ts. */
uniform int uOutputTransform;
/** Scales the scene into the tone curve. 1 is the reference grade. See renderQuality.ts. */
uniform float uOutputExposure;

/*
 * ACES: the reference fit, not the cheap one.
 *
 * This was Narkowicz's single rational function, on the argument that the difference from
 * the reference curve is invisible next to the gain. That argument holds for a look and
 * fails for a *match*, which is what this option is for — aces exists so a world ported
 * from three.js reads the same, and three.js applies the full fit: into AP1 through
 * ACESInputMat, the RRT and ODT together, then back out through ACESOutputMat.
 *
 * The two curves are not a shade apart. Narkowicz is markedly brighter through the
 * midtones, which is exactly where an interior scene lives, and it is a large part of a
 * measured ~1.7x that survived correcting the colour space and the missing Lambert pi.
 * An approximation of a standard is the wrong thing to hold when the standard is the
 * specification.
 */
vec3 rrtAndOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 x) {
  /*
   * Exposure first, because a tone curve is only defined relative to one.
   *
   * The reference RRT and ODT are graded for a dark cinema. Every renderer that ships ACES
   * scales its input to suit whatever it is actually shown on, and the factor each one
   * picks is a *look*, not a standard - so this engine takes no position and reads it from
   * the caller. Neutral by default, which is the reference grade unmodified. three.js's own
   * pick is 1 / 0.6, for a consumer matching one.
   */
  x *= uOutputExposure;
  // Columns, as GLSL reads them: sRGB -> XYZ -> D65_2_D60 -> AP1 -> RRT_SAT.
  const mat3 ACES_INPUT = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  // ODT_SAT -> XYZ -> D60_2_D65 -> sRGB.
  const mat3 ACES_OUTPUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  return clamp(ACES_OUTPUT * rrtAndOdtFit(ACES_INPUT * x), 0.0, 1.0);
}

/*
 * Linear to sRGB. The piecewise form rather than a plain pow: the linear toe near black
 * is where banding lives in an 8-bit buffer, and the cheap approximation puts it in the
 * wrong place.
 */
vec3 linearToSrgb(vec3 c) {
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, step(c, vec3(0.0031308)));
}

vec3 applyOutputTransform(vec3 c) {
  if (uOutputTransform == 0) return c;
  if (uOutputTransform == 2) c = acesFilmic(c);
  return linearToSrgb(c);
}
`;
