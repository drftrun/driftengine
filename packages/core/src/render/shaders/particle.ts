import { FOG_GLSL } from './fog.ts';
import { OUTPUT_TRANSFORM_GLSL } from './outputTransform.ts';
import { MAX_POINT_LIGHTS } from '../lightBudget.ts';

/**
 * Particle materials: soft smoke, hot sparks, and unlit motes.
 *
 * One vertex program, three fragment programs, and the split is the same one the
 * plumes already make — `PLUME_VERT` places a volume and the fragment decides
 * whether it is fire or smoke. Here the vertex program places a particle as a
 * **camera-facing quad**, or as a world-fixed cross of two when a caller asks, and
 * the fragment decides whether it is a puff of grit, an ember, or an unlit point.
 *
 * **The cross was the only option and then the default, and is now neither.** The
 * argument for it is the one `plumeRenderer` records at length, and it is a real
 * one: a billboard has no parallax, so orbiting a plume shows the identical
 * silhouette from every angle and the whole effect swivels as a sheet, where two
 * fixed blades genuinely bring one broadside as the other goes edge-on. What that
 * argument leaves out is what the going-edge-on blade *draws*. It does not fade as
 * it turns; it compresses, and a sprite compressed into a one-pixel column spends
 * its entire brightness in that column. On smoke it hides inside the noise. On an
 * additive spark it is a bright straight line through the middle of every particle,
 * which is how it was finally caught. `uCameraFacing` carries the full account and
 * the terms of the trade for anyone who wants the blades back.
 *
 * **These replace drawing particles through the foliage shader**, which is what
 * every effect built on `ParticlePool` used to do. Grass is opaque, lit
 * two-sided, and has no opacity channel — so a grain of smoke was a solid cube
 * lit like a leaf, and its "fade" was its colour being driven to black — which reads
 * as squared-off smoke that never had a shader of its own, against fire that did.
 * This is that missing quality: a soft body eroded by
 * the same value noise, an honest alpha, and real lighting.
 */

/**
 * Blades in the cross, and the vertices and indices that costs.
 *
 * Still two under `facing: 'camera'`, where the second is collapsed to zero area in the
 * vertex stage rather than dropped here — so one pair of buffers serves both facings and a
 * batch chooses per pool. See `uCameraFacing`.
 */
export const PARTICLE_BLADES = 2;
export const PARTICLE_VERTS = PARTICLE_BLADES * 4;
export const PARTICLE_INDICES = PARTICLE_BLADES * 6;

/**
 * Shared noise. Value noise, two octaves, exactly the construction `SMOKE_FRAG`
 * uses — a particle and a plume standing in the same scene must not be eroded by
 * different mathematics, or the small effect reads as a different material from
 * the large one it is supposed to be a wisp of.
 */
const PARTICLE_NOISE = `
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float billow(vec2 p, float t, int octaves) {
  float v = valueNoise(p * 2.4 + vec2(0.0, -t * 0.5)) * 0.62;
  if (octaves == 1) return v / 0.62;
  v += valueNoise(p * 5.1 + vec2(t * 0.15, -t * 0.8)) * 0.38;
  return v / 1.0;
}
`;

