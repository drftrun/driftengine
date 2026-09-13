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
