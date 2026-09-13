/**
 * The screen-space reflection trace: a reflected ray marched against the frame's own depth.
 *
 * **This mirrors `traceScreenSpaceRay` line for line**, and that is the point of writing it twice.
 * When a crossing counts as a hit, how far behind a surface it may land, what happens at the edge
 * of the frame and what happens over a gap in the geometry are each a defect that draws a
 * *plausible* picture rather than failing — and each of them is settled by arithmetic that needs no
 * GPU. The TypeScript beside this file is the specification and its tests are where those cases are
 * pinned; this is the same walk, in the language that can sample a depth buffer.
 *
 * **It writes into a target of its own rather than onto the scene**, because it samples the scene:
 * a pass that read the colour it was writing would be a feedback loop, reported once per draw on
 * WebGL2 and rejected outright on WebGPU. `ssrPass.ts` composites the result afterwards, which is
 * the arrangement `oitPass.ts` already uses and for the same reason.
 *
 * **The derivatives come first and the march comes second.** The surface normal is the cross
 * product of the reconstructed position's screen derivatives — there being no normal buffer to read
 * one from — and a derivative taken inside non-uniform control flow is undefined. So everything
 * that could branch happens after them, and every fetch inside the march takes an explicit level
 * for the same rule read the other way.
 */

import { glslIsFarDepth } from '../depthConvention.ts';

/**
 * The most samples the march may take. `uSsrSteps` breaks out early.
 *
 * A constant bound because a loop the compiler cannot bound is one it cannot unroll or budget, and
 * because thirty-two two-metre steps is sixty-four metres — further than a screen-space method can
 * usefully see, since a ray that long has almost certainly left the frame.
 */
const MAX_STEPS = 32;
/** How many times a bracketed crossing is halved. Matches `REFINE_STEPS` in the TypeScript. */
const REFINE_STEPS = 6;

export const SSR_TRACE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/**
 * The depth the frame drew, as a copy.
 *
 * \`highp\` because a sampler's default precision is lowp whatever \`precision highp float\` says,
 * and every world position below is reconstructed by dividing through it.
 */
uniform highp sampler2D uSsrDepth;
/** The finished scene colour — what a ray finds is a pixel of this. */
uniform sampler2D uSsrScene;
/** Screen position and stored depth back to the world. See \`DEPTH_01_TO_CLIP\`. */
uniform mat4 uSsrDepthToWorld;
/**
 * World back to a screen position, with the framebuffer's own Y sense already in it.
 *
 * **The flip is in the matrix rather than in a branch here**, so the shader is one expression on
 * both backends and the convention lives in one place — the lesson \`DEPTH_01_TO_CLIP_Y_DOWN\`
 * records at length, arriving through the other door.
 */
uniform mat4 uSsrViewProj;
/** World into the reflective box, \`[-1, 1]\` on each axis. */
uniform mat4 uWorldToSurface;
uniform vec3 uSsrEye;
/** The box's own axis. A surface reflects when it faces back along this. */
uniform vec3 uSsrAxis;
uniform vec3 uSsrTint;
uniform float uSsrStrength;
uniform float uSsrFacingCos;
uniform float uSsrReach;
uniform float uSsrThickness;
uniform float uSsrSteps;
/** How much of the frame each side is fade, as a fraction. */
uniform float uSsrEdgeFade;

out vec4 fragColor;

/** What the frame drew at a screen position, as a world point. */
vec3 worldAt(vec2 uv, float stored) {
  vec4 world = uSsrDepthToWorld * vec4(uv * 2.0 - 1.0, stored, 1.0);
  return world.xyz / world.w;
}

/**
 * How far the eye is from whatever the frame drew there, and a huge number where it drew nothing.
 *
 * The sky is not a surface. A march that treated an untouched depth as one would reflect the whole
 * world in the horizon, which is the failure that looks like a working effect from one angle.
 */
float sceneDistanceAt(vec2 uv) {
  float stored = textureLod(uSsrDepth, uv, 0.0).r;
  if (${glslIsFarDepth('stored')}) return 1.0e9;
  return length(worldAt(uv, stored) - uSsrEye);
}

