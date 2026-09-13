import { FOG_GLSL } from './fog.ts';

/**
 * A thin, wet, iridescent film lying on a surface.
 *
 * The material an oil slick is made of, described without knowing what oil is.
 * Flat dark geometry cannot do this job — it reads as a hole in the world, which
 * is exactly how the first version looked. What makes a film read as *wet* is
 * that it changes with the angle you see it from: almost black looking straight
 * down, and a shifting sheen at a glance.
 *
 * Textureless, per the standing rule. The iridescence is a hue swept by the
 * view angle plus a slow travelling ripple, both evaluated per fragment; the
 * rainbow is generated rather than sampled.
 */
export const FILM_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
/*
 * Coverage, on the attribute the mesh format calls emissive.
 *
 * A film has no use for self-illumination, and it very much needs an edge that
 * dissolves: the first oil was flat squares, and a hard straight edge is what made
 * it read as a decal dropped on the world rather than a puddle lying in it. One
 * float per vertex, 1 in the middle of a slick and 0 at its rim.
 */
layout(location = 3) in float aCoverage;

uniform mat4 uViewProj;
/* The mirrored camera's projection, so a film can sample the planar target the way water does. */
uniform mat4 uReflectionViewProj;

out vec3 vWorld;
out vec3 vNormal;
out vec3 vTint;
out vec4 vReflectionClip;
out float vCoverage;

void main() {
  vWorld = aPosition;
  vNormal = normalize(aNormal);
  vTint = aColor;
  vCoverage = aCoverage;
  vReflectionClip = uReflectionViewProj * vec4(aPosition, 1.0);
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const FILM_FRAG = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vNormal;
in vec3 vTint;
in vec4 vReflectionClip;
/*
 * The scene mirrored across the plane this film lies on, and how much of it to show.
 *
 * **Sheen is iridescence and this is the image**, which is the split a consumer asked for after
 * finding that raising sheen to make a road wetter only made it oilier. A wet street at night is
 * defined by everything above it appearing twice, and no amount of interference pattern is that.
 *
 * The projection is the water shader's, unchanged and deliberately so: reproducing it outside the
 * engine is the piece most likely to be subtly wrong and least likely to be noticed, since a
 * mirror off by a small skew looks like a wet road until somebody puts a straight line across it.
 */
uniform sampler2D uReflectionMap;
uniform int uReflectionEnabled;
uniform float uReflectionStrength;
in float vCoverage;

uniform vec3 uCameraPos;
uniform float uTime;
/*
 * The mirrored pass clips at the water plane, and it does so **in the fragment
 * shader** rather than with gl_ClipDistance.
 *
 * That is not a style choice. Clip distances in WebGL2 need
 * EXT_clip_cull_distance both enabled on the context and declared with an
 * #extension line, and without the declaration the shader fails to *compile* —
 * which, since programs are built when the renderer is constructed, takes the
 * whole boot with it and leaves a black screen. This shader had never been
 * compiled when it was written, so the mistake sat harmlessly in the file until
 * the day it was wired to something. Discarding is what flat.ts does, it needs
 * no extension, and a film is a thin translucent layer where the cost of a
 * discarded fragment is nothing.
 */
uniform vec4 uClipPlane;
uniform int uClipEnabled;
${FOG_GLSL}
/** How strong the sheen is. Zero leaves a plain dark film. */
uniform float uSheen;

/**
 * How rough the film's own surface is, 0 to 1, and how coarse that roughness is.
 *
 * **A film had exactly one finish before this: mirror.** That is right for standing water and
 * wrong for the thing this pass is most used for, because a wet road is not a mirror — it is
 * water lying *in* aggregate, and the stone underneath breaks the reflection into a smear. With
 * no way to say so, a patch of film over a textured road met it at a hard rim: mirror on one
 * side, stone on the other, with nothing able to cross it. Feathering the coverage cannot fix
 * that, and it was tried — the alpha was never what the eye was reading.
 *
 * So the reflection is displaced by a noise field rather than blurred. **Displaced, because a
 * blur is the wrong phenomenon**: a rough surface does not soften what it reflects, it scatters
 * it, and a lamp on wet tarmac smears into a streak rather than becoming a soft disc. It is also
 * what a blur cannot afford here — the mirror has no mip chain (see the \`textureLod\` note
 * below), so softening it honestly would cost several taps where this costs none.
 *
 * \`uFilmRoughnessCycles\` is bumps to the metre, and it is the same quantity
 * \`Renderer.setSurfaceRelief\` takes. **Matching it to the surface underneath is the point**:
 * given the same field at the same scale, the water is broken up by the aggregate that the dry
 * road beside it is showing, and the two stop being different materials.
 *
 * Zero is the mirror this pass has always been, exactly, so nothing that does not ask for
 * roughness renders differently.
 */
uniform float uFilmRoughness;
uniform float uFilmRoughnessCycles;

out vec4 fragColor;

/** A hue wheel, without a texture. Standard 6-segment ramp. */
vec3 hue(float h) {
  h = fract(h) * 6.0;
  vec3 c = clamp(vec3(abs(h - 3.0) - 1.0, 2.0 - abs(h - 2.0), 2.0 - abs(h - 4.0)), 0.0, 1.0);
  return c;
}

/**
 * The same value noise \`flat.ts\` builds its relief from, and deliberately the same.
 *
 * Copied rather than shared because these two shaders have no common include beyond the fog, and
 * a film that used a *different* field would defeat the whole purpose of taking a cycle count:
 * the water would be broken up by one pattern and the road by another, which is two materials
 * again with extra steps.
 */
float filmHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float filmNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(filmHash(i + vec3(0.0, 0.0, 0.0)), filmHash(i + vec3(1.0, 0.0, 0.0)), u.x),
      mix(filmHash(i + vec3(0.0, 1.0, 0.0)), filmHash(i + vec3(1.0, 1.0, 0.0)), u.x),
      u.y
    ),
    mix(
      mix(filmHash(i + vec3(0.0, 0.0, 1.0)), filmHash(i + vec3(1.0, 0.0, 1.0)), u.x),
      mix(filmHash(i + vec3(0.0, 1.0, 1.0)), filmHash(i + vec3(1.0, 1.0, 1.0)), u.x),
      u.y
    ),
    u.z
  );
}