export const PARTICLE_VERT = `#version 300 es
/** Per-vertex: the quad corner, and which blade of the cross it belongs to. */
layout(location = 0) in vec2 aCorner;
layout(location = 1) in float aBlade;
/** Per-instance. */
layout(location = 2) in vec3 aPos;
layout(location = 3) in float aSize;
layout(location = 4) in float aSpin;
layout(location = 5) in vec3 aColor;
/** Opacity, age as a share of life, and this particle's own seed. */
layout(location = 6) in float aAlpha;
layout(location = 7) in float aAge;
layout(location = 8) in float aSeed;
layout(location = 9) in vec3 aVelocity;

uniform mat4 uViewProj;
uniform vec3 uCameraPos;
/**
 * How far a particle is stretched along its own motion, in seconds of travel.
 *
 * Zero for smoke, which has no direction worth seeing. A spark is the opposite
 * case: an ember crossing a metre in a frame drawn as a round dot reads as a
 * floating pixel, and the same ember drawn as a short streak along its velocity
 * reads as a thrown spark. The eye gets its motion cue from the shape.
 */
uniform float uStretchSec;
/**
 * 1 to turn a single quad to face the camera, 0 to draw the world-fixed cross.
 *
 * **Camera-facing is the default, and the cross is the option.** It was the other way
 * round until a caller drew an additive glow with a camera looking down -Z and got a
 * bright straight line through the middle of every sprite. The cross is two blades at
 * right angles in *world* space: blade 0 spans X, blade 1 spans Z. Look down either
 * axis and that blade is edge-on, and a disc squeezed into a one-pixel column does not
 * lose the energy it was drawn with — it puts all of it in that column. Alpha-blended
 * smoke half hides it behind its own noise. Additive has nothing to hide it with.
 *
 * Fading a blade out as it turns edge-on fixes that one case and not the matching one:
 * both blades contain world Y, so a camera looking straight down sees *both* edge-on
 * and the puff is a plus sign of two lines, or nothing at all once they are faded. A
 * camera-facing quad has no angle at which it thins, which is why it is what particle
 * systems generally draw.
 *
 * The cross is still worth keeping. Two blades give real parallax when a camera moves
 * through a puff, and that is a volume cue a single quad cannot fake — worth having in
 * a ground-level world whose camera never looks far off the horizontal, where the
 * edge-on blade stays a thin sliver inside soft smoke rather than a line across a
 * spark. It also costs a brightness that swings with the view: a cross covers one
 * sprite of area seen down an axis and about 1.4 seen from the diagonal, so a puff
 * quietly pulses as the camera orbits it. A camera-facing quad covers the same area
 * from everywhere.
 */
uniform float uCameraFacing;

out vec2 vUv;
out vec3 vColor;
out float vAlpha;
out float vAge;
out float vSeed;
out vec3 vWorldPos;
out vec3 vNormal;

void main() {
  float s = sin(aSpin);
  float c = cos(aSpin);
  // Roll within the blade's own plane, so the two blades never look like one
  // rigid object turning.
  vec2 rolled = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c);

  /*
   * The plane the corners are laid out in, built from the particle's centre rather than
   * from the corner being transformed, so all four corners of a quad share one basis and
   * the quad stays planar and rectangular.
   */
  vec3 across;
  vec3 up;
  float bladeGain;
  if (uCameraFacing > 0.5) {
    vec3 toCamera = normalize(uCameraPos - aPos);
    /* Any reference not parallel to the view. World up serves everywhere except looking
       straight up or down it, where the two are the same line and the cross product
       vanishes; +Z takes over there. */
    vec3 reference = abs(toCamera.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    across = normalize(cross(reference, toCamera));
    up = cross(toCamera, across);
    /*
     * One quad, not two. Both blades face the camera here, so they would land on exactly
     * the same pixels and the second would be nothing but the first drawn again: double
     * the fill for double the brightness no caller asked for. Collapsing it to zero area
     * costs nothing — the rasteriser drops a degenerate triangle before it shades — and
     * leaves the vertex and index buffers the shape both backends already build, so a
     * batch picks its facing without either one rebuilding its geometry.
     */
    bladeGain = aBlade < 0.5 ? 1.0 : 0.0;
  } else {
    across = aBlade < 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
    up = vec3(0.0, 1.0, 0.0);
    bladeGain = 1.0;
  }
  vec3 offset = (across * rolled.x + up * rolled.y) * aSize;

  /*
   * Stretched along travel. Applied as an extra displacement on the component of
   * the corner that already points along the motion, so a stationary particle is
   * untouched and a fast one lengthens without also getting fatter.
   */
  if (uStretchSec > 0.0) {
    vec3 travel = aVelocity * uStretchSec;
    float along = dot(normalize(offset + vec3(1e-6)), normalize(travel + vec3(1e-6)));
    offset += travel * along * 0.5;
  }

  /* bladeGain applied here, after the stretch rather than before it, so a dropped blade
     is degenerate whatever the stretch added: all four of its corners land on aPos. */
  vec3 world = aPos + offset * bladeGain;
  vUv = aCorner;
  vColor = aColor;
  vAlpha = aAlpha;
  vAge = aAge;
  vSeed = aSeed;
  vWorldPos = world;
  /*
   * The blade's own facing, flipped toward the viewer. A cross has no meaningful
   * outward normal, and a puff of smoke is not a surface — but it does have to be
   * *lit*, and a normal facing the camera is the standard, honest cheat for a
   * volume approximated by cards: it makes the puff read as a lump catching light
   * from wherever the light is, rather than as a flat panel that goes black at
   * some angles.
   */
  vec3 face = cross(across, up);
  vec3 toEye = normalize(uCameraPos - world);
  vNormal = dot(face, toEye) < 0.0 ? -face : face;

  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

/**
 * Smoke, grit and dust: a soft body eroded by noise, alpha blended, and lit.
 *
 * Lit by the sun, the ambient *and* the nearby point lights, which is the half
 * the foliage path could never do. A drift at night beside a brazier threw grey
 * grit whatever the brazier was doing, because grass has no point-light term —
 * and unlit smoke in a world lit by fires is the tell that gives an effect away
 * fastest. A puff catching a flame's colour is most of what makes it belong.
 */
export const PARTICLE_SMOKE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vColor;
in float vAlpha;
in float vAge;
in float vSeed;
in vec3 vWorldPos;
in vec3 vNormal;

uniform float uTime;
uniform vec3 uDirectionalDir;
uniform vec3 uDirectionalColor;
uniform vec3 uAmbient;
uniform vec3 uCameraPos;
uniform int uNoiseOctaves;
/** How strongly the noise eats into the puff. 0 is a plain soft ball. */
uniform float uErosion;

#define MAX_LIGHTS ${MAX_POINT_LIGHTS}
uniform int uLightCount;
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightColor[MAX_LIGHTS];
uniform float uLightRadius[MAX_LIGHTS];
// How present each light is, 0 to 1. See pointLightSelection.ts.
uniform float uLightWeight[MAX_LIGHTS];

${FOG_GLSL}
${PARTICLE_NOISE}

out vec4 outColor;
${OUTPUT_TRANSFORM_GLSL}

void main() {
  /*
   * A round, soft body first. 'smoothstep' rather than a hard disc: the edge is
   * the entire difference between a puff and a sprite, and a cut-off circle reads
   * as a decal however good the noise inside it is.
   */
  float r = length(vUv);
  float body = 1.0 - smoothstep(0.35, 1.0, r);
  if (body <= 0.0) discard;

  /*
   * Then eaten into by noise that drifts and coarsens as the puff ages, so it
   * dissipates by *breaking up* rather than by uniformly thinning. Uniform
   * thinning is what a fading sprite does, and it is what the old cube did.
   */
  float t = uTime * 0.55 + vSeed * 7.31;
  float n = billow(vUv * (0.9 + vAge * 1.4) + vec2(vSeed * 3.7, 0.0), t, uNoiseOctaves);
  float erode = mix(1.0, n, uErosion * (0.35 + vAge * 0.65));
  float mask = clamp(body * erode, 0.0, 1.0);
  // Feather the last of it out rather than letting a noise threshold flicker.
  mask *= smoothstep(0.0, 0.25, mask);
  if (mask <= 0.002) discard;

  vec3 n3 = normalize(vNormal);
  /*
   * Wrapped diffuse. Smoke transmits as well as reflects, so the terminator on a
   * puff sits well past 90° — a hard 'max(dot, 0)' gives a lump with a black side,
   * which is exactly the "coloured box" failure the fidelity rules name.
   */
  float ndl = dot(n3, uDirectionalDir) * 0.5 + 0.5;
  vec3 lit = uAmbient + uDirectionalColor * ndl;

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 toLight = uLightPos[i] - vWorldPos;
    float dist = length(toLight);
    float radius = uLightRadius[i];
    if (radius <= 0.0 || dist >= radius) continue;
    float falloff = 1.0 - dist / radius;
    float wrapped = dot(n3, toLight / max(dist, 1e-4)) * 0.5 + 0.5;
    lit += uLightColor[i] * falloff * falloff * wrapped * uLightWeight[i];
  }

  vec3 shaded = vColor * lit;
  float fog = mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y);
  outColor = vec4(applyOutputTransform(mix(shaded, mediumColor(), fog)), mask * vAlpha);
}
`;

