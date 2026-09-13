/**
 * The order-independent transparency resolve: two buffers composited over the finished scene.
 *
 * **The accumulation holds a weighted sum and the revealage a product.** Dividing the summed
 * premultiplied colour by the summed weighted alpha gives the average colour the translucent
 * layers make; the revealage says how much of what is behind them still shows through. For a
 * single layer that reduces exactly to ordinary alpha blending, which is the anchor
 * "orderIndependent.ts" asserts against numbers.
 *
 * **The composite is done by the blend state rather than by reading the scene.** Drawn with
 * (ONE_MINUS_SRC_ALPHA, SRC_ALPHA) over the scene target, the hardware computes
 * average * (1 - reveal) + scene * reveal, which is the resolve — so this pass never samples the
 * colour it is compositing onto and cannot be caught reading a target it is also writing.
 *
 * The vertex stage is FULLSCREEN_VERT, shared with the occlusion pass, its blur and the rush.
 */
export const OIT_RESOLVE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** Weighted premultiplied colour in rgb, weighted alpha in a. Cleared to zero. */
uniform sampler2D uOitAccum;
/** What every layer let through, as a product. Cleared to one, so an untouched pixel is all scene. */
uniform sampler2D uOitReveal;

out vec4 fragColor;

void main() {
  vec4 accum = textureLod(uOitAccum, vUv, 0.0);
  float reveal = textureLod(uOitReveal, vUv, 0.0).r;

  /*
   * Guarded because a pixel no fragment touched has a weighted alpha of zero. Its revealage is
   * then one, so the blend discards whatever this produced anyway — but a division by zero would
   * put a NaN into the target first, and a NaN blended against anything stays a NaN.
   */
  vec3 average = accum.rgb / max(accum.a, 1e-5);

  fragColor = vec4(average, reveal);
}
`;
