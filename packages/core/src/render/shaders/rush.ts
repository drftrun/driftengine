/**
 * The speed rush: a radial blur over a finished frame.
 *
 * The post-process seam, and the first effect hung off it. A game asks for speed to be
 * *felt* rather than only read, and the two halves of that are zoom — which a camera can
 * do on its own, by widening its field of view — and blur, which nothing can do without a
 * finished frame to sample. So this is a fullscreen pass over the resolved scene.
 *
 * **Peripheral on purpose.** Blurring what a player is looking at fights the game; blurring
 * what is rushing past them is the sensation itself. So the centre stays sharp and the
 * softening lives at the edges, and the sharp region *narrows* as speed builds, which reads
 * as the world closing in rather than as a filter fading up.
 *
 * The taps are radial — each sample steps *outward from the centre*, along the direction
 * the world is streaming past — rather than a box or a gaussian. A symmetric blur just
 * loses detail; smearing along the flow is what the eye reads as motion. Six taps, because
 * this is a second pass over every pixel on a renderer whose hard gate is 60 fps on a
 * mid-range phone: the cost is fixed and small, and at zero strength the loop still runs
 * but every tap lands on the same texel, so the frame is bit-identical to no blur at all.
 */

/* The vertex stage is `FULLSCREEN_VERT`, shared with the occlusion pass and its blur. */
import { glslSceneDepthToNdc } from '../depthConvention.ts';
import { DEPTH_OF_FIELD_GLSL } from './depthOfField.ts';

export const RUSH_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uScene;
/** 0 for a stationary character, 1 at the fastest the game allows. */
uniform float uStrength;
/**
 * How far the outermost tap reaches, in UV, and where the sharp centre ends.
 *
 * Both scale with strength inside the shader rather than being pre-multiplied by the
 * caller, so a single uniform drives the whole effect and there is one place to reason
 * about what "full speed" looks like.
 */
uniform float uReach;
/*
 * The grade, which used to live in the mesh pass and now lives here.
 *
 * **It moved because a curve applied before the buffer throws away the range the buffer keeps.**
 * The mesh shader graded and clipped, so everything downstream saw a scene already squashed into
 * 0 to 1 and a star was indistinguishable from white paint. Grading at the end means the scene
 * target holds what the scene actually emitted.
 *
 * It also fixes an inconsistency nobody had noticed: the mesh pass was the *only* pass that
 * graded, so the sky, the particles, the wet film and the water were composited ungraded beside
 * a world that was. One curve at the end covers every pass by construction.
 *
 * Zero is no transform, which leaves the scene exactly as it arrived and is the default.
 */
uniform int uOutputTransform;
uniform float uOutputExposure;

/**
 * The frame's depth, and the matrix that carries a pixel back to where it was last frame.
 *
 * uReprojection is the previous view-projection times the inverse of this frame's, so one
 * matrix multiply takes a point from this frame's clip space to the last one's. Built on the
 * CPU because it is one multiply per frame there and would be one per *pixel* here.
 *
 * **highp on the sampler, and it is not decoration.** GLSL ES gives a fragment shader's
 * samplers a default
 * precision of *lowp*, whatever precision highp float says at the top of the file — that
 * line sets the default for float, not for a sampler. A lowp sampler is entitled to hand
 * back eight bits, and a depth buffer read at eight bits is a scene flattened onto about two
 * hundred and fifty planes.
 *
 * Measured on this driver rather than assumed: with the qualifier absent, every depth sample
 * in the frame came back an exact multiple of a power of two, the low bits of the encoded
 * depth were zero across the whole image, and a run of pixels along a wall read one identical
 * value. With it, they vary per pixel. Camera motion blur has been reprojecting through that
 * since it shipped, which is a smear built on a staircase.
 */
uniform highp sampler2D uDepth;
uniform mat4 uReprojection;
/** 0 disables camera motion blur entirely, and is the default. */
uniform float uMotionStrength;
/** A ceiling on the smear, in UV, so a fast turn softens the frame rather than erasing it. */
uniform float uMotionMax;

