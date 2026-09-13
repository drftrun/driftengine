/**
 * The temporal resolve: this frame blended into where the last one was.
 *
 * **Antialiasing by moving the camera instead of by multiplying the fill rate.** The projection is
 * shifted a fraction of a pixel each frame, so an edge that fell one side of a pixel centre falls
 * the other side next frame; blending the two puts the edge where it actually is. What MSAA buys
 * inside a frame this buys across frames, for one extra texture and one extra fullscreen pass —
 * which is the trade a browser target wants, where MSAA on a float target is not free and on
 * WebGL2 is not always available at all.
 *
 * **The motion is the camera's, and that is a stated limit rather than an oversight.** The
 * reprojection matrix carries a pixel back through the previous view, which is exact for a static
 * world under a moving camera and wrong for a moving object under a still one. A velocity buffer
 * would fix the second, and it means a second colour attachment on the scene pass and every draw
 * path writing into it — the README carries that as its own gap. What stands in for it here is the
 * neighbourhood clip below, which rejects a history that no longer resembles what is around it;
 * that covers a moving object crossing a background of a different colour, and does not cover one
 * crossing a background of its own.
 *
 * The vertex stage is `FULLSCREEN_VERT`, shared with the occlusion pass, its blur and the rush.
 */
import { glslSceneDepthToNdc } from '../depthConvention.ts';

export const TEMPORAL_RESOLVE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** This frame, rasterised with the projection jittered by \`jitterOffset\`. */
uniform sampler2D uScene;
/** What this pass wrote last frame: resolved, and conceptually unjittered. */
uniform sampler2D uHistory;
/**
 * The frame's depth.
 *
 * **highp, and it is not decoration.** GLSL ES gives a fragment shader's samplers a default
 * precision of *lowp* whatever \`precision highp float\` says at the top of the file — that line
 * sets the default for float and not for a sampler. A lowp sampler may hand back eight bits, and
 * a depth buffer read at eight bits reprojects to visibly the wrong place. \`rush.ts\` carries the
 * same note for the same reason.
 */
uniform highp sampler2D uDepth;
/**
 * The previous view-projection times the inverse of this frame's, so one multiply carries a point
 * from this frame's clip space to the last one's.
 *
 * **Built from the unjittered matrices**, which is why the jitter is applied to a copy used only
 * for rasterising and never to the \`viewProj\` the renderer keeps. The history holds a resolved
 * picture that stands for the unjittered scene, so reprojecting into it through a jittered matrix
 * would look the sample up half a pixel from where it is and undo the accumulation it is trying to
 * build. Camera motion blur reads this same matrix and has a test on it.
 */
uniform mat4 uReprojection;
/** One texel of the target, for walking the neighbourhood. */
uniform vec2 uTexel;
/**
 * How much of the clipped history to keep, 0 to 1.
 *
 * **Zero is the whole switch.** The first frame, the frame after a resize and the frame after a
 * cut have nothing to sample, and they pass this as zero; so does a renderer with the effect off.
 * The branch on it is the first thing in \`main\`, so an untouched frame costs one compare and the
 * pass is not run at all when the effect is off.
 */
uniform float uHistoryBlend;

out vec4 fragColor;

/**
 * The colours actually present around this pixel this frame, as a box.
 *
 * Nine taps rather than five: the diagonals are what catch a thin edge running corner to corner,
 * which is exactly the geometry temporal antialiasing exists for, and a cross-shaped
 * neighbourhood lets a history through along it.
 *
 * **Every fetch is an explicit level.** An implicit derivative under a branch that is not provably
 * uniform fails to compile in WGSL, which invalidates the pipeline and the command buffer while
 * the frame still presents — a failure this repository has paid for more than once, and the reason
 * \`film.ts\` carries the same note.
 */
void neighbourhood(out vec3 lo, out vec3 hi) {
  lo = vec3(1e9);
  hi = vec3(-1e9);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 c = textureLod(uScene, vUv + vec2(float(x), float(y)) * uTexel, 0.0).rgb;
      lo = min(lo, c);
      hi = max(hi, c);
    }
  }
}

/**
 * \`history\` pulled into the box, along the line towards its centre.
 *
 * Clipped towards the centre rather than clamped per channel: a clamp moves each channel on its
 * own, so a history merely brighter than its surroundings lands on a corner of the box and comes
 * back a different hue, which reads as coloured fringing along every moving edge. Shortening the
 * whole offset by one ratio keeps the direction and changes only the length.
 *
 * The same arithmetic is \`clipToNeighbourhood\` in \`temporalAa.ts\`, which is where it is asserted
 * against numbers; the test beside this file asserts the shader still spells it this way.
 */
vec3 clipToNeighbourhood(vec3 history, vec3 lo, vec3 hi) {
  vec3 centre = (lo + hi) * 0.5;
  vec3 extent = (hi - lo) * 0.5;
  vec3 offset = history - centre;
  /* A channel with no extent cannot bound anything; the max below then answers for the others. */
  vec3 ratios = abs(offset) / max(extent, vec3(1e-7));
  float ratio = max(ratios.x, max(ratios.y, ratios.z));
  if (ratio <= 1.0) return history;
  return centre + offset / ratio;
}

void main() {
  vec3 current = textureLod(uScene, vUv, 0.0).rgb;

  /* Nothing to blend towards: the first frame, a resize, a cut, or the effect switched off. */
  if (uHistoryBlend <= 0.0) {
    fragColor = vec4(current, 1.0);
    return;
  }

  float depth = textureLod(uDepth, vUv, 0.0).r;
  vec4 clip = vec4(vUv * 2.0 - 1.0, ${glslSceneDepthToNdc('depth')}, 1.0);
  vec4 previous = uReprojection * clip;
  /* Behind the previous eye: there is no last-frame position to sample. */
  if (previous.w <= 0.0) {
    fragColor = vec4(current, 1.0);
    return;
  }

  vec2 wasUv = (previous.xy / previous.w) * 0.5 + 0.5;
  /*
   * **Off the edge of the last frame is a disocclusion**, and the honest answer is this frame's
   * colour rather than a clamped sample of the border, which would drag one row of pixels inward
   * as a smear for as long as the camera kept turning.
   */
  if (wasUv.x < 0.0 || wasUv.x > 1.0 || wasUv.y < 0.0 || wasUv.y > 1.0) {
    fragColor = vec4(current, 1.0);
    return;
  }

  vec3 lo;
  vec3 hi;
  neighbourhood(lo, hi);
  vec3 history = textureLod(uHistory, wasUv, 0.0).rgb;
  vec3 bounded = clipToNeighbourhood(history, lo, hi);

  fragColor = vec4(mix(current, bounded, uHistoryBlend), 1.0);
}
`;
