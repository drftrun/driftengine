import { GERSTNER_GLSL } from './gerstner.ts';
import { FOG_GLSL } from './fog.ts';

/**
 * Light off water, projected onto what covers it.
 *
 * Everybody who has walked under a canal bridge has seen this: the soffit is
 * dark, and the water outside throws a moving net of light across it. Almost no
 * game bothers, because it needs the water and the enclosure to know about each
 * other — and the pattern has to belong to the waves actually visible five
 * metres away or it is a texture loop with extra steps.
 *
 * So it is computed from `gerstner.ts`, the same table, phase and clock the
 * surface itself is displaced by. Not similar parameters: the same ones.
 *
 * **The model.** A ray from the dominant source strikes the water at some point
 * and reflects up to the ceiling. To first order in the slope, the reflected ray
 * lands at `C = W - 2·d·grad h(W)`, so the map from water to ceiling has
 * Jacobian `J = I - 2·d·H`, with `H` the surface's Hessian and `d` the ray's
 * path length. Radiance is conserved, so brightness goes as `1/|det J|` — and it
 * is unbounded where `det J` crosses zero, which is the bright net. Troughs
 * focus and crests spread, exactly as a concave and a convex mirror do.
 *
 * Three consequences fall out rather than being authored, and they are what sell
 * it: the pattern crawls with the real crests; a low sun stretches the net and
 * throws it sideways along the light, because `d` is the slant path and not the
 * drop; and calm water gives a soft wide sheen where a built-up sea gives sharp
 * lines.
 *
 * **The gates**, because a caustic on the wrong surface is worse than none: the
 * sheet must be within a few metres of the water, on either side of it, and it
 * must be a surface the water can actually throw light onto — which is a
 * property of the geometry a caller submits. Enclosure is the caller's business
 * too, though a soffit needs less care than most: a downward face receives no
 * directional light in the first place, so the underside of anything solid is
 * already the darkest surface in the scene, and this reads there without a fake
 * ambient volume. A pool floor is the other half of the same effect and the more
 * ordinary one, and it wants the sheet laid just clear of the tiles.
 */
export const CAUSTICS_VERT = `#version 300 es
layout(location = 0) in vec3 aRest;
layout(location = 1) in vec2 aLocal;
/** x: resting height of the water below. y: spare. */
layout(location = 2) in vec2 aParams;

uniform mat4 uViewProj;

out vec3 vWorldPos;
out vec2 vLocal;
out vec2 vParams;

void main() {
  vWorldPos = aRest;
  vLocal = aLocal;
  vParams = aParams;
  gl_Position = uViewProj * vec4(aRest, 1.0);
}
`;

export const CAUSTICS_FRAG = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec2 vLocal;
in vec2 vParams;

uniform vec3 uCameraPos;
uniform vec2 uWindDir;
uniform float uWaveGain;
uniform float uTime;
/** Toward the dominant source, as everywhere else in the engine. */
uniform vec3 uLightDir;
/** Colour of the light the water is reflecting. */
uniform vec3 uTint;
uniform float uStrength;
/** How far from the water, on either side, the effect has died out entirely. */
uniform float uMaxDrop;
${FOG_GLSL}

out vec4 outColor;

${GERSTNER_GLSL}

/**
 * Shallowest the source may be and still be treated as a source.
 *
 * The slant path goes as 1/sin(elevation), so a light on the horizon would send
 * the sampled water position kilometres away and the pattern would smear into
 * noise. Clamping keeps a sunset dramatic instead of broken.
 */
const float MIN_ELEVATION = 0.16;

void main() {
  float waterY = vParams.x;
  float drop = vWorldPos.y - waterY;

  /*
   * Everything is masked rather than branched on, and fwidth() below is why:
   * screen-space derivatives are undefined in non-uniform control flow, so a
   * discard above them would make the antialiasing of the caustic lines a
   * driver-dependent guess. Nothing is saved by branching either — a masked
   * fragment adds zero under additive blending.
   *
   * Either side of the surface is lit, and the distance from it is what matters
   * rather than the direction. This began as a soffit-only effect — light thrown
   * *up* onto the underside of a bridge — on the reasoning that below the water
   * there is nothing to light. That is only true when the water is a ceiling to
   * you. A pool floor, a flooded corridor, a tank with a lamp over it: the water
   * focuses light onto the bottom exactly as it does onto a soffit, and it is by
   * far the more common of the two.
   *
   * Only the surface's own thin band is excluded, where the sheet and the water
   * are coplanar and the pattern would be meaningless.
   *
   * Too far from it and the net has spread into nothing. And the sheet dissolves
   * at its own boundary, so a lit surface does not end in a lit rectangle.
   */
  float distanceFromWater = abs(drop);
  float clear = step(0.02, distanceFromWater);
  float height = 1.0 - smoothstep(uMaxDrop * 0.45, uMaxDrop, distanceFromWater);
  float rim = min(min(vLocal.x, 1.0 - vLocal.x), min(vLocal.y, 1.0 - vLocal.y));
  float edge = smoothstep(0.0, 0.12, rim);
  float reach = clear * height * edge;

  /*
   * Which water lights *this* point. For a flat surface the reflected ray leaves
   * along the mirrored light direction, so walking back from the ceiling gives
   * the water position and the path length in one step. This is why the net
   * slides along the ground as the sun moves rather than sitting under itself.
   */
  float elevation = max(uLightDir.y, MIN_ELEVATION);
  float slant = 1.0 / elevation;
  float d = drop * slant;
  vec2 water = vWorldPos.xz + uLightDir.xz * d;

  vec3 h = gerstnerCurvature(water, uTime, uWindDir, uWaveGain);
  float a = 1.0 - 2.0 * d * h.x;
  float b = 1.0 - 2.0 * d * h.y;
  float c = 2.0 * d * h.z;
  float det = a * b - c * c;

  /*
   * The bright net is where the determinant crosses zero, so its width is a
   * gradient question, not a constant. Widening the core by the screen-space
   * derivative antialiases it for free — without that, a line thinner than a
   * pixel strobes as the camera moves, which is the usual reason an effect like
   * this ends up looking like noise.
   */
  float soft = max(0.05, fwidth(det) * 1.6);
  float lines = soft / max(abs(det), soft);
  /*
   * Between the lines, the faint brightening of merely convergent water — and it has to
   * stay faint. At 0.45 it lit the *whole* sheet, and since the sheet hangs a few
   * centimetres under the soffit, the result read as a pale plate floating below the
   * bridge rather than as light on its underside — reported as being able to see through
   * the bridge ceiling, which looked glassy and transparent. The plate was the sheet.
   *
   * A tighter threshold and a fifth of the weight: the net is bright, everything between
   * it is almost nothing, and a soffit with no caustics on it is simply a soffit.
   */
  float sheen = clamp(1.0 / max(abs(det), 0.18) - 0.85, 0.0, 1.0);
  float caustic = clamp(lines * 0.9 + sheen * 0.09, 0.0, 1.6);

  float fog = mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y);

  // Additive: this is light arriving at a surface that is already shaded.
  outColor = vec4(uTint * (caustic * uStrength * reach * (1.0 - fog)), 1.0);
}
`;