/** A world point to a screen position. False where it is behind the eye or outside the frame. */
bool projectPoint(vec3 point, out vec2 uv) {
  vec4 clip = uSsrViewProj * vec4(point, 1.0);
  if (clip.w <= 0.0) return false;
  uv = (clip.xy / clip.w) * 0.5 + 0.5;
  return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

void main() {
  float stored = textureLod(uSsrDepth, vUv, 0.0).r;
  vec3 point = worldAt(vUv, stored);

  /*
   * **The normal from the reconstruction's own derivatives, turned to face the eye.**
   *
   * There is no normal buffer here and adding one is a second colour attachment written by every
   * draw path in the engine. Two neighbouring pixels of the same surface span its plane, so their
   * cross product is its normal — noisy along a silhouette and exact everywhere else. Which way
   * that cross product points depends on which way the framebuffer's rows run, and the two
   * backends disagree about that; a visible surface faces the eye by definition, which is what
   * fixes the sign. \`decalProject.ts\` carries the same pair of facts.
   *
   * Taken here, before anything branches, because a derivative in non-uniform control flow is
   * undefined and the whole of the march below is a branch.
   */
  vec3 plane = cross(dFdx(point), dFdy(point));
  float span = length(plane);
  vec3 normal = span > 0.0 ? plane / span : -uSsrAxis;
  vec3 toEye = uSsrEye - point;
  normal *= sign(dot(toEye, normal));

  vec3 box = (uWorldToSurface * vec4(point, 1.0)).xyz;
  vec3 inside = step(abs(box), vec3(1.0));
  float mask = inside.x * inside.y * inside.z;

  /* A surface turned away from the box's axis is not the one the caller called reflective — a wall
     inside the volume of a wet floor is still a wall. Faded rather than cut, so the edge of the
     rule is not an edge in the picture. */
  float facing = dot(normal, -uSsrAxis);
  mask *= smoothstep(uSsrFacingCos, min(1.0, uSsrFacingCos + 0.25), facing);
  /* Nothing was drawn here, so there is no surface to reflect in. */
  mask *= ${glslIsFarDepth('stored')} ? 0.0 : 1.0;
  mask *= uSsrStrength;

  vec3 found = vec3(0.0);
  float weight = 0.0;

  if (mask > 0.0) {
    vec3 view = normalize(point - uSsrEye);
    vec3 ray = reflect(view, normal);

    float steps = max(1.0, uSsrSteps);
    /*
     * Zero to begin with, because the ray starts on the surface it is reflecting off. A crossing
     * needs the previous sample strictly in front, so the first step cannot form one on its own —
     * which is the self-intersection guard, and without it every pixel of a reflective floor takes
     * the comparison on rounding at once.
     */
    float behind = 0.0;
    float previous = 0.0;
    vec2 hitUv = vec2(0.0);
    float hitDistance = 0.0;
    bool found_hit = false;

    for (int i = 1; i <= ${MAX_STEPS}; i++) {
      if (float(i) > steps) break;
      /* Quadratic rather than even: a first step of centimetres, where the contact seam is, and a
         last step of nearly a metre, out where a reflection is faint and about to leave the frame.
         \`marchDistance\` in the TypeScript is the same expression and the reason is written there. */
      float at = float(i) / steps;
      float t = uSsrReach * at * at;
      vec3 sample_point = point + ray * t;
      vec2 uv;
      if (!projectPoint(sample_point, uv)) break;

      float scene = sceneDistanceAt(uv);
      float gap = length(sample_point - uSsrEye) - scene;

      if (behind < 0.0 && gap >= 0.0) {
        /* A crossing, bracketed. Halved rather than reported: the coarse answer is a whole step
           out, which puts a reflection visibly beside the thing reflected. */
        float near = previous;
        float far = t;
        vec2 refinedUv = uv;
        float refinedGap = gap;
        for (int refine = 0; refine < ${REFINE_STEPS}; refine++) {
          float mid = (near + far) * 0.5;
          vec3 midPoint = point + ray * mid;
          vec2 midUv;
          if (!projectPoint(midPoint, midUv)) break;
          float midScene = sceneDistanceAt(midUv);
          float midGap = length(midPoint - uSsrEye) - midScene;
          if (midGap >= 0.0) {
            far = mid;
            refinedUv = midUv;
            refinedGap = midGap;
          } else {
            near = mid;
          }
        }

        /* Believed only if the refined crossing landed within the thickness. A depth buffer says
           nothing about how thick the thing at a pixel is, so without this a ray that slides onto
           a foreground object pastes that object into the reflection. */
        if (refinedGap <= uSsrThickness) {
          found_hit = true;
          hitUv = refinedUv;
          hitDistance = far;
        }
        break;
      }

      behind = gap;
      previous = t;
    }

    if (found_hit) {
      /*
       * Three fades, and they are most of what keeps this from looking wrong.
       *
       * A hit near the edge of the frame is about to leave it, so it leaves gradually rather than
       * along a line. A ray pointing back toward the eye can only find what is between the surface
       * and the camera, which is usually nothing and occasionally the viewer's own geometry. And a
       * hit at the far end of the reach is the least reliable one the march can report, since it
       * had the most chances to slide onto something.
       */
      float edge = clamp(min(min(hitUv.x, 1.0 - hitUv.x), min(hitUv.y, 1.0 - hitUv.y)) /
        max(uSsrEdgeFade, 1.0e-4), 0.0, 1.0);
      float away = clamp((dot(normalize(ray), view) + 1.0) * 0.5, 0.0, 1.0);
      float reach = 1.0 - clamp(hitDistance / max(uSsrReach, 1.0e-4), 0.0, 1.0);
      weight = mask * edge * away * reach;
      found = textureLod(uSsrScene, hitUv, 0.0).rgb * uSsrTint;
    }
  }

  /* Premultiplied, so the pass composites with (one, one-minus-src-alpha) and several reflective
     surfaces overlapping accumulate the way two blended layers do. */
  fragColor = vec4(found * weight, weight);
}
`;
