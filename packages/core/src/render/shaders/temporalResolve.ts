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
import {
  FLICKER_BLEND,
  FLICKER_MEMORY,
  FLICKER_REPEAT,
  FLICKER_SURFACE,
  FLICKER_WIDTH,
  STILL_FROM,
  STILL_TO,
} from '../temporalAa.ts';

export const TEMPORAL_RESOLVE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** This frame, rasterised with the projection jittered by \`jitterOffset\`. */
uniform sampler2D uScene;
/** What this pass wrote last frame: resolved, and conceptually unjittered. */
uniform sampler2D uHistory;
/**
 * Each pixel's flicker record from last frame, the anti-flicker in temporalAa.ts: its spread about
 * its period's mean, the sum this period has gathered, the last period's mean, and how many periods
 * running have repeated. highp for the reason the depth's is: a luma in a half-float scene is not a
 * value from 0 to 1.
 */
uniform highp sampler2D uFlicker;
/**
 * The rest of the record: the view depth the pixel's sample stood at, so the next frame can tell
 * whether it follows the same surface, and the pixel's own depth swing, which that test allows for.
 */
uniform highp sampler2D uFlickerMotion;
/** The inverse projection's depth row and w row, as the other passes read a depth into metres. */
uniform vec4 uDepthToViewZ;
/** One where the records can hold what they hold, zero where they cannot: then 4.4.1's resolve. */
uniform float uAntiFlicker;
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
/** One on the first frame of the jitter's period, where the anti-flicker compares two periods. */
uniform float uPeriodStart;
/**
 * How much of the clipped history to keep, 0 to 1.
 *
 * **Zero is the whole switch.** The first frame, the frame after a resize and the frame after a
 * cut have nothing to sample, and they pass this as zero; so does a renderer with the effect off.
 * The branch on it is the first thing in \`main\`, so an untouched frame costs one compare and the
 * pass is not run at all when the effect is off.
 */
uniform float uHistoryBlend;

layout(location = 0) out vec4 fragColor;
/** The record carried out, in the texture uFlicker reads next frame. */
layout(location = 1) out vec4 flickerOut;
/** And the rest of it, in the texture uFlickerMotion reads. */
layout(location = 2) out vec4 flickerMotionOut;

const float FLICKER_MEMORY = ${FLICKER_MEMORY.toFixed(3)};
const float FLICKER_WIDTH = ${FLICKER_WIDTH.toFixed(1)};
const float FLICKER_REPEAT = ${FLICKER_REPEAT.toFixed(2)};
const float FLICKER_BLEND = ${FLICKER_BLEND.toFixed(2)};
const float FLICKER_SURFACE = ${FLICKER_SURFACE.toFixed(2)};
const float STILL_FROM = ${STILL_FROM.toFixed(2)};
const float STILL_TO = ${STILL_TO.toFixed(2)};

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

/** A record starting over: no spread, and nothing repeated yet. */
vec4 freshRecord(vec3 current) {
  float seen = luma(current);
  return vec4(0.0, seen * FLICKER_MEMORY, seen, 0.0);
}

/** Metres in front of the camera, from a depth sample, as depthOfField.ts reads one. */
float viewDepthOf(float depth) {
  float z = ${glslSceneDepthToNdc('depth')};
  return -(uDepthToViewZ.x * z + uDepthToViewZ.y) / (uDepthToViewZ.z * z + uDepthToViewZ.w);
}

/** Whether two periods' means are the same, one to zero. */
float repeats(float mean, float previous) {
  float apart = abs(mean - previous) / max(max(mean, previous), 1.0 / 255.0);
  return 1.0 - smoothstep(FLICKER_REPEAT, 2.0 * FLICKER_REPEAT, apart);
}

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

/*
 * **The history read through a Catmull-Rom filter, not a bilinear one.**
 *
 * The reprojection lands between texels nearly everywhere, and a bilinear fetch there is a small blur;
 * applied to a picture that is itself last frame's blend, it compounds every frame, so a still camera
 * settled on a picture measurably softer than one frame of it. A courtyard's stone read as out of
 * focus beside the same frame with the resolve off. Catmull-Rom passes a straight ramp through exactly
 * and keeps the edge between two texels an edge, which is what the history is for.
 *
 * Five bilinear fetches rather than sixteen point ones: the middle two weights of each axis share a
 * fetch placed between them, and the four corners, which carry a few hundredths, are left out and
 * the rest renormalised. Its negative lobes can ring past what the frame holds, which the
 * neighbourhood clip after it takes back, and the floor at zero keeps a float target out of the
 * negatives meanwhile.
 */
vec3 historyCatmullRom(vec2 uv) {
  vec2 size = 1.0 / uTexel;
  vec2 at = uv * size;
  vec2 base = floor(at - 0.5) + 0.5;
  vec2 f = at - base;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 at0 = (base - 1.0) * uTexel;
  vec2 at3 = (base + 2.0) * uTexel;
  vec2 at12 = (base + w2 / w12) * uTexel;
  vec3 sum =
    textureLod(uHistory, vec2(at12.x, at0.y), 0.0).rgb * (w12.x * w0.y) +
    textureLod(uHistory, vec2(at0.x, at12.y), 0.0).rgb * (w0.x * w12.y) +
    textureLod(uHistory, at12, 0.0).rgb * (w12.x * w12.y) +
    textureLod(uHistory, vec2(at3.x, at12.y), 0.0).rgb * (w3.x * w12.y) +
    textureLod(uHistory, vec2(at12.x, at3.y), 0.0).rgb * (w12.x * w3.y);
  float weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(sum / weight, vec3(0.0));
}

void main() {
  /*
   * **The alpha is this frame's and takes no history.** It is how much of the pixel is still the
   * opaque surface (sceneCoverage.ts), which the composite's occlusion reads after this has
   * replaced the scene, so it passes through untouched. The history is read for its colour alone.
   */
  vec4 sampled = textureLod(uScene, vUv, 0.0);
  vec3 current = sampled.rgb;
  float share = sampled.a;

  /* Nothing to blend towards: the first frame, a resize, a cut, or the effect switched off. */
  if (uHistoryBlend <= 0.0) {
    fragColor = vec4(current, share);
    flickerOut = freshRecord(current);
    flickerMotionOut = vec4(0.0);
    return;
  }

  /*
   * **The motion is the nearest surface's among the nine**, the dilation every temporal resolve
   * uses: a pixel at a thin thing samples it in some frames and what is behind it in others, and the
   * two move apart as the camera does, so reprojecting each frame by whichever it caught sends its
   * history and its record somewhere different every frame. A crack of light round a door moves with
   * the door that frames it, and so does its pixel. The depth kept is that surface's too, so the record
   * keeps and next frame tests the depth the reprojection followed.
   */
  vec2 nearestAt = vUv;
  float depth = textureLod(uDepth, vUv, 0.0).r;
  float metres = viewDepthOf(depth);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 at = vUv + vec2(float(x), float(y)) * uTexel;
      float tap = textureLod(uDepth, at, 0.0).r;
      float tapMetres = viewDepthOf(tap);
      if (tapMetres < metres) {
        metres = tapMetres;
        depth = tap;
        nearestAt = at;
      }
    }
  }
  vec4 clip = vec4(nearestAt * 2.0 - 1.0, ${glslSceneDepthToNdc('depth')}, 1.0);
  vec4 previous = uReprojection * clip;
  /* Behind the previous eye: there is no last-frame position to sample. */
  if (previous.w <= 0.0) {
    fragColor = vec4(current, share);
    flickerOut = freshRecord(current);
    flickerMotionOut = vec4(metres, 0.0, 0.0, 0.0);
    return;
  }

  vec2 wasUv = vUv + ((previous.xy / previous.w) * 0.5 + 0.5 - nearestAt);
  /*
   * **Off the edge of the last frame is a disocclusion**, and the honest answer is this frame's
   * colour rather than a clamped sample of the border, which would drag one row of pixels inward
   * as a smear for as long as the camera kept turning.
   */
  if (wasUv.x < 0.0 || wasUv.x > 1.0 || wasUv.y < 0.0 || wasUv.y > 1.0) {
    fragColor = vec4(current, share);
    flickerOut = freshRecord(current);
    flickerMotionOut = vec4(metres, 0.0, 0.0, 0.0);
    return;
  }

  vec3 lo;
  vec3 hi;
  neighbourhood(lo, hi);
  vec3 history = historyCatmullRom(wasUv);

  /*
   * The anti-flicker, operation for operation the one in temporalAa.ts. The record is read at the
   * texel where the surface was rather than filtered, so two surfaces' records never mix at an
   * edge; it is the surface's own if last frame's depth there, or at one of the texels beside it,
   * is the depth this surface should have had — the nearest of five, because this frame's sample
   * and last frame's can straddle an edge with nothing moved. Otherwise it is no record.
   */
  ivec2 size = textureSize(uFlicker, 0);
  ivec2 was = clamp(ivec2(wasUv * vec2(size)), ivec2(0), size - 1);
  float nearest = 1e9;
  for (int n = 0; n < 5; n++) {
    ivec2 at = was + (n == 1 ? ivec2(1, 0) : n == 2 ? ivec2(-1, 0) : n == 3 ? ivec2(0, 1) : n == 4 ? ivec2(0, -1) : ivec2(0));
    float stood = texelFetch(uFlickerMotion, clamp(at, ivec2(0), size - 1), 0).r;
    if (stood > 0.0) nearest = min(nearest, abs(stood - previous.w));
  }
  /* The swing is the pixel's whatever the test says: resetting it would stop it learning one. */
  vec4 motionThere = texelFetch(uFlickerMotion, was, 0);
  bool missedAll = nearest > 1e8;
  bool same = uAntiFlicker > 0.5 && !missedAll &&
    nearest <= FLICKER_WIDTH * motionThere.g + FLICKER_SURFACE * previous.w;
  float swingOut = missedAll ? 0.0 : motionThere.g + (nearest - motionThere.g) * FLICKER_MEMORY;
  float seen = luma(current);
  vec4 held = same ? texelFetch(uFlicker, was, 0) : freshRecord(current);

  float still = 1.0 - smoothstep(STILL_FROM, STILL_TO, length((wasUv - vUv) / uTexel));
  float apart = abs(seen - held.b);
  float reach = FLICKER_WIDTH * held.r + 1.0 / 255.0;
  bool within = apart <= reach;
  bool proven = held.a > 0.75 && within;
  float widen = proven ? FLICKER_WIDTH * held.r * still : 0.0;
  float blend = proven ? mix(uHistoryBlend, FLICKER_BLEND, still) : uHistoryBlend;
  vec3 bounded = clipToNeighbourhood(history, lo - widen, hi + widen);

  float sum = held.g;
  float mean = held.b;
  float repeated = within ? held.a : 0.0;
  if (uPeriodStart > 0.5) {
    repeated = repeats(sum, mean) > 0.5 ? min(1.0, repeated + 0.5) : 0.0;
    mean = sum;
    sum = 0.0;
  }
  flickerOut = vec4(
    held.r + (apart - held.r) * FLICKER_MEMORY,
    sum + seen * FLICKER_MEMORY,
    mean,
    repeated * still
  );
  flickerMotionOut = vec4(metres, swingOut, 0.0, 0.0);
  fragColor = vec4(mix(current, bounded, blend), share);
}
`;
