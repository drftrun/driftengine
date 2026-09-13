/** The convolutions that fill one level of one probe layer, reflection and ambient alike. */

import { OCTAHEDRAL_GLSL } from './octahedral.ts';

/**
 * One level of one probe layer, convolved with the lobe that level stands for.
 *
 * **Directions, not texture coordinates**, for the same reason the mip blit it replaces used
 * them: the neighbouring texels across a cube edge belong to a different face, and taking them
 * from the same face is exactly how a seam appears along every edge. The fragment rebuilds the
 * direction its texel stands for and samples the cube, which crosses edges the way the hardware
 * does when the shader reads it back later.
 *
 * **The target is one octahedral layer rather than six cube faces**, so a level is one draw
 * instead of six and there is no face basis at all — `octInsetDir` turns a texel into the
 * direction it holds, and in the level's one-texel gutter that direction is the folded one. The
 * source stays a cube, which is what `sourceLevelForSample`'s six-face solid angle assumes.
 *
 * **Two kernels, one pass.** Levels up to the GGX chain's top convolve against the lobe; the level
 * above it convolves against the cosine and is the scene's diffuse ambient. They differ in the
 * weight and in nothing else, so `uPrefilterIrradiance` chooses between them and the whole rest of
 * the shader is shared. That fold is what lets one binding carry both terms and keeps the last
 * texture unit free.
 *
 * **It samples a cube and writes an array, which are different objects by construction.**
 * `uPrefilterSource` is the captured probe with its box-filtered chain, and it is one scratch cube
 * reused by every probe in the grid rather than one per layer. That buys two things: WebGL2's
 * feedback-loop check is per texture object, so a draw sampling the source while a layer of the
 * target is attached never arises; and a level is never convolved from a level that was already
 * convolved, which applies the lobe twice and compounds up the chain.
 *
 * **The approximation, stated because it is the one people are surprised by.** This is the split
 * of the specular integral everybody uses: the view direction is assumed equal to the normal and
 * to the reflection direction, so a level cannot know about stretched grazing highlights and a
 * rough metal seen edge-on reflects a slightly rounder lobe than it should. That is what buys a
 * bake that depends on roughness alone rather than on roughness and view angle, which is the
 * difference between one cube and a cube per camera. **What would make it wrong** is a scene
 * where grazing metal is the subject rather than incidental.
 */
