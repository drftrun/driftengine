/**
 * Bloom: the three stages of spreading a bright thing past its own pixels.
 *
 * **What it is for, in the words of the consumer who asked for it.** Nothing in this renderer
 * makes a bright thing look bright: an emissive surface is exactly as bright as its pixels and
 * not one pixel wider, so anything meant to overwhelm the eye has to be faked in geometry — a
 * core sphere, a second sphere slightly larger, and fifty-four additive particles standing in
 * for one pass. Every neon ring, lit poster, glyph band and shaft of daylight is the same
 * request.
 *
 * **It composes with the tone curve rather than replacing it.** The curve decides how a bright
 * pixel rolls off; this decides how far it spreads. So the result is added in linear scene
 * units, before the grade, and the grade then rolls off the sum exactly as it rolls off
 * anything else.
 *
 * **The threshold is in scene units, which is only meaningful with a target that keeps them.**
 * With an eight-bit target the scene is clipped to 0..1 before the composite ever sees it, so a
 * star and a sheet of white paper arrive as the same colour and a threshold can only mean
 * whiteness. That is the whole reason hdrScene exists and it is why bloom asks for it.
 *
 * Three stages, and the middle one repeats:
 *
 * 1. **Prefilter**, full resolution down to half: subtract the threshold and keep what is left.
 * 2. **Downsample**, halving each time, six levels or as many as the frame allows. Each level
 *    is an octave of the spread, and adding them back is what produces a wide falloff rather
 *    than one gaussian with a hard end.
 * 3. **Upsample**, additively back up the chain through a tent filter.
 *
 * Deliberately absent, because they were asked against by name: lens dirt, anamorphic streaks
 * and ghosting. One threshold, one radius, one strength.
 */

/**
 * The thirteen taps every downsampling stage shares, decomposed into five overlapping boxes.
 *
 * Shared as a string rather than copied, because the prefilter and the plain downsample differ
 * only in how they weight these boxes and what they do to each tap on the way in. Both call a
 * fetch the shader itself defines, which is the seam: the prefilter thresholds there and the
 * downsample does not.
 *
 * **Thirteen rather than four.** A bilinear box halving is one tap and it aliases: a bright
 * pixel that lands between two texels flickers between them as the camera moves, which is the
 * exact failure bloom is most often blamed for. The thirteen-tap arrangement samples the ring
 * that a plain box misses, and the boxes overlap so no source pixel is ever weighted zero.
 *
 * Offsets are in source texels, so uTexel is one over the *source* size rather than the target.
 */
const BLOOM_BOXES = `
  vec2 t = uTexel;
  vec3 a = fetch(vUv + vec2(-2.0,  2.0) * t);
  vec3 b = fetch(vUv + vec2( 0.0,  2.0) * t);
  vec3 c = fetch(vUv + vec2( 2.0,  2.0) * t);
  vec3 d = fetch(vUv + vec2(-2.0,  0.0) * t);
  vec3 e = fetch(vUv);
  vec3 f = fetch(vUv + vec2( 2.0,  0.0) * t);
  vec3 g = fetch(vUv + vec2(-2.0, -2.0) * t);
  vec3 h = fetch(vUv + vec2( 0.0, -2.0) * t);
  vec3 i = fetch(vUv + vec2( 2.0, -2.0) * t);
  vec3 j = fetch(vUv + vec2(-1.0,  1.0) * t);
  vec3 k = fetch(vUv + vec2( 1.0,  1.0) * t);
  vec3 l = fetch(vUv + vec2(-1.0, -1.0) * t);
  vec3 m = fetch(vUv + vec2( 1.0, -1.0) * t);

  vec3 box0 = (a + b + d + e) * 0.25;
  vec3 box1 = (b + c + e + f) * 0.25;
  vec3 box2 = (d + e + g + h) * 0.25;
  vec3 box3 = (e + f + h + i) * 0.25;
  vec3 box4 = (j + k + l + m) * 0.25;
`;

/**
 * How bright a colour is, for the purpose of deciding whether it blooms.
 *
 * **The largest channel rather than luminance, and that is a correction rather than a
 * preference.** Luminance weights green at 0.7152 and blue at 0.0722, so a saturated source is
 * dim by that measure however far past white it actually is: a pure blue at 1.4, which clips the
 * display's blue and is unambiguously a light rather than a surface, has a luminance of 0.101
 * and cannot reach a threshold of 1 at all. It would need to reach 13.8 to try.
 *
 * That was shipped, and it was found from outside by the consumer who asked for bloom in the
 * first place: two of their worlds are built entirely out of coloured light, and both bloomed by
 * **zero pixels of 921,600** with the effect on and the threshold meaning exactly what it says.
 * Everything switched on, nothing wrong, and nothing happening, which is the failure this
 * repository has now shipped three times under different names.
 *
 * The largest channel makes the threshold mean what a reader already thinks it means: past
 * white. It can only ever bloom *more*, never less, because the largest channel of a colour is
 * never below its luminance, and the two are exactly equal on any neutral grey — so a scene lit
 * in white is unchanged by this and a scene lit in colour is fixed by it. What it costs is that
 * a strongly red surface driven past white in red alone now blooms where a grey of the same
 * luminance does not, which is the honest reading of "this channel is off the top of the range".
 *
 * The ratio is applied to all three channels rather than per channel, so the hue of the halo is
 * the hue of the thing that cast it. Subtracting the threshold per channel is the other way to
 * write this and it turns a warm white into an orange halo, which is a filter's look rather than
 * a light's.
 */
