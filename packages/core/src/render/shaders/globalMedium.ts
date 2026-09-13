import { glslIsFarDepth, glslSceneDepthToNdc } from '../depthConvention.ts';
import { MAX_GLOBAL_MEDIUM_STEPS } from '../globalMedium.ts';

/**
 * A medium filling the whole frustum: the march, and the upsample that puts it back on screen.
 *
 * **Volumetrics in this engine were a body inside a hull and nothing else.** `lightVolume.ts`
 * marches a cone a caller placed, which is a shaft through a window and a lighthouse beam; there
 * was no way to say the air itself is thick. Fog was `atmosphere.ts`, which fades a *surface*
 * toward a colour by how far away it is — so a room full of haze had no shafts in it, a solid
 * standing in that haze cast nothing through it, and the sun's own shadow map, which knows
 * exactly where the light does not reach, was consulted by nothing between the surfaces.
 *
 * The difference is one term. Distance fog asks how much of a surface survives the journey;
 * this asks what the journey *adds*, which is every point along it that the sun can see. A wall
 * behind a doorway dims either way. Only this one puts the doorway's shape on the floor.
 *
 * ## Two passes, and the second one is not a blur
 *
 * `ambientOcclusionPass.ts` runs its estimate at the frame's own size and blurs it. This runs at
 * half and upsamples, and the difference is what a sample costs: an occlusion tap is one depth
 * fetch, and a march step is a shadow lookup plus an exponential, tens of times per pixel. Half
 * resolution is a quarter of that, and it is affordable here for the reason it is not affordable
 * there — a medium is smooth almost everywhere, so the only place half resolution is visible is
 * the one place the upsample is careful about.
 *
 * **Which is the silhouette.** A bilinear fetch of a half-res medium reads two texels that
 * straddle an edge, so the fog computed for the wall behind a railing is averaged onto the
 * railing itself and the railing wears a halo. The upsample weights each of the four texels by
 * how close its own depth is to this pixel's, which is the same instrument `AO_BLUR_FRAG` uses
 * and for the same reason: it is what separates a blur from a smear.
 */

/**
 * The march. Writes scattered light in `rgb` and how much of the frame survives in `a`.
 *
 * **Transmittance in alpha is what makes the composite a fixed-function blend** rather than a
 * second read of the scene. `dst.rgb * src.a + src.rgb` is exactly the transfer equation for a
 * segment, and it is `ONE, SRC_ALPHA` on both backends — so the pass that puts this on screen
 * never samples the colour it is modifying, which is the sampling a backend is entitled to call
 * undefined and which cost this renderer a snapshot copy everywhere else it was needed.
 */
export const MEDIUM_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** The frame's depth, at full size however small this target is. See \`uDepthToWorld\`. */
uniform highp sampler2D uDepth;
/**
 * Straight from a stored depth to world space, in one matrix, exactly as \`uDepthToLocal\` is.
 *
 * Built on the CPU per frame because the two backends disagree about clip space: WebGL2 stores
 * depth in [0,1] and wants NDC z in [-1,1], WebGPU stores and wants [0,1]. Folding the remap into
 * the matrix is what lets this shader read \`vec4(ndc.xy, stored, 1)\` without knowing which one it
 * is running on, and \`lightVolumeDraw.ts\` derives both remaps and says why they are not one.
 */
uniform mat4 uDepthToWorld;
uniform vec3 uCameraPos;

/** Surface → sun, normalised: \`Environment.directionalDir\`, the same vector the flat shader gets. */
uniform vec3 uSunDir;
/** The sun's colour and intensity, which is what the medium scatters. */
uniform vec3 uSunColor;
/** The sky's own fill, scattered isotropically. Without it a shadowed medium is black. */
uniform vec3 uAmbient;

