import { FOG_GLSL } from './fog.ts';

/**
 * Electrical arcs: a filament with a saturating core and a wide soft glow.
 *
 * **Additive, and deliberately over-bright.** A discharge is not a surface with a
 * colour, it is light arriving — so nothing here is lit, shaded or fogged the way
 * geometry is, and the core is allowed to exceed white so it reads as blinding
 * rather than as a pale line. That is the whole difference between lightning and a
 * drawn wire, and it is why this cannot be a variant of the flat material.
 *
 * Each segment of an arc is expanded into a quad that faces the viewer, which for
 * a *filament* is correct where it would be wrong for a volume: a bolt has no
 * thickness to see around, so a world-fixed cross (what `plumeRenderer` uses, for
 * good reasons of its own) would only make half the segments vanish edge-on. What
 * gives an arc its three-dimensionality is the path, and the path is world-space.
 */

export const BOLT_VERT = `#version 300 es
layout(location = 0) in vec3 aFrom;
layout(location = 1) in vec3 aTo;
/** Along the segment (0 or 1), and which side of it (-1 or +1). */
layout(location = 2) in vec2 aCorner;
/** Where this segment sits along its arc, the arc's envelope, its seed, its gain. */
layout(location = 3) in vec4 aArc;

uniform mat4 uViewProj;
uniform vec3 uCameraPos;
/** Core half-width in metres, and how much of a pixel a far arc must still cover. */
uniform float uWidth;
uniform float uMinWidthPerMetre;

out float vSide;
out float vAlong;
out float vFade;
out float vSeed;
out float vGain;
out vec3 vWorldPos;

void main() {
  vec3 mid = mix(aFrom, aTo, aCorner.x);
  vec3 dir = aTo - aFrom;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec3(0.0, 1.0, 0.0);

  vec3 view = mid - uCameraPos;
  float dist = length(view);
  view = dist > 1e-6 ? view / dist : vec3(0.0, 0.0, 1.0);

  /*
   * Across the segment and across the line of sight. Degenerate exactly when the
   * segment points at the viewer, where any perpendicular is as good as another —
   * and where the segment covers almost no screen anyway.
   */
  vec3 across = cross(dir, view);
  float span = length(across);
  across = span > 1e-4 ? across / span : normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-3));

  /*
   * A floor on the world-space width that grows with distance, so a filament
   * never thins below a pixel. Under a pixel a bright thin line does not get
   * fainter, it *flickers* — the rasteriser catches it on some frames and not
   * others — and a strobing artefact reads as a bug, not as lightning.
   */
  float halfWidth = max(uWidth, dist * uMinWidthPerMetre);
  vec3 world = mid + across * aCorner.y * halfWidth;

  vSide = aCorner.y;
  vAlong = aArc.x;
  vFade = aArc.y;
  vSeed = aArc.z;
  vGain = aArc.w;
  vWorldPos = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const BOLT_FRAG = `#version 300 es
precision highp float;

in float vSide;
in float vAlong;
in float vFade;
in float vSeed;
in float vGain;
in vec3 vWorldPos;

uniform float uTime;
/** The saturating centre, and the glow it sits inside. */
uniform vec3 uCoreColor;
uniform vec3 uEdgeColor;
/** How far past white the core is allowed to go. */
uniform float uCoreGain;
${FOG_GLSL}
uniform vec3 uCameraPos;

out vec4 outColor;

float hash11(float p) {
  return fract(sin(p * 12.9898) * 43758.5453123);
}

void main() {
  /*
   * Across the filament: 1 at the centre line, 0 at the quad's edge. Two powers
   * of it are the entire look — a very tight one for the core and a loose one for
   * the glow. A single falloff gives either a hard line with no atmosphere or a
   * soft smudge with no filament.
   */
  float across = 1.0 - abs(vSide);
  float core = pow(across, 10.0);
  /*
   * A *wide* halo, deliberately. This exponent is the single biggest control over
   * whether the effect reads as lightning or as a drawn line: a tight falloff gives a
   * crisp filament with nothing around it, which is a wire, while a broad one bleeds
   * light into the air the way an over-exposed discharge does on film. It is the
   * closest thing to bloom available without a second pass.
   */
  float glow = pow(across, 1.1);

  /*
   * Stutter. An arc is not a steady light: it is re-established many times a
   * second, and the eye reads a *constant* bright line as neon. Two frequencies
   * so the pattern does not read as a sine, and per-arc phase from the seed so
   * several arcs never blink together.
   */
  /*
   * Stutter, but shallow. An arc is re-established many times a second and a perfectly
   * steady bright line reads as neon — but too *much* flicker reads as a broken effect
   * rather than as a discharge, and at the brief lifetime these now have, deep flicker
   * mostly hides the bolt. The path itself is already being redrawn (see 'BoltPool'),
   * which carries most of the crackle; this only keeps the brightness alive.
   */
  float t = uTime * 47.0 + vSeed * 17.0;
  float stutter = 0.78 + 0.22 * (hash11(floor(t)) * 0.6 + hash11(floor(t * 2.37)) * 0.4);

  /*
   * The tip tapers. An arc that ends in a squared-off quad reads as a drawn
   * segment; thinning toward the far end is what makes it read as a discharge
   * dissipating into the air.
   */
  float taper = 1.0 - vAlong * 0.55;

  float energy = vFade * stutter * taper * vGain;
  vec3 lit = uEdgeColor * glow + uCoreColor * core * uCoreGain;

  /*
   * Distance dims it rather than tinting it toward the fog. A discharge emits;
   * mixing it into the medium's colour is what a *surface* does, and doing that
   * here turned a far bolt grey instead of faint.
   */
  float fog = mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y);
  /*
   * Alpha is 1, and the energy is already in the colour.
   *
   * The additive blend is 'SRC_ALPHA, ONE', so what reaches the framebuffer is
   * 'rgb * a'. Putting the energy in both — which the first version did — squares it,
   * and squaring a number below one is how an effect authored as blinding arrives as
   * faint: at a typical energy of 0.5 it delivered a quarter of what it asked for.
   * Every emissive material here has to pick one channel and mean it.
   */
  outColor = vec4(lit * energy * (1.0 - fog), 1.0);
}
`;