/**
 * Ambient occlusion, already estimated and blurred by its own pass. 1 is open, 0 is enclosed.
 *
 * Read rather than computed here, and that is a decision made by looking: twelve depth taps
 * per pixel is a noisy estimate of a smooth quantity, and used raw it is salt and pepper over
 * every surface in the frame. See ambientOcclusion.ts for the pass and the sampling.
 *
 * uAoStrength is how much of it to apply, 0 for none, and 0 is the default. It also carries
 * the honest failure: the pass that fills this can decline to run, and this then arrives as
 * zero rather than as a multiply by a texture nobody wrote.
 */
uniform sampler2D uAo;
uniform float uAoStrength;

/**
 * The bloom chain's top level, already thresholded, blurred and summed by its own pass.
 *
 * Added rather than mixed, in linear scene units, before the grade: bloom is light arriving at
 * the eye from beside a bright thing, so it adds to what is there and then rolls off through
 * the same curve as everything else. Mixing would darken the source to pay for its own halo,
 * which is the look of a filter rather than of a bright object.
 *
 * uBloomStrength is how much of it to add, and 0 is the default and the whole of the off path:
 * the branch below means a frame without bloom performs no fetch and no arithmetic, so it is
 * the frame that existed before the effect did rather than one multiplied by zero.
 */
uniform sampler2D uBloom;
uniform float uBloomStrength;

/**
 * The frame veil: a flat colour composited last, over the graded picture. See
 * Renderer.setFrameVeil for the full ruling this ordering encodes; the short version:
 *
 * **After the tone map**, because a transition has to hit exact black and exact white
 * deterministically — (0,0,0,1) pure black, (1,1,1,1) pure white — and a curve built to
 * roll off makes "full white" an asymptote no caller could solve for.
 *
 * **Before anything that would run after this** — a vignette, a grain pass — were either ever
 * added here, because the consumer's complaint was a veil painted over an *already finished*
 * frame, which flattens that texture instead of fading with it. Mixed in here, ahead of the
 * last operation the pass has, a dip takes the picture down with it rather than covering it.
 *
 * **Never feeds the bloom above**, by construction: bloom is resolved from the pre-tonemap
 * scene before this fragment shader ever runs (see SceneTarget.resolve and runBloom), so a
 * veil composited after it cannot brighten a threshold it never reaches. Dipping to white is a
 * cut, not a light.
 *
 * uVeilAlpha 0 is the default and the whole of the off path: withVeil returns the pixel
 * unmixed, so a frame with no veil performs no extra arithmetic.
 */
uniform vec3 uVeilColor;
uniform float uVeilAlpha;

/**
 * The colour grade: a lookup table over display values, sampled after the tone map.
 *
 * **After the curve, because a grade is display-referred.** Every \`.cube\` a grading tool exports
 * maps display values to display values — that is what a colourist was looking at when they made
 * it — so applying it to scene units would be applying it to something it was never authored
 * against. The transform above is a *conversion* and this is a *look*, and the look goes last of
 * the two.
 *
 * **Before the veil, and \`uVeilAlpha\`'s own comment is the ruling.** It says the veil goes
 * "before anything that would run after this — a vignette, a grain pass — were either ever added
 * here, because the consumer's complaint was a veil painted over an *already finished* frame". A
 * grade is exactly such a thing, so it arrives ahead of the veil and a dip to black takes the
 * graded picture down with it rather than covering it.
 *
 * **\`uGradeStrength\` 0 is the default and the whole of the off path.** The branch below is on a
 * uniform, which is provably uniform control flow, so a frame with no grade performs no fetch at
 * all — this is not the 2026-08-07 case, where a compiler cannot prove a branch uniform and may
 * flatten it. The fetch is still \`textureLod\` because the table has one storage level and there
 * is nothing to select between.
 *
 * **The coordinate lands on texel centres.** A lattice value of \`i\` sits at \`(i + 0.5) / size\`,
 * so the ends of the range reach the first and last texels exactly rather than half a texel short.
 * Sampling at \`c\` directly would compress the whole table by one texel and darken every white in
 * the frame by a fraction nobody would trace to a coordinate.
 */