const BLOOM_BRIGHTNESS = `
float brightness(vec3 c) {
  return max(c.r, max(c.g, c.b));
}
`;

/**
 * Stage one: threshold the scene and halve it.
 *
 * **Subtracted rather than stepped**, which is what keeps one number honest. A hard cut at the
 * threshold puts a visible edge through any gradient that crosses it, and repairing that is
 * where a second knob usually arrives. Scaling the colour by how far its own luminance sits
 * past the threshold is continuous, starts at exactly nothing, and needs no knee: a pixel just
 * over the line contributes almost none of itself, and one far over contributes nearly all.
 *
 * **The boxes are averaged by the Karis weighting here and nowhere else.** A single pixel far
 * brighter than its neighbours — which this renderer produces, on glossy dark paint, and which
 * STATUS 6.3 measures — would otherwise be spread into a visible blob by the very pass whose
 * job is to spread bright things. Weighting each box by 1 / (1 + luma) before averaging makes
 * one runaway pixel count for little against its four neighbours. It is applied only to the
 * first stage because it is not energy-preserving, and running it down the whole chain darkens
 * every large bright area rather than only taming isolated ones.
 */
export const BLOOM_PREFILTER_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uSource;
/** One source texel in UV. The thirteen taps are laid out in source texels. */
uniform vec2 uTexel;
/** In scene units. 1.0 is "brighter than white", which is the useful place to start. */
uniform float uThreshold;

out vec4 fragColor;

/**
 * A ceiling on what any one pixel may contribute, well above anything a scene means.
 *
 * Not a look control. A half-float target can hold an infinity, and an infinity through the
 * threshold below is inf/inf, which is a NaN that the chain then spreads across the whole
 * frame — the one failure mode where a post pass destroys the picture rather than degrading
 * it. Anything above this is indistinguishable after the tone curve anyway.
 */
const float BLOOM_CEILING = 256.0;
${BLOOM_BRIGHTNESS}
vec3 fetch(vec2 uv) {
  vec3 c = min(textureLod(uSource, uv, 0.0).rgb, vec3(BLOOM_CEILING));
  float bright = brightness(c);
  return c * (max(bright - uThreshold, 0.0) / max(bright, 1e-4));
}

/** How much a box counts for. A runaway pixel drags its box's brightness up and its weight down. */
float firefly(vec3 c) {
  return 1.0 / (1.0 + brightness(c));
}

void main() {
${BLOOM_BOXES}
  float w0 = firefly(box0) * 0.125;
  float w1 = firefly(box1) * 0.125;
  float w2 = firefly(box2) * 0.125;
  float w3 = firefly(box3) * 0.125;
  float w4 = firefly(box4) * 0.5;
  vec3 sum = box0 * w0 + box1 * w1 + box2 * w2 + box3 * w3 + box4 * w4;
  fragColor = vec4(sum / max(w0 + w1 + w2 + w3 + w4, 1e-4), 1.0);
}
`;

/**
 * Stage two: halve what is already thresholded, once per level.
 *
 * The weights sum to exactly one, so each level holds the average of what fed it and the chain
 * neither gains nor loses light. Nothing is thresholded again: that decision was made once, at
 * full resolution, where it could still be made per pixel.
 */
export const BLOOM_DOWNSAMPLE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uSource;
uniform vec2 uTexel;

out vec4 fragColor;

vec3 fetch(vec2 uv) {
  return textureLod(uSource, uv, 0.0).rgb;
}

void main() {
${BLOOM_BOXES}
  fragColor = vec4(box4 * 0.5 + (box0 + box1 + box2 + box3) * 0.125, 1.0);
}
`;

/**
 * Stage three: a 3x3 tent, added into the level above.
 *
 * **Additive rather than a mix, and each octave counts the same.** A lone bright pixel arrives
 * at level n divided by four to the n, spread over four to the n pixels, so summing the levels
 * lifts its own pixel by about a third and lays a long shallow tail around it. That falloff is
 * what a real glare looks like; a single gaussian gives a disc with an end to it.
 *
 * The radius is in UV rather than in texels, so it is the same fraction of the frame at every
 * level and on every display. A tent rather than a box because the seams between the four
 * texels a bilinear upsample reads are otherwise visible as a grid on a wide, faint halo.
 */
export const BLOOM_UPSAMPLE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uSource;
/** How far the tent reaches, in UV. One number for the whole chain. */
uniform float uRadius;

out vec4 fragColor;

void main() {
  float r = uRadius;
  vec3 a = textureLod(uSource, vUv + vec2(-r,  r), 0.0).rgb;
  vec3 b = textureLod(uSource, vUv + vec2(0.0, r), 0.0).rgb;
  vec3 c = textureLod(uSource, vUv + vec2( r,  r), 0.0).rgb;
  vec3 d = textureLod(uSource, vUv + vec2(-r, 0.0), 0.0).rgb;
  vec3 e = textureLod(uSource, vUv, 0.0).rgb;
  vec3 f = textureLod(uSource, vUv + vec2( r, 0.0), 0.0).rgb;
  vec3 g = textureLod(uSource, vUv + vec2(-r, -r), 0.0).rgb;
  vec3 h = textureLod(uSource, vUv + vec2(0.0, -r), 0.0).rgb;
  vec3 i = textureLod(uSource, vUv + vec2( r, -r), 0.0).rgb;

  vec3 sum = e * 4.0 + (b + d + f + h) * 2.0 + (a + c + g + i);
  fragColor = vec4(sum * 0.0625, 1.0);
}
`;