void main() {
  if (uClipEnabled != 0 && dot(vec4(vWorld, 1.0), uClipPlane) < 0.0) discard;

  vec3 view = normalize(uCameraPos - vWorld);
  float facing = max(dot(normalize(vNormal), view), 0.0);
  /*
   * Fresnel-ish: dark looking straight down at it, bright at a grazing angle.
   * This is the whole effect — it is what makes a wet patch look wet rather
   * than looking like a patch of dark paint.
   */
  float grazing = pow(1.0 - facing, 3.0);

  /*
   * A slow travelling interference, so the sheen crawls rather than sitting
   * still. Two frequencies that do not divide each other, or the pattern
   * repeats visibly across a long slick.
   */
  float ripple =
    sin(vWorld.x * 0.73 + vWorld.z * 0.41 + uTime * 0.55) *
    cos(vWorld.z * 0.91 - vWorld.x * 0.29 - uTime * 0.37);

  vec3 sheen = hue(grazing * 1.35 + ripple * 0.14 + 0.55);
  /*
   * Dark underneath, so the film always reads as *less* than the surface it lies on even where
   * the sheen is strongest — but not so dark that it disappears.
   *
   * A slick that has just launched somebody has to be findable afterwards. It was rounded,
   * feathered and iridescent — and at a fifth of an opaque tint on a pale deck at dusk,
   * invisible. A hazard you cannot find is not a hazard, it is a trap.
   *
   * So the base is darker and the sheen has a floor: even looking straight down, where the
   * Fresnel term is nearly nothing, a slick is a distinctly wet patch rather than a faint one.
   */
  vec3 base = vTint * 0.9;
  vec3 color = base + sheen * uSheen * (0.22 + grazing * 0.75);

  /*
   * The mirrored scene, under the sheen rather than instead of it.
   *
   * Screen-space from the mirrored clip position, exactly as the water pass does it, with the
   * same fade as the sample leaves the target: a reflection that stopped dead at the edge of its
   * own buffer would draw a line across the road where nothing is.
   *
   * Weighted by the grazing term as well as by strength, because that is what a reflection does:
   * a wet surface underfoot shows almost nothing and the same surface down the street shows the
   * whole scene. Added before the fog so the image recedes with everything else in the frame.
   */
  if (uReflectionEnabled != 0 && uReflectionStrength > 0.0 && vReflectionClip.w > 0.0) {
    vec2 reflectionUv = vReflectionClip.xy / vReflectionClip.w * 0.5 + 0.5;
    vec2 border = min(reflectionUv, 1.0 - reflectionUv);
    float valid = smoothstep(0.0, 0.025, min(border.x, border.y));
    /*
     * An explicit level, not an implicit one, and the branch above is the whole reason.
     *
     * An implicit derivative inside control flow that is not provably uniform is what lets a
     * compiler flatten the branch and pay for every arm — AGENTS.md, 2026-08-07 — and WGSL
     * does not merely warn: the module fails to compile with "textureSample must only be
     * called from uniform control flow", which invalidates the pipeline, which invalidates
     * the command buffer, and the frame still presents. The fifth time on this branch. The
     * mirror has no mip chain, so level 0 is the only level there is; the water shader
     * reaches the same conclusion for the same lookup.
     */
    /*
     * The aggregate under the water, as a displacement of what the water shows.
     *
     * The gradient of the same field the road's relief uses, taken across the surface and used
     * to push the lookup. **Stretched along the reflection rather than isotropic**, and that is
     * the half that makes it read as a road: a reflection on a rough horizontal surface smears
     * *towards the viewer*, because a bump tilts the ray in the plane it is already travelling
     * in. Displacing in a circle gives frosted glass instead, which is a different wet thing.
     *
     * Scaled by the grazing term for the same reason the mirror is: looking straight down at a
     * puddle the reflection is compressed into almost nothing and a displacement of it would be
     * enormous, so the scatter has to fall off exactly where the image does.
     */
    if (uFilmRoughness > 0.0) {
      vec3 at = vWorld * uFilmRoughnessCycles;
      float here = filmNoise(at);
      vec2 slope = vec2(
        filmNoise(at + vec3(0.5, 0.0, 0.0)) - here,
        filmNoise(at + vec3(0.0, 0.0, 0.5)) - here
      );
      /* Along the view, which on a horizontal film is where the image runs. */
      vec2 along = normalize(vec2(view.x, view.z) + vec2(1e-5, 0.0));
      vec2 smear = along * dot(slope, along) * 3.0 + slope * 0.35;
      reflectionUv += smear * uFilmRoughness * 0.016 * (0.2 + grazing * 0.8);
      /* Re-fade at the border: a displaced sample can leave the target the original did not. */
      vec2 movedBorder = min(reflectionUv, 1.0 - reflectionUv);
      valid = min(valid, smoothstep(0.0, 0.025, min(movedBorder.x, movedBorder.y)));
    }
    vec3 mirrored = textureLod(uReflectionMap, clamp(reflectionUv, 0.0, 1.0), 0.0).rgb;
    color = mix(color, mirrored, valid * uReflectionStrength * (0.25 + grazing * 0.75));
  }

  // The same fog every other pass applies — and now literally the same code, which
  // it was not: this ran its own curve while claiming otherwise, so a slick receded
  // at a different rate than the deck it was lying on.
  float fog = mediumFog(length(uCameraPos - vWorld), vWorld.y);
  color = mix(color, mediumColor(), fog);

  /*
   * Alpha from coverage, squared.
   *
   * Squared because a linear ramp across the rim still reads as a visible band —
   * the eye finds the constant-gradient edge. Squaring pushes the falloff outward
   * so the slick has a soft shoulder and no perceptible boundary. The sheen fades
   * with it, which is right: the thinnest part of a film is the least iridescent.
   */
  /*
   * Alpha from coverage, and the rim is what is squared — not the whole patch.
   *
   * Squaring the coverage outright made the *middle* translucent too, which is most of why a
   * slick could not be found. The shoulder still needs to be soft, so the square is mixed in
   * near the edge only: solid through the body, dissolving at the rim.
   */
  float coverage = clamp(vCoverage, 0.0, 1.0);
  float alpha = mix(coverage * coverage, coverage, 0.65) * 0.92;
  fragColor = vec4(color, alpha);
}
`;