/*
 * **\`highp\` spelled out, because GLSL ES 3.00 gives \`sampler3D\` no default precision.**
 *
 * \`sampler2D\` has one in the fragment stage and every other sampler in this corpus relies on
 * it; a 3D sampler does not, and the compiler answers \`'sampler3D' : No precision specified\`.
 * The generator does not care: naga takes the declaration without a qualifier and produces
 * correct WGSL, so this compiles, generates, validates and then **fails at runtime on WebGL2
 * only** — the backend with nothing beneath it. That is the same shape as \`unpackUnorm4x8\` in
 * the splat shader, a 3.10 builtin the generator accepts because it raises the version before
 * handing the source to glslang.
 *
 * Found by driving the page rather than by review, on the first capture.
 * \`samplerPrecision.test.ts\` asserts it from here on, over the whole corpus.
 */
uniform highp sampler3D uGradeLut;
uniform float uGradeStrength;
uniform float uGradeSize;

out vec4 fragColor;

/*
 * Depth of field, spliced in whole from depthOfField.ts.
 *
 * Below the uniforms it reads — uScene, uDepth and vUv — and above the functions that use it,
 * because GLSL has no forward declarations and the order in this file is the order the compiler
 * sees.
 */
${DEPTH_OF_FIELD_GLSL}

/*
 * The same curve the mesh pass used to apply, moved here whole rather than reimplemented, so
 * the two cannot drift. See the uniforms above for why it moved.
 */
vec3 linearToSrgb(vec3 c) {
  vec3 low = c * 12.92;
  vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), c));
}

vec3 acesFilmic(vec3 x) {
  x *= uOutputExposure;
  const mat3 ACES_INPUT = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 ACES_OUTPUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  vec3 v = ACES_INPUT * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(ACES_OUTPUT * (a / b), 0.0, 1.0);
}

vec3 grade(vec3 c) {
  if (uOutputTransform == 0) return c;
  if (uOutputTransform == 2) c = acesFilmic(c);
  return linearToSrgb(c);
}

/** The frame's bloom, added in scene units. See the uniforms above for why it goes here. */
vec3 withBloom(vec3 c) {
  if (uBloomStrength <= 0.0) return c;
  return c + textureLod(uBloom, vUv, 0.0).rgb * uBloomStrength;
}

/** The grade, sampled after the curve and before the veil. See uGradeLut's own comment. */
vec3 applyColourGrade(vec3 c) {
  if (uGradeStrength <= 0.0) return c;
  vec3 clamped = clamp(c, 0.0, 1.0);
  vec3 uvw = (clamped * (uGradeSize - 1.0) + 0.5) / uGradeSize;
  return mix(c, textureLod(uGradeLut, uvw, 0.0).rgb, uGradeStrength);
}

/** The veil, mixed in last of everything this pass does. See uVeilAlpha's own comment. */
vec3 withVeil(vec3 c) {
  if (uVeilAlpha <= 0.0) return c;
  return mix(c, uVeilColor, uVeilAlpha);
}

/**
 * Camera motion blur: reproject each pixel through the previous view and smear along the
 * difference.
 *
 * Camera blur rather than per-object, deliberately. Per-object needs a velocity buffer —
 * every mesh writing its own screen-space motion into a second render target, so a second
 * set of matrices per draw and a wider G-buffer — which is a structural change to a forward
 * renderer that writes one colour target. Camera blur needs only the previous
 * view-projection, which the renderer already has every reason to keep, and it covers the
 * case that actually matters: a camera whipping round a turntable or through a world.
 *
 * **The velocity comes from the rendered camera, not from the simulation step.** Sampling
 * along a velocity derived from the fixed 1/60 step makes the blur pulse at 60 Hz against a
 * display running at any other rate, which reads as a stutter and gets blamed on frame
 * pacing. The matrix handed in is the one the frame was actually drawn with, interpolation
 * included.
 *
 * The sky is included rather than masked out: at depth 1 a pure rotation still reprojects
 * correctly, and a camera turning past a horizon *should* smear it.
 */