/**
 * Sparks and embers: additive, hot in the middle, and stretched along travel.
 *
 * No lighting at all, deliberately — a spark *is* a light source, and shading it
 * is what turned the first version into a grey cube at night. The core is allowed
 * past white so it reads as incandescent rather than as a pale dot.
 */
export const PARTICLE_SPARK_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vColor;
in float vAlpha;
in float vAge;
in float vSeed;
in vec3 vWorldPos;
in vec3 vNormal;

uniform float uTime;
uniform vec3 uCameraPos;
/** How far past white the centre may go. */
uniform float uCoreGain;
${FOG_GLSL}
${PARTICLE_NOISE}

out vec4 outColor;
${OUTPUT_TRANSFORM_GLSL}

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;

  /*
   * Two falloffs again — a tight core and a broad halo — because one gives either
   * a hard dot or a soft smudge. The halo is what makes a shower of embers read
   * as glowing air rather than as a scatter of points.
   */
  float core = pow(1.0 - clamp(r, 0.0, 1.0), 6.0);
  float halo = pow(1.0 - clamp(r, 0.0, 1.0), 1.6);

  /*
   * Embers flicker as they tumble and cool. Per-particle phase from the seed, so
   * a shower crackles instead of pulsing as one body.
   */
  float flick = 0.7 + 0.3 * valueNoise(vec2(uTime * 9.0 + vSeed * 13.0, vSeed));

  // Cooling: the last of a spark's life is dimmer as well as smaller.
  float cool = 1.0 - vAge * vAge;
  float energy = (halo * 0.55 + core * uCoreGain) * flick * cool * vAlpha;

  float fog = mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y);
  energy *= 1.0 - fog;
  /*
   * Alpha 1, energy in the colour — see the note in 'bolt.ts'. Additive blending is
   * 'rgb * a', so carrying the energy in both channels squares it and quietly halves
   * every emissive effect in the game.
   */
  outColor = vec4(applyOutputTransform(vColor * energy), 1.0);
}
`;

/**
 * Dust motes and drifting glints: unlit, alpha blended, and fogged only when the caller asks.
 *
 * **What neither existing material could draw.** `'spark'` is unlit but additive — its
 * fragment stage folds its whole brightness into colour and always writes alpha 1, because
 * additive blending is `rgb * a` and a real alpha there would double the energy (the note at
 * the end of `PARTICLE_SPARK_FRAG` explains why). `'smoke'` has a real, varying alpha, but pays
 * for it with lighting it can never turn off. A point that is unlit *and* genuinely
 * translucent — what three.js's `PointsMaterial` draws, and what drei's `Sparkles` is built on
 * — was not expressible by either.
 *
 * No noise, no core-and-halo split: a mote is not a body being eroded and it is not
 * incandescent, so borrowing either shape would draw the wrong material behind the right blend
 * state. This is the plainest fragment stage in the file on purpose — a soft round point whose
 * colour is nothing but its own vColor and whose opacity is nothing but its own vAlpha.
 *
 * **Fog is the one thing this material still asks the caller about.** A mote is the one
 * particle a scene legitimately wants both ways: dust caught in a shaft of light recedes into
 * haze exactly like anything else out there, but a field of them meant to read as flat, close
 * atmosphere — the look this exists for — must not. `'spark'` and `'smoke'` take no such
 * option and stay unconditionally fogged, matching every particle drawn before this material
 * existed; see `ParticleBatchOptions.fog`.
 */
export const PARTICLE_MOTE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vColor;
in float vAlpha;
in float vAge;
in float vSeed;
in vec3 vWorldPos;
in vec3 vNormal;

uniform vec3 uCameraPos;
/**
 * Whether the fragment stage mixes toward the medium's own colour at all. 0 — what a batch
 * gets by leaving ParticleBatchOptions.fog unset — leaves vColor untouched by distance, which
 * is what a caller reaching for this material over 'spark'/'smoke' is usually asking for: an
 * unlit point drawn exactly as its own colour says. 1 mixes toward mediumColor() by
 * mediumFog(), the same medium every other pass in the frame recedes into.
 */
uniform int uFogEnabled;
${FOG_GLSL}

out vec4 outColor;
${OUTPUT_TRANSFORM_GLSL}

void main() {
  /*
   * One soft, round falloff — no erosion, no core past white, because this material draws
   * neither a body being eaten by noise nor a light source. Squared rather than linear so the
   * edge feathers instead of ramping, which is what keeps a field of these reading as dust
   * rather than as a scatter of hard-edged discs.
   */
  float r = length(vUv);
  float body = 1.0 - smoothstep(0.4, 1.0, r);
  if (body <= 0.0) discard;
  float alpha = body * body * vAlpha;
  if (alpha <= 0.002) discard;

  vec3 color = vColor;
  if (uFogEnabled != 0) {
    float fog = mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y);
    color = mix(color, mediumColor(), fog);
  }
  /*
   * A real alpha blend (SRC_ALPHA, ONE_MINUS_SRC_ALPHA) rather than spark's energy-in-colour
   * trick: this point genuinely occludes what little is behind it instead of adding light to it.
   */
  outColor = vec4(applyOutputTransform(color), alpha);
}
`;