/** Extinction per metre. Above zero here, because nothing draws this pass at zero. */
uniform float uDensity;
/** How much of what the medium takes out comes back as light rather than heat, 0 to 1. */
uniform float uAlbedo;
/** Henyey-Greenstein g, -1 back to 1 forward. */
uniform float uAnisotropy;
/** Where the march stops, in metres. */
uniform float uMaxDistance;
/** Steps per pixel, clamped to \`MAX_GLOBAL_MEDIUM_STEPS\`. */
uniform int uSteps;

/** How much of the medium the sun's own shadow map removes, 0 to 1. At 0 nothing is sampled. */
uniform float uSunShadow;
uniform mat4 uLightViewProj;
uniform sampler2D uStaticShadowMap;
uniform sampler2D uPeeledShadowMap;
uniform sampler2D uDynamicShadowMap;
uniform int uPeeledShadowEnabled;

out vec4 fragColor;

/**
 * The stored depth this shader unprojects to find the ray, and it is not a depth in the scene.
 *
 * Every view ray of a perspective projection passes through the eye, so one point on the ray is
 * enough to fix its direction and the eye supplies the other. A half is chosen because it is
 * inside the frustum whichever way round the convention runs — near or far would be exact under
 * one and at infinity under the other, and this shader is compiled once for both.
 */
const float RAY_PROBE_DEPTH = 0.5;

/** Depth tolerance for the shadow lookup, and the width the comparison ramps over. See lightVolume. */
const float SHADOW_BIAS = 0.0015;
const float SHADOW_SOFTEN = 0.0025;

/** Four pi, which is what a phase function normalises over. */
const float FOUR_PI = 12.56637061;

/**
 * How the samples are spread along the ray: distance is \`far * u^DISTRIBUTION\` for u in 0 to 1.
 *
 * **Even spacing was what shipped first here and it was measured before it was changed.** A ray
 * that leaves through an opening has nothing to stop it, so it marches the whole \`maxDistance\`:
 * at 200 m and 32 steps that is six metres between samples, and the dither below then moves each
 * one by up to three. Every sample near the opening's own frame flips between blocked and unblocked
 * from pixel to pixel, and what reaches the screen is coarse salt-and-pepper over the brightest
 * part of the frame — photographed on \`demo/dev/medium.html\` at \`?density=0.03\`, where the sky
 * through the window is the one region a viewer's eye goes to first.
 *
 * Squaring fixes it because the structure is not spread evenly either. Everything a march has to
 * resolve — the edge of a shaft, the shadow of a post, the boundary of a doorway — is *near*,
 * inside the room the camera is standing in; what is far is the uniform remainder of a homogeneous
 * medium, which needs no resolution at all. At 200 m over 32 steps the first segment is now 20 cm
 * and the last is twelve metres, and the twelve metres are integrated exactly by the analytic term
 * below rather than approximated.
 *
 * Two, and not more, because the segment lengths are what the dither is measured in: a steeper
 * power buys sharper near detail and pushes the far dither back up.
 */
const float DISTRIBUTION = 2.0;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/** A ramp rather than a comparison, for the reason \`lightVolume.ts\` gives about its own dither. */
float occlusion(float stored, float compare) {
  return smoothstep(-SHADOW_SOFTEN, SHADOW_SOFTEN, compare - stored);
}

