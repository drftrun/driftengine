/**
 * Skin's screen-space scattering: one axis of the blur that spreads the diffuse pass by Burley's
 * profile, and on the second axis the sum the frame takes back. `skinBlur.ts` beside the render
 * directory is the kernel's reference and says what it gives up.
 *
 * **One pass, run twice**: along x into a target of its own, keeping the profile in the alpha, then
 * along y blended additively into the frame — its colour added, the frame's alpha kept.
 *
 * **What it spreads is light, and the colour is applied after**, from the skin's own colour half at
 * this pixel. Light travels beneath skin; the pigment a brow, a lip line or a freckle is made of
 * does not, so spreading the coloured diffuse — as this did until 4.8.6 — smeared every mark on a
 * face into the skin around it, and the blur's taps laid faint copies of each mark beside it.
 *
 * **Refuses what is not the same skin**: a neighbour that wrote no skin, or one further in depth
 * than four of the profile's widest distances, takes no weight, and what is kept is divided by
 * what was kept, so a cheek's light does not pull toward the black beside its silhouette. A tap
 * part skin is counted for the part it is: the target is read as coverage-weighted, which is what
 * a filtered tap across an edge already is.
 */
import { glslIsFarDepth, glslSceneDepthToNdc } from '../depthConvention.ts';
import { SKIN_BLUR_EDGES, SKIN_BLUR_TAPS, SKIN_PROFILES } from '../skinBlur.ts';

const list = (values: readonly number[]): string => values.map((v) => v.toFixed(2)).join(', ');

export const SKIN_BLUR_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/** The diffuse pass, or the first axis' result: diffuse in rgb, the profile as (index + 1) / 8. */
uniform sampler2D uSkin;
/** highp, for the reason the ambient occlusion blur gives: eight bits of depth find false edges. */
uniform highp sampler2D uDepth;
/** One texel along the axis being blurred, in UV. The other component is zero. */
uniform vec2 uStep;
/** A depth sample to view-space metres, as the ambient occlusion blur takes it. */
uniform vec4 uDepthToViewZ;
/** How many pixels a metre spans at a metre's distance. */
uniform float uFocal;
/** Each profile's scatter distance per channel, in metres. */
uniform vec4 uProfiles[${SKIN_PROFILES}];
/**
 * The skin's colour, and its coverage in the alpha: what the spread light is multiplied by on the
 * second axis, where \`uApplyAlbedo\` is 1. Read at this pixel alone, because pigment does not move.
 */
uniform sampler2D uAlbedo;
uniform float uApplyAlbedo;

out vec4 fragColor;

const float TAPS[${SKIN_BLUR_TAPS.length}] = float[${SKIN_BLUR_TAPS.length}](${list(SKIN_BLUR_TAPS)});
const float EDGES[${SKIN_BLUR_EDGES.length}] = float[${SKIN_BLUR_EDGES.length}](${list(SKIN_BLUR_EDGES)});

float viewZ(float depth) {
  float ndc = ${glslSceneDepthToNdc('depth')};
  return (uDepthToViewZ.x * ndc + uDepthToViewZ.y) / (uDepthToViewZ.z * ndc + uDepthToViewZ.w);
}

/** Burley's profile across a line, integrated from 0 to x: one half at infinity. */
vec3 burleyMass(float x, vec3 d) {
  return 0.5 - (exp(-x / d) + 3.0 * exp(-x / (3.0 * d))) * 0.125;
}

/**
 * The spread light times the skin's colour here, on the second axis; the light as it is on the
 * first. The colour target holds colour times coverage over coverage, so dividing gives the skin's
 * own colour at an edge, which the light — weighted for coverage already — is then multiplied by.
 */
vec3 withAlbedo(vec3 light) {
  if (uApplyAlbedo < 0.5) return light;
  vec4 albedo = textureLod(uAlbedo, vUv, 0.0);
  return light * albedo.rgb / max(albedo.a, 1e-4);
}

void main() {
  vec4 own = textureLod(uSkin, vUv, 0.0);
  /*
   * Not skin: nothing here to spread, and nothing to add. Any alpha is skin, because a pixel a
   * silhouette crosses under multisampling resolves to its covered share of the profile's code, and
   * its colour to that share of the diffuse, which is exactly what it owes the frame.
   */
  if (own.a < 1e-4) {
    fragColor = vec4(0.0);
    return;
  }
  float depth = textureLod(uDepth, vUv, 0.0).r;
  if (${glslIsFarDepth('depth')}) {
    fragColor = vec4(withAlbedo(own.rgb), own.a);
    return;
  }
  /* A part-covered pixel's code is its share of the whole: read it as the nearest, which is the
     right profile at half coverage and up, and a neighbouring one only on a silhouette below it. */
  int profile = clamp(int(own.a * 8.0 + 0.5) - 1, 0, ${SKIN_PROFILES - 1});
  vec3 d = max(uProfiles[profile].xyz, vec3(1e-6));
  float widest = max(d.r, max(d.g, d.b));
  float z = abs(viewZ(depth));
  /* The widest distance in pixels here: under half of one, there is nothing to spread across. */
  float pixels = widest * uFocal / max(z, 1e-4);
  if (pixels < 0.5) {
    fragColor = vec4(withAlbedo(own.rgb), own.a);
    return;
  }
  vec3 centre = 2.0 * burleyMass(EDGES[0] * widest, d);
  vec3 sum = own.rgb * centre;
  vec3 weight = centre;
  for (int i = 1; i < ${SKIN_BLUR_TAPS.length}; i++) {
    vec3 outer = i < ${SKIN_BLUR_EDGES.length} ? burleyMass(EDGES[min(i, ${SKIN_BLUR_EDGES.length - 1})] * widest, d) : vec3(0.5);
    vec3 w = outer - burleyMass(EDGES[i - 1] * widest, d);
    for (int side = -1; side <= 1; side += 2) {
      vec2 uv = vUv + uStep * (float(side) * TAPS[i] * pixels);
      vec4 tap = textureLod(uSkin, uv, 0.0);
      float tapZ = abs(viewZ(textureLod(uDepth, uv, 0.0).r));
      float keep = clamp(1.0 - abs(tapZ - z) / (4.0 * widest), 0.0, 1.0);
      /*
       * How much of the tap is skin: a filtered tap astride a silhouette is part skin and part
       * the black beside it, in colour and in alpha alike, so its alpha over this pixel's says the
       * share, and the colour is already that share of the skin's — counted as such, it neither
       * darkens the edge nor drops out.
       */
      float cover = clamp(tap.a / own.a, 0.0, 1.0);
      sum += tap.rgb * w * keep;
      weight += w * (cover * keep);
    }
  }
  fragColor = vec4(withAlbedo(sum / weight), own.a);
}
`;
