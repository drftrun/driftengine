/**
 * The screen-space reflection resolve: what the trace found, composited over the scene.
 *
 * **One fetch, because the compositing is the blend state.** The trace writes premultiplied colour
 * and coverage into a target of its own — it has to, since it samples the scene and a pass that
 * read the colour it was writing would be a feedback loop — and this hands those texels to a
 * `(one, one-minus-src-alpha)` blend, which is `over`. So the resolve never samples the target it
 * is compositing onto, which is the arrangement `oitResolve.ts` reaches by the same argument.
 *
 * Premultiplied is what makes several reflective surfaces overlapping accumulate the way two
 * blended layers do rather than the way two independent guesses do.
 *
 * The vertex stage is `FULLSCREEN_VERT`, shared with the occlusion pass, its blur and the rush.
 */
export const SSR_RESOLVE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** Premultiplied reflection in rgb, coverage in a. Cleared to zero: nothing found is nothing. */
uniform sampler2D uSsrReflection;

out vec4 fragColor;

void main() {
  fragColor = textureLod(uSsrReflection, vUv, 0.0);
}
`;

/**
 * The resolve for a trace of the frame's materials: **the probe's share of each pixel swapped for
 * what the ray found**, by the weight the lit stage reflected with.
 *
 * The frame holds `environment · tint · weight` of the probe (`flat/reflectionSurface.ts`), and a
 * reflection found in the frame belongs there with the same tint and weight. So the frame gains the
 * found colour times the tint, less the probe's share, both scaled by how far the hit is believed —
 * nothing where nothing was found, and the probe kept wherever the ray left the frame. Added, against
 * a blend of `(one, one)` on the colour and the scene's alpha kept, onto a half-float scene, where a
 * negative addend is the subtraction it reads as.
 *
 * **Blurred by the surface's roughness**, twelve taps on two rings whose radius is the roughness
 * times `uSsrBlur` texels: the trace reads the scene at one point, which is a mirror, and a satin
 * panel reflects a smear. What it gives up is a lobe's true shape and its stretch toward a grazing
 * view; what it keeps is that a rougher panel reflects a softer picture, and a mirror a sharp one.
 */
export const SSR_MATERIAL_RESOLVE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** The found colour times how far it is believed in rgb, the belief in a. */
uniform sampler2D uSsrReflection;
/** The environment as the frame shows it, the roughness in a. */
uniform sampler2D uSsrProbeMap;
/** What a found reflection is multiplied by to land where the environment did. */
uniform sampler2D uSsrTintMap;
/** x, y: one texel of the trace; z: the blur's radius at roughness 1, in texels. */
uniform vec3 uSsrBlur;

out vec4 fragColor;

void main() {
  vec4 probe = textureLod(uSsrProbeMap, vUv, 0.0);
  vec3 tint = textureLod(uSsrTintMap, vUv, 0.0).rgb;
  vec4 traced = textureLod(uSsrReflection, vUv, 0.0);
  float radius = probe.a * uSsrBlur.z;
  if (radius >= 1.0) {
    vec4 sum = traced;
    for (int i = 0; i < 12; i++) {
      /* Six taps a ring, sixty degrees apart, the inner ring turned half a step. */
      float angle = float(i % 6) * 1.0471976 + (i < 6 ? 0.0 : 0.5235988);
      float reach = i < 6 ? radius : radius * 0.5;
      vec2 offset = vec2(cos(angle), sin(angle)) * reach * uSsrBlur.xy;
      sum += textureLod(uSsrReflection, vUv + offset, 0.0);
    }
    traced = sum / 13.0;
  }
  fragColor = vec4(traced.rgb * tint - traced.a * probe.rgb, 0.0);
}
`;