vec3 cameraBlur(vec3 scene) {
  float depth = textureLod(uDepth, vUv, 0.0).r;
  vec4 clip = vec4(vUv * 2.0 - 1.0, ${glslSceneDepthToNdc('depth')}, 1.0);
  vec4 previous = uReprojection * clip;
  /* Behind the previous eye: there is no last-frame position to smear toward. */
  if (previous.w <= 0.0) return scene;

  vec2 wasUv = (previous.xy / previous.w) * 0.5 + 0.5;
  vec2 velocity = (vUv - wasUv) * uMotionStrength;

  float distance = length(velocity);
  if (distance < 1e-4) return scene;
  if (distance > uMotionMax) velocity *= uMotionMax / distance;

  /*
   * Centred on the pixel rather than trailing behind it. A one-sided smear moves the whole
   * image against the direction of travel, which reads as the frame lagging; sampling both
   * ways keeps the subject where it is and softens around it.
   */
  vec3 sum = scene;
  for (int i = 1; i <= 4; i++) {
    float t = float(i) / 4.0 * 0.5;
    sum += textureLod(uScene, vUv + velocity * t, 0.0).rgb;
    sum += textureLod(uScene, vUv - velocity * t, 0.0).rgb;
  }
  return sum / 9.0;
}

void main() {
  vec3 scene = textureLod(uScene, vUv, 0.0).rgb;
  if (uMotionStrength > 0.0) scene = cameraBlur(scene);
  /*
   * Defocus after the camera smear and before everything else, because a lens is the last thing
   * in front of the sensor and the two blurs are both properties of the *camera* rather than of
   * the scene. Occlusion, bloom and the grade all follow, so a defocused highlight blooms — which
   * is what a defocused highlight does.
   */
  if (uDofStrength > 0.0) scene = depthOfField(scene);

  /*
   * Occlusion applied after the blurs rather than before, so a smear of a darkened image is
   * not then darkened again along its own trail. mix from 1 rather than a multiply by the
   * strength, so the parameter reads as "how much of this occlusion", and 0 is exactly the
   * frame that existed before the effect did.
   */
  float ao = mix(1.0, textureLod(uAo, vUv, 0.0).r, uAoStrength);

  /*
   * Distance from the centre, corrected so the falloff is a circle on screen rather than
   * an ellipse stretched by the aspect. Without this the effect is much stronger at the
   * left and right edges of a wide window than at the top and bottom, which reads as a
   * bug rather than as speed.
   */
  vec2 fromCentre = vUv - 0.5;
  float radius = length(fromCentre * vec2(1.0, 0.62)) * 2.0;

  /*
   * The clear centre narrows as speed builds: 0.62 of the frame at a standstill down to
   * about 0.3 flat out. Smoothstep rather than a hard edge, or the boundary itself becomes
   * a visible ring.
   */
  float inner = mix(0.62, 0.30, uStrength);
  float edge = smoothstep(inner, 1.0, radius);
  float amount = edge * uStrength;
  if (amount <= 0.0) {
    fragColor = vec4(withVeil(applyColourGrade(grade(withBloom(scene * ao)))), 1.0);
    return;
  }

  /*
   * Outward along the radius, which is the direction the world streams past a character
   * moving forward. Accumulated from the centre-most tap outward with the unblurred
   * sample included, so a pixel never loses its own colour entirely.
   */
  vec2 step = normalize(fromCentre + vec2(1e-6)) * uReach * amount;
  vec3 sum = scene;
  for (int i = 1; i <= 6; i++) {
    /* textureLod for the same reason as the occlusion taps: this loop is reached through a
       branch on amount, which varies across the frame, so it is not uniform control flow.
       Identical output — the scene texture has one storage level. */
    sum += textureLod(uScene, vUv + step * (float(i) / 6.0), 0.0).rgb;
  }
  vec3 blurred = sum / 7.0;

  fragColor = vec4(
    withVeil(applyColourGrade(grade(withBloom(mix(scene, blurred, amount) * ao)))),
    1.0
  );
}
`;