export const PREFILTER_FRAG = `#version 300 es
precision highp float;

${OCTAHEDRAL_GLSL}

in vec2 vUv;

/** The captured probe, box-filtered, which this convolves. Never the cube being written. */
uniform highp samplerCube uPrefilterSource;

/**
 * The edge of the level being written, in texels, which is what the inset is derived from.
 *
 * The level's own size rather than the array's, because a gutter is one texel at every level and
 * its share of the map therefore doubles as the chain coarsens. A base edge passed here instead
 * would inset every level by the base's fraction, which is a fifth of a texel at the top of the
 * chain and reads as the reflection sliding as roughness rises.
 */
uniform float uPrefilterEdge;

/** 1 on the level holding the cosine convolution, 0 on every level of the reflection chain. */
uniform float uPrefilterIrradiance;

/**
 * 1 when the reflection chain is a box filter rather than a GGX convolution.
 *
 * RenderQuality.environmentPrefilter is off by default, and that default is a correction rather
 * than a preference: the prefilter shipped wired straight into the lit pass and changed the
 * picture of every consumer that had a probe, which was reported as metals reading opaque. A
 * profile that has not asked for the lobe chain must get the same reflection it had before probes
 * moved into an array, so the box arm exists and is what that profile bakes.
 *
 * The array edge is twice the source cube's face, so one array level matches one cube level in
 * angular density and the box arm is a single fetch at the same index. There is no second
 * texture: the flag decides what is convolved into the layer rather than which of two chains is
 * bound, so it is read at bake time and a profile that changes it has to bake again.
 */
uniform float uPrefilterBox;

/** The level being written, for the box arm, which reads the source chain at the same index. */
uniform float uPrefilterLevel;

/** The roughness this level stands for, from roughnessForLevel. 0 is a mirror. */
uniform float uPrefilterRoughness;
/** Samples per texel, from PREFILTER_SAMPLE_COUNTS. A power of two; see the count's own note. */
uniform float uPrefilterSamples;
/** The source cube's face width in texels, for the solid-angle comparison below. */
uniform float uPrefilterSourceTexels;
/** The source chain's top level, so a wide sample cannot ask for a level that is not there. */
uniform float uPrefilterSourceMaxLod;

out vec4 fragColor;

const float PI = 3.14159265359;

/**
 * The radical inverse of a 32-bit integer, base two: the second dimension of a Hammersley set.
 *
 * A bit reversal, written as the standard five-shift sequence rather than a loop, because a loop
 * over 32 bits per sample per texel is the one place in a bake where the arithmetic is the cost.
 * **This is why every sample count is a power of two** — the sequence's stratification is only
 * even when the count is, and an uneven one shows as a faint directional bias in a rough level
 * rather than as an error anybody would notice.
 */
float radicalInverse(uint bits) {
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}

/**
 * A half vector drawn from the GGX distribution about the normal, for one Hammersley pair.
 *
 * Importance sampling rather than a uniform hemisphere: at low roughness the lobe occupies a
 * vanishing fraction of the hemisphere, so uniform samples would put almost every one of them
 * where the weight is zero and the few that land in the lobe would carry all the variance.
 */
vec3 importanceSampleGgx(vec2 xi, vec3 n, float roughness) {
  float a = roughness * roughness;

  float phi = 2.0 * PI * xi.x;
  float cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  float sinTheta = sqrt(1.0 - cosTheta * cosTheta);

  vec3 h = vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);

  /*
   * Any tangent will do as long as it is not parallel to the normal, and the choice of which
   * axis to cross against has to depend on the normal or it degenerates at the poles — which is
   * one face of six coming out as noise, on the two faces the axis points at.
   */
  vec3 up = abs(n.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangentX = normalize(cross(up, n));
  vec3 tangentY = cross(n, tangentX);

  return normalize(tangentX * h.x + tangentY * h.y + n * h.z);
}

/**
 * A direction drawn from the cosine lobe about the normal, for the diffuse level.
 *
 * **Cosine-weighted, which is what makes the estimator a plain mean.** Irradiance is
 * integral of L cos(theta), the cosine pdf is cos(theta) / pi, so the estimate is
 * pi / N * sum(L) — and what the lit pass wants is radiance rather than irradiance, so the pi
 * divides straight back out. irradianceSh.ts folds the same division into its band factors and
 * says so, which is what makes a grid of one reproduce what the projection produced.
 */
vec3 importanceSampleCosine(vec2 xi, vec3 n) {
  float phi = 2.0 * PI * xi.x;
  float cosTheta = sqrt(max(1.0 - xi.y, 0.0));
  float sinTheta = sqrt(xi.y);

  vec3 h = vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);

  vec3 up = abs(n.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangentX = normalize(cross(up, n));
  vec3 tangentY = cross(n, tangentX);

  return normalize(tangentX * h.x + tangentY * h.y + n * h.z);
}

/** Trowbridge-Reitz, in its own normalisation, because this is a probability rather than a look. */
float ggxDistribution(float ndh, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-8);
}

void main() {
  vec3 n = octInsetDir(vUv, uPrefilterEdge);

  float texelSolidAngle = 4.0 * PI / (6.0 * uPrefilterSourceTexels * uPrefilterSourceTexels);

  /*
   * The box chain, which is one fetch: the source's own level at the same index, resampled through
   * the octahedral mapping. It is what a profile that has not asked for the lobe chain gets, and
   * it is the picture every consumer with a probe already had.
   */
  if (uPrefilterBox > 0.5 && uPrefilterIrradiance <= 0.5) {
    fragColor = vec4(
      textureLod(uPrefilterSource, n, min(uPrefilterLevel, uPrefilterSourceMaxLod)).rgb,
      1.0
    );
    return;
  }

  /*
   * **The diffuse level, and it is a mean rather than a weighted sum.** Every cosine sample is
   * drawn with the weight already in its density, so there is nothing to accumulate a weight for
   * and nothing to divide by but the count. A sample below the horizon cannot occur, which is the
   * other half of why this arm has no continue in it.
   */
  if (uPrefilterIrradiance > 0.5) {
    vec3 diffuse = vec3(0.0);
    int cosineSamples = int(uPrefilterSamples);
    for (int i = 0; i < cosineSamples; i++) {
      vec2 xi = vec2(float(i) / uPrefilterSamples, radicalInverse(uint(i)));
      vec3 l = importanceSampleCosine(xi, n);
      /*
       * The same filtered importance sampling the reflection uses, against the cosine density.
       * A diffuse sample is wide — a sixth of the sphere at the median — so reading the base level
       * would carry a bright window through as a handful of fireflies in the ambient, which is the
       * one place they cannot be blurred out later.
       */
      float pdf = max(dot(n, l) / PI, 1e-4);
      float sampleSolidAngle = 1.0 / (uPrefilterSamples * pdf);
      float lod = clamp(
        0.5 * log2(sampleSolidAngle / texelSolidAngle),
        0.0,
        uPrefilterSourceMaxLod
      );
      diffuse += textureLod(uPrefilterSource, l, lod).rgb;
    }
    fragColor = vec4(diffuse / max(uPrefilterSamples, 1.0), 1.0);
    return;
  }

  /*
   * A mirror is a fetch rather than an integral, and it is a separate arm on purpose: at
   * roughness 0 the distribution is a delta, every importance sample collapses onto the same
   * direction, and the sum is one sample's worth of noise where the answer is exactly the texel.
   */
  if (uPrefilterRoughness <= 0.0) {
    fragColor = vec4(textureLod(uPrefilterSource, n, 0.0).rgb, 1.0);
    return;
  }

  vec3 sum = vec3(0.0);
  float weight = 0.0;

  int samples = int(uPrefilterSamples);
  for (int i = 0; i < samples; i++) {
    vec2 xi = vec2(float(i) / uPrefilterSamples, radicalInverse(uint(i)));
    vec3 h = importanceSampleGgx(xi, n, uPrefilterRoughness);
    vec3 l = normalize(2.0 * dot(n, h) * h - n);

    float ndl = dot(n, l);
    if (ndl <= 0.0) continue;

    /*
     * Filtered importance sampling. A sample covers 1 / (count * pdf) of the sphere; when that
     * is much wider than a texel, reading the base level lets a few very bright texels land in
     * some samples and not others, and the variance survives the average as fireflies. The half
     * in front of the logarithm is a length ratio against an area one — a level step doubles a
     * texel's width and quadruples its solid angle. sourceLevelForSample holds the same
     * arithmetic on the CPU and its test carries the hand-derived numbers.
     */
    float ndh = max(dot(n, h), 0.0);
    float pdf = max(ggxDistribution(ndh, uPrefilterRoughness) * 0.25, 1e-8);
    float sampleSolidAngle = 1.0 / (uPrefilterSamples * pdf);
    float lod = clamp(
      0.5 * log2(sampleSolidAngle / texelSolidAngle),
      0.0,
      uPrefilterSourceMaxLod
    );

    /*
     * textureLod rather than texture, and the 2026-08-07 rule is why: this fetch sits inside a
     * loop with a continue in it, which no compiler can prove uniform, and an implicit derivative
     * in non-uniform control flow is what lets a driver flatten the loop and cost every arm.
     * The level is wanted here anyway, so the rule costs nothing at all.
     */
    sum += textureLod(uPrefilterSource, l, lod).rgb * ndl;
    weight += ndl;
  }

  /*
   * Normalised by the accumulated weight rather than by the sample count, because samples with
   * a light below the horizon were skipped and dividing by the count would darken every rough
   * level by the fraction that missed — which reads as roughness losing energy and is exactly
   * the artefact uEnvironmentGain has been compensating for.
   */
  fragColor = vec4(sum / max(weight, 1e-4), 1.0);
}
`;