/** How much sun reaches one point in the air. The same three maps the shaft reads, in the same order. */
float sunReach(vec3 worldPos) {
  vec4 lightPos = uLightViewProj * vec4(worldPos, 1.0);
  if (lightPos.w <= 0.0) return 1.0;
  vec3 p = lightPos.xyz / lightPos.w * 0.5 + 0.5;
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;

  /* Faded at the border rather than cut at it: the map covers a radius around the viewer, and a
     hard edge makes a shaft appear as the camera walks toward it. */
  vec2 fromCentre = abs(p.xy - 0.5) * 2.0;
  float edgeFade = 1.0 - smoothstep(0.72, 0.98, max(fromCentre.x, fromCentre.y));
  edgeFade *= 1.0 - smoothstep(0.90, 1.0, p.z);
  if (edgeFade <= 0.0) return 1.0;

  float compare = p.z - SHADOW_BIAS;
  float blocked = occlusion(textureLod(uStaticShadowMap, p.xy, 0.0).r, compare);
  if (uPeeledShadowEnabled != 0) {
    blocked = max(blocked, occlusion(textureLod(uPeeledShadowMap, p.xy, 0.0).r, compare));
  }
  blocked = max(blocked, occlusion(textureLod(uDynamicShadowMap, p.xy, 0.0).r, compare));
  return mix(1.0, 1.0 - blocked, uSunShadow * edgeFade);
}

/**
 * Henyey-Greenstein: how much light arriving along one direction leaves along another.
 *
 * **This is the term that makes a medium look like weather rather than like a grey wash.** Air
 * with dust in it is strongly forward-scattering, which is why the haze around a low sun is
 * bright and the same haze behind you is not, and an isotropic medium is the one thing that
 * cannot show that at any density. g of zero returns 1 / 4pi exactly and costs the same.
 */
