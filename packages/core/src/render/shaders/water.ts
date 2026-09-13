import { MAX_POINT_LIGHTS } from '../lightBudget.ts';
import { MAX_WATER_REFLECTION_FILTER_TAPS } from '../renderQuality.ts';
import { GERSTNER_GLSL } from './gerstner.ts';
import { FOG_GLSL } from './fog.ts';

/**
 * The sky-ocean, as an actual wave simulation rather than a tinted plane.
 *
 * Four summed Gerstner waves: unlike a sine heightfield, Gerstner displaces
 * vertices *horizontally* toward crests as well as vertically, which is what
 * produces sharp peaks and broad troughs instead of a rolling blanket. Normals
 * come analytically from the same sum, so lighting matches the geometry exactly
 * and needs no derivative tricks.
 *
 * The wave field itself lives in `gerstner.ts` because it is shared: the caustics
 * in `caustics.ts` are the light *this* surface throws onto what covers it, and
 * they must be the same water, not a lookalike animated separately.
 *
 * The grid follows the camera and is snapped to whole cells, giving an endless
 * ocean from a fixed vertex budget without the surface sliding underfoot.
 */
export const WATER_VERT = `#version 300 es
layout(location = 0) in vec2 aGrid;

uniform mat4 uViewProj;
uniform mat4 uReflectionViewProj;
uniform vec3 uCameraPos;
uniform float uTime;
/**
 * Where the sheet is laid, in world XZ.
 *
 * The ocean passes its own camera position snapped to whole cells, which is what
 * gives an endless sea from a fixed vertex budget without the surface sliding
 * underfoot. A *bounded* sheet — a pool in a courtyard — passes the middle of the
 * thing it is filling instead, and is world-fixed by construction.
 *
 * Snapped on the CPU rather than here so that one number is the only difference
 * between an ocean and a basin, and the shader has no idea which it is drawing.
 */
uniform vec2 uGridOrigin;
/**
 * Metres per unit of the sheet's own grid, along each of the body's own axes.
 *
 * One and one for the ocean, whose grid is authored in metres and is two meshes wide.
 * A bounded body — a pool, a tank, a puddle, a channel — is drawn from a unit sheet
 * and scaled by its own half-extents, which is what lets one mesh and one material
 * serve every body of water in the world.
 *
 * **Two numbers and not one since 2026-08-28.** A single span makes every bounded
 * body square, and a square that contains a channel floods the ground either side
 * of it. The ocean passes the same number twice and is bit-identical to what it was.
 */
uniform vec2 uGridSpan;
uniform vec2 uGridHalf;
uniform vec2 uNearHalf;
/**
 * The body's own +z, in world XZ, unit length. (0, 1) leaves the sheet unturned.
 *
 * A direction rather than an angle, so nothing here needs a trig call and a consumer
 * bounding a channel can hand over the direction its run already takes. The across
 * axis is world up crossed with this, \`(fz, -fx)\`, which is the basis
 * \`MeshBuilder.addOrientedBox\` builds from a forward vector — one convention for an
 * oriented thing, so a reader who has met one has met both.
 */
uniform vec2 uGridForward;
/** Prevailing wind bearing, normalised. Waves are steered toward it. */
uniform vec2 uWindDir;
/** Multiplier on authored steepness — how built-up the sea is. */
uniform float uWaveGain;
uniform float uWaterLevel;

out vec3 vWorldPos;
out vec3 vNormal;
out float vCrest;
out vec4 vReflectionClip;
/** Grid-local offset, so the sheet can fade out its own boundary. */
out vec2 vGrid;

${GERSTNER_GLSL}

void main() {
  /*
   * Waves must reach nothing by the near sheet's edge, because beyond it lies
   * the flat skirt. A displaced rim meeting an undisplaced skirt would tear the
   * surface open along a visible seam; fading first makes the two meshes agree
   * exactly where they meet. Chebyshev distance, so the fade band follows the
   * rectangular boundary rather than cutting an ellipse inside it.
   *
   * **Measured as a fraction of each axis' own extent**, which is what lets a
   * channel three metres across and twenty-one long fade evenly at both its ends
   * and both its sides. Against one shared extent the narrow axis would be inside
   * the fade band along its whole length and the water would never reach its own
   * bank. For the ocean, whose two extents are equal, this is the same arithmetic
   * with the division moved one step earlier.
   *
   * It is also the honest thing to draw. At a few hundred metres a 1 m swell is
   * well under a pixel, and out on the skirt a float32 phase argument has lost
   * most of its meaningful bits — a calm horizon is what an ocean actually looks
   * like from that far away.
   */
  vec2 grid = aGrid * uGridSpan;
  /* The same offset the fragment stage fades the rim on, so the two cannot disagree. */
  vGrid = grid;
  vec2 rimFraction = abs(grid) / max(uNearHalf, vec2(1e-4));
  float rimDistance = max(rimFraction.x, rimFraction.y);
  float waveFade = 1.0 - smoothstep(0.35, 0.97, rimDistance);

  /*
   * Into the world: across the body, then along it. \`right = up x forward\` is
   * \`(fz, -fx)\`, and getting that pair the wrong way round is a sheet mirrored
   * about its own axis, which on a square is invisible and on a channel is a
   * channel across the road instead of along it.
   */
  vec2 laid = vec2(uGridForward.y, -uGridForward.x) * grid.x + uGridForward * grid.y;

  vec3 base = vec3(uGridOrigin.x + laid.x, uWaterLevel, uGridOrigin.y + laid.y);

  GerstnerSurface sea = gerstnerSurface(base.xz, uTime, uWindDir, waveFade * uWaveGain);
  vec3 pos = base + sea.offset;

  vWorldPos = pos;
  vNormal = normalize(sea.normal);
  vCrest = sea.crest;
  vReflectionClip = uReflectionViewProj * vec4(pos, 1.0);
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

export const WATER_FRAG = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in float vCrest;
in vec4 vReflectionClip;
in vec2 vGrid;

uniform vec2 uGridHalf;
uniform float uFoamGain;
/**
 * How much of what is beneath it a body of water hides, looked straight down.
 *
 * The *density* of the water rather than a rendering trick: a sea hides its own
 * floor, a fountain shows the tiles at the bottom of it, and a puddle is nearly
 * clear. Only the nadir end is configurable — at a grazing angle every water
 * surface goes reflective, which is Fresnel and not a property of the liquid.
 */
uniform float uNadirOpacity;
/** The whole surface's visibility, 0 to 1. Zero draws nothing at all. */
uniform float uVisibility;
/**
 * How much this body mirrors regardless of the angle it is seen at, 0 to 1.
 *
 * Zero is physics: reflection is Fresnel alone, which is right for an ocean seen
 * across its own surface and which means *almost nothing* when you stand over a
 * basin and look down into it — the angle is steep, the Fresnel term is a few
 * percent, and a reflection nobody can see is the same as no reflection: the
 * character's reflection is technically present and far too faint to perceive.
 *
 * So a body may declare itself more mirror than water. It is a lie about optics
 * and an honest one about what a small pool is *for*: you look into it to see
 * something. The sea keeps zero and behaves exactly as it always has.
 */
uniform float uMirror;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uDirectionalDir;
uniform vec3 uDirectionalColor;
uniform vec3 uAmbient;
/**
 * The scene's point lights, which water is entitled to as much as stone is.
 *
 * The surface used to answer to the sun alone, on the reasonable assumption that water
 * is a thing that sits under the sky. It is not: a flooded corridor, a cistern, an
 * indoor pool and a harbour at night are all water lit entirely by lamps, and under
 * those this shaded to flat ambient — a coloured plane, with the specular glitter that
 * is the single strongest cue that a surface *is* water switched off because no
 * directional source existed to make it. A lantern on a jetty threw nothing.
 *
 * Same slots, same weights and the same two falloff shapes as the surface shader, so a
 * lamp behaves the same way over water as it does over the ground beside it.
 */
#define MAX_LIGHTS ${MAX_POINT_LIGHTS}
uniform int uLightCount;
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightColor[MAX_LIGHTS];
uniform float uLightRadius[MAX_LIGHTS];
uniform float uLightWeight[MAX_LIGHTS];
uniform int uLightFalloff;
${FOG_GLSL}
uniform vec3 uCameraPos;
uniform sampler2D uReflectionMap;
uniform int uReflectionEnabled;
uniform vec2 uReflectionTexelSize;
uniform int uReflectionFilterTaps;

const vec2 REFLECTION_FILTER[${MAX_WATER_REFLECTION_FILTER_TAPS}] = vec2[${MAX_WATER_REFLECTION_FILTER_TAPS}](
  vec2( 0.00,  0.00), vec2(-0.62, -0.31), vec2( 0.54,  0.43),
  vec2(-0.34,  0.76), vec2( 0.78, -0.57), vec2(-0.88,  0.28),
  vec2( 0.22, -0.91), vec2( 0.91,  0.08), vec2(-0.18,  0.94)
);
// Preserve small moving silhouettes such as a character while still spreading
// the surrounding taps enough to make the target read as rough water.
const float REFLECTION_FILTER_WEIGHT[${MAX_WATER_REFLECTION_FILTER_TAPS}] = float[${MAX_WATER_REFLECTION_FILTER_TAPS}](
  0.28, 0.09, 0.09, 0.09, 0.09, 0.09, 0.09, 0.09, 0.09
);

out vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 view = normalize(uCameraPos - vWorldPos);

  // Fresnel: water is nearly a mirror at grazing angles and clear straight down.
  // abs keeps the underside physically continuous with the top instead of
  // turning the entire surface into an opaque mirror below the waterline.
  float facing = clamp(abs(dot(n, view)), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);

  vec3 atmosphereColor = mediumColor();

  vec3 col = mix(uDeepColor, uShallowColor, clamp(vCrest * 1.4 + 0.4, 0.0, 1.0));
  vec3 incident = uAmbient +
    uDirectionalColor * max(dot(n, uDirectionalDir), 0.0) * 0.6;

  // Specular glitter along the crests — the strongest single cue that a surface
  // is water rather than a coloured plane.
  vec3 halfVec = normalize(uDirectionalDir + view);
  float spec = pow(max(dot(n, halfVec), 0.0), 220.0);
  vec3 highlight = uDirectionalColor * spec * 1.6;

  /*
   * And the same from every lamp in range: a light over water lights it, and glitters
   * on it. Indoors this is the whole of the surface's lighting.
   *
   * The exponent is the sun's, so a crest picks a lamp out as tightly as it picks out
   * the sky — which is what makes a strip light read as a *streak* across a pool rather
   * than a broad sheen. Weighted by presence like every other consumer of these slots,
   * so a light entering the set fades in instead of appearing.
   */
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 toLight = uLightPos[i] - vWorldPos;
    float lightDist = length(toLight);
    float falloff;
    if (uLightFalloff == 1) {
      float window = clamp(1.0 - pow(lightDist / max(uLightRadius[i], 1e-4), 4.0), 0.0, 1.0);
      falloff = window * window / max(lightDist * lightDist, 0.01);
    } else {
      falloff = clamp(1.0 - lightDist / max(uLightRadius[i], 1e-4), 0.0, 1.0);
    }
    if (falloff <= 0.0) continue;
    vec3 lightDir = toLight / max(lightDist, 1e-4);
    float shaped = falloff * uLightWeight[i];
    incident += uLightColor[i] * max(dot(n, lightDir), 0.0) * shaped * 0.6;
    vec3 lampHalf = normalize(lightDir + view);
    highlight += uLightColor[i] * pow(max(dot(n, lampHalf), 0.0), 220.0) * shaped * 1.6;
  }

  col *= incident;
  col += highlight;

  // Foam where crests peak — and only when the wind is actually breaking them.
  float foam = smoothstep(0.55, 0.85, vCrest) * uFoamGain;
  col = mix(col, vec3(0.92, 0.96, 1.0), foam * 0.5);

  float dist = distance(vWorldPos, uCameraPos);
  float fog = mediumFog(dist, vWorldPos.y);
  col = mix(col, atmosphereColor, fog);

  // Transparency is angle-dependent, like real water: looking down you see
  // straight through to the seabed, at grazing angles it turns reflective.
  // This is computed before reflection because straight-alpha compositing must
  // not attenuate reflected radiance a second time below.
  float airOpacity = mix(uNadirOpacity, 0.96, fresnel);
  float underwaterOpacity = mix(uNadirOpacity * 0.55, 0.88, fresnel);
  float opacity = mix(airOpacity, underwaterOpacity, uUnderwaterFactor);
  opacity = mix(opacity, 0.96, foam * 0.7);

  // Project the displaced surface into the mirrored camera. The Gerstner
  // displacement supplies broad distortion; the analytic normal adds the
  // smaller ripples that make reflected silhouettes move with each crest.
  vec3 reflected = atmosphereColor;
  float reflectionValid = 0.0;
  if (uReflectionEnabled != 0 && vReflectionClip.w > 0.0) {
    vec2 reflectionUv = vReflectionClip.xy / vReflectionClip.w * 0.5 + 0.5;
    reflectionUv += n.xz * mix(0.008, 0.022, fresnel);
    vec2 border = min(reflectionUv, 1.0 - reflectionUv);
    reflectionValid = smoothstep(0.0, 0.025, min(border.x, border.y));
    // A planar target is optically sharp, which is correct for a mirror but
    // wrong for a moving water surface. Broaden it over a Poisson footprint
    // that grows gently with viewing distance; normal displacement above
    // still makes every crest steer that softened image independently.
    float blurPixels = 1.35 + min(dist * 0.022, 3.5);
    vec3 sceneReflection = vec3(0.0);
    float filterWeight = 0.0;
    for (int i = 0; i < ${MAX_WATER_REFLECTION_FILTER_TAPS}; i++) {
      if (i >= uReflectionFilterTaps) break;
      vec2 sampleUv = reflectionUv +
        REFLECTION_FILTER[i] * uReflectionTexelSize * blurPixels;
      float weight = REFLECTION_FILTER_WEIGHT[i];
      /*
       * \`textureLod\` rather than \`texture\`, by the rule \`AGENTS.md\` records on 2026-08-07:
       * this loop is reached through a branch on \`vReflectionClip\`, which is not uniform, and
       * an implicit derivative there is undefined. **WGSL does not merely leave it undefined,
       * it refuses to compile the module**: *"'textureSample' must only be called from uniform
       * control flow"*, with the note that reading \`vReflectionClip\` may be non-uniform.
       *
       * Bit-identical on WebGL2: \`planarReflection.ts\` allocates one level and filters
       * \`LINEAR\`, so there is no mip to select and level zero is the only thing \`texture\`
       * could have read.
       */
      sceneReflection +=
        textureLod(uReflectionMap, clamp(sampleUv, 0.0, 1.0), 0.0).rgb * weight;
      filterWeight += weight;
    }
    sceneReflection /= max(filterWeight, 0.001);
    reflected = mix(atmosphereColor, sceneReflection, reflectionValid);
  }
  // The atmosphere-colour fallback preserves the old sky reflection when a
  // quality profile disables the extra scene pass. Foam scatters rather than
  // mirroring, so it masks the reflection at breaking crests.
  float sceneWeight = float(uReflectionEnabled) * reflectionValid;
  float reflectionGain = mix(0.75, 0.94, sceneWeight);
  // Angle-honest by default, and a mirror where a body says so. See uMirror above.
  float reflectivity = mix(fresnel, 1.0, uMirror);
  float reflectedRadiance = min(
    reflectivity * reflectionGain * (1.0 - foam * 0.8),
    opacity
  );
  // With SRC_ALPHA blending, mixing by Fresnel directly would multiply the
  // reflection by opacity again. Divide it out here so the framebuffer gets
  // the intended reflected fraction while the remainder stays transmissive.
  float reflectionWeight = reflectedRadiance / max(opacity, 0.001);
  col = mix(col, reflected, reflectionWeight);

  /*
   * Dissolve the sheet at its own boundary.
   *
   * Fading on fog alone made the horizon a function of the daily palette: a
   * clear day never reached the threshold, so the grid's rim — corner and all —
   * became the skyline. Fading on the grid coordinate cannot fail that way,
   * because alpha reaches zero at the last row of vertices by construction.
   * Chebyshev distance because the sheet is a rectangle, so the fade band
   * follows its four edges instead of cutting an ellipse out of it — and it is
   * measured per axis, or a channel's narrow sides would be one continuous fade
   * and it would have no visible edge at all.
   */
  vec2 rimFraction = abs(vGrid) / max(uGridHalf, vec2(0.001));
  float rimT = max(rimFraction.x, rimFraction.y);
  float rim = 1.0 - smoothstep(0.9, 1.0, rimT);
  // Fog still helps where it is thick, it just is no longer load-bearing.
  float edge = 1.0 - smoothstep(0.82, 1.0, fog);
  outColor = vec4(col, opacity * edge * rim * uVisibility);
}
`;