float phase(float cosTheta, float g) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
  return (1.0 - g2) / (FOUR_PI * d * sqrt(d));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;

  /* The ray, from the eye through one point of it. See RAY_PROBE_DEPTH. */
  vec4 probe = uDepthToWorld * vec4(ndc, RAY_PROBE_DEPTH, 1.0);
  vec3 dir = normalize(probe.xyz / probe.w - uCameraPos);

  /*
   * Where the march stops: the surface the frame already drew, or the medium's own reach.
   *
   * **Without the first the fog is drawn through the wall**, which is not a subtle failure —
   * a lit doorway would put its shaft on top of the wall beside it rather than on the floor
   * through it. It is the same clamp \`lightVolume.ts\` acquired after a beam was reported
   * continuing under a floor, and \`hit.w\` is guarded here for the reason it is guarded there.
   */
  float stored = textureLod(uDepth, vUv, 0.0).r;
  float far = uMaxDistance;
  if (!${glslIsFarDepth('stored')}) {
    vec4 hit = uDepthToWorld * vec4(ndc, stored, 1.0);
    if (hit.w > 1e-6) far = min(far, dot(hit.xyz / hit.w - uCameraPos, dir));
  }
  if (far <= 0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  int steps = clamp(uSteps, 1, ${MAX_GLOBAL_MEDIUM_STEPS});

  /*
   * The lattice is the plain midpoint rule and only the shadow lookup is dithered off it.
   *
   * **The same split \`lightVolume.ts\` took three captures to arrive at**, and the argument is
   * the medium's rather than the beam's only in one detail: here the density is *constant*, so
   * the sole discontinuity anywhere in the integrand is the shadow map. Jittering the sample
   * positions would therefore spoil the one term that is perfectly smooth and improve nothing,
   * which is exactly the screen door that shader photographed down a beam carrying no shadow.
   *
   * A hash rather than a Bayer tile, and that is the one place the two differ. This pass runs at
   * half resolution behind a depth-aware upsample, and an ordered pattern survives that upsample
   * as a pattern at twice the size — the 4x4 tile would arrive on screen eight pixels wide. A
   * hash arrives as noise the upsample's own bilinear footprint already averages four of.
   */
  float dither = hash21(gl_FragCoord.xy) - 0.5;

  /* Constant along the ray, so out of the loop: the medium is homogeneous by construction. */
  float scatter = uAlbedo * phase(dot(dir, uSunDir), uAnisotropy);
  vec3 sunLit = uSunColor * scatter;
  /* Isotropic, so no phase term: sky fill arrives from every direction and leaves the same way. */
  vec3 skyLit = uAmbient * uAlbedo * (1.0 / FOUR_PI);

  vec3 inscatter = vec3(0.0);
  float transmittance = 1.0;
  float previous = 0.0;

  for (int i = 0; i < ${MAX_GLOBAL_MEDIUM_STEPS}; i++) {
    if (i >= steps) break;
    /*
     * The segment this step covers, and it is **not** the same length as the one before it.
     *
     * See DISTRIBUTION: the samples crowd toward the camera, so every quantity below is computed
     * from this segment's own length rather than from a step shared by the whole march.
     */
    float u = float(i + 1) / float(steps);
    float next = far * pow(u, DISTRIBUTION);
    float segment = next - previous;
    float travelled = 0.5 * (previous + next);
    previous = next;

    /*
     * How much this segment scatters toward the eye, and the reason it is not
     * \`density * segment\`.
     *
     * The analytic integral of \`sigma_s * exp(-sigma_t * s)\` over the segment is
     * \`albedo * (1 - exp(-sigma_t * dl))\`, and using it rather than the rectangle rule is what
     * keeps the picture the same when a device is given a smaller step count: the rectangle rule
     * over-counts by half a segment's absorption every segment, so a 16-step march comes out
     * visibly brighter than a 64-step one and the quality dial changes the image rather than its
     * cost. It also cannot exceed the light that entered, at any density and any step, which a
     * product of two unbounded numbers can.
     */
    float segmentTransmittance = exp(-uDensity * segment);
    float scattered = 1.0 - segmentTransmittance;

    float lit = 1.0;
    if (uSunShadow > 0.0) lit = sunReach(uCameraPos + dir * (travelled + dither * segment));

    inscatter += transmittance * scattered * (sunLit * lit + skyLit);
    transmittance *= segmentTransmittance;
  }

  /*
   * Scaled by four pi on the way out, so that an isotropic medium at albedo 1 returns exactly
   * the light that reached it.
   *
   * The phase function is normalised over the sphere, which is what makes anisotropy mean
   * something; it also means an isotropic medium hands back 1/4pi of the sun, and a caller
   * setting albedo to 1 would get a twelfth of what a fog ought to look like and reach for a
   * density that is not physical. The factor puts \`albedo\` back on the scale its name implies.
   */
  fragColor = vec4(inscatter * FOUR_PI, transmittance);
}
`;

/**
 * The upsample, blended straight over the frame.
 *
 * **Four taps and a depth test, not a bilinear fetch.** The half-res march is smooth wherever the
 * scene is, and wrong wherever the scene is not: a texel whose own ray ended on the wall behind a
 * railing carries the wall's fog, and a linear fetch spreads it onto the railing. So each of the
 * four texels around this pixel is weighted by its bilinear share **and** by how close the depth
 * its march stopped at is to this pixel's own, which is what keeps the fog on its own side of an
 * edge. `AO_BLUR_FRAG` weights its taps the same way and calls it the difference between a blur
 * and a smear.
 *
 * The low-resolution depths are read out of the *frame's* depth texture at the low-resolution
 * texel centres, rather than out of a second half-size depth target. They are the same values:
 * the march point-samples that same texture at those same coordinates, so this reproduces what
 * each texel actually integrated to, for one fetch each and no extra attachment.
 */
export const MEDIUM_UPSAMPLE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** The march's output: scattered light in rgb, transmittance in a. Linear filtered, half size. */
uniform sampler2D uMedium;
/** The frame's depth, at full size. */
uniform highp sampler2D uDepth;
/** One texel of the *medium*, which is two of the frame. */
uniform vec2 uMediumTexel;
/**
 * The four terms that carry a stored depth back to view-space metres.
 *
 * Elements 10, 14, 11 and 15 of the inverse projection, column major — the same four
 * \`ambientOcclusionPass.ts\` reads and in the same order, because the comparison this makes is
 * the comparison its blur makes.
 */
uniform vec4 uDepthToViewZ;

out vec4 fragColor;

/**
 * How far apart two view depths may be, as a fraction of the nearer one, before a tap is refused.
 *
 * **Proportional rather than absolute, and that is the whole of why it works at any distance.**
 * A depth buffer's quantum grows with distance and so does the gap two sides of a grazing floor
 * show, so a fixed tolerance in metres either refuses every tap across a far room or accepts
 * every tap across a near silhouette. Five percent is far above both and far below the step at
 * an edge worth protecting — a doorway is metres of it.
 *
 * Raising this toward infinity is exactly a plain bilinear upsample, which is the mutation
 * \`scripts/medium-check.mjs\` uses to show that the silhouette claim is not vacuous.
 */
const float DEPTH_TOLERANCE = 0.05;

/**
 * View distance in metres from a stored depth, positive away from the eye.
 *
 * The stored value is carried to a conventional NDC z first, exactly as \`AO_BLUR_FRAG\`'s copy of
 * this does: the four terms come off the inverse of the camera's own projection, whose clip z runs
 * -1 to 1, and this renderer stores a *reversed* depth in 0 to 1. Skipping that step still yields
 * a monotonic function of distance, which is why it would look like it works — what it breaks is
 * the scale the tolerance below is measured in, so the refusal would fire at the wrong depths.
 */
float viewDistance(float stored) {
  float ndc = ${glslSceneDepthToNdc('stored')};
  return abs((uDepthToViewZ.x * ndc + uDepthToViewZ.y) / (uDepthToViewZ.z * ndc + uDepthToViewZ.w));
}

void main() {
  float here = viewDistance(textureLod(uDepth, vUv, 0.0).r);

  /*
   * The four texel centres the bilinear footprint would have used, found by hand.
   *
   * \`floor(uv / texel - 0.5)\` is the low-resolution texel whose centre is up and to the left of
   * this pixel; the fraction left over is the weight toward the other three. Doing it here rather
   * than letting the sampler do it is the entire pass: the sampler cannot be told to skip a texel.
   */
  vec2 coord = vUv / uMediumTexel - 0.5;
  vec2 base = floor(coord);
  vec2 f = coord - base;

  vec4 total = vec4(0.0);
  float weight = 0.0;
  /** The nearest tap by depth, kept in case every weight is refused. */
  vec4 nearest = vec4(0.0, 0.0, 0.0, 1.0);
  float nearestGap = 1e30;

  for (int i = 0; i < 4; i++) {
    vec2 offset = vec2(float(i & 1), float((i >> 1) & 1));
    vec2 uv = (base + offset + 0.5) * uMediumTexel;
    float bilinear = mix(1.0 - f.x, f.x, offset.x) * mix(1.0 - f.y, f.y, offset.y);

    float there = viewDistance(textureLod(uDepth, uv, 0.0).r);
    float gap = abs(there - here) / max(min(there, here), 1e-3);
    vec4 sampled = textureLod(uMedium, uv, 0.0);

    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = sampled;
    }
    /*
     * A ramp rather than a cut, over the last fifth of the tolerance. A hard refusal makes the
     * *set* of accepted taps change from pixel to pixel along a slope, and the change is visible
     * as a stair even though every tap in it was correct.
     */
    float depthWeight = 1.0 - smoothstep(DEPTH_TOLERANCE * 0.8, DEPTH_TOLERANCE, gap);
    total += sampled * bilinear * depthWeight;
    weight += bilinear * depthWeight;
  }

  /*
   * **The fallback is a real answer, not a guard against division by zero.** Every tap is refused
   * exactly where this pixel's surface is not represented in the half-res march at all — a
   * one-pixel-wide railing between two texels that both landed on the wall — and there is nothing
   * to interpolate. The nearest by depth is the least wrong of the four, and it is a point sample,
   * which is what a half-res effect always degrades to at a feature it cannot resolve.
   */
  fragColor = weight > 1e-4 ? total / weight : nearest;
}
`;
