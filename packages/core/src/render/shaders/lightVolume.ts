/**
 * Light in the air: a beam, a shaft through a window, the cone under a lamp.
 *
 * **Its own program because the thing it draws is not a surface.** A surface is lit, fogged
 * and gated by the time of day; light is none of those, and every attempt to express a beam
 * as a material failed in a different place for the same underlying reason. The recorded
 * history, because it is the whole justification for this file existing:
 *
 * - **Alpha blended, it darkened the sky.** Alpha blending moves what is behind a surface
 *   *toward* that surface's own colour, so an unlit beam that came out darker than the dusk
 *   behind it swept a solid dark wedge across the frame. It was reported five times as a
 *   giant malformed bird, which is what a ninety-metre wedge crossing a flock looks like.
 * - **Additive through the flat pass, it vanished.** The fog term is a `mix` toward the
 *   medium's colour, applied to something that *is* the medium being lit, and ninety metres
 *   of it multiplied to nothing. Twenty times the emissive did not bring it back.
 *
 * So: nothing here is lit, nothing here is fogged, and nothing here is scaled by night. A
 * beam is *more* visible in fog, not less, because the fog is what there is to light. The
 * closest precedent in this renderer is `bolt.ts`, which says the same thing about a
 * discharge and for the same reason.
 *
 * **The volume comes from the grazing term, not from the geometry.** A single surface cannot
 * be a volume, so what is drawn is a few flat panes through the beam's own axis, and each
 * fragment is weighted by how far from face-on the pane is turned. A pane seen face-on
 * contributes almost nothing; a pane seen edge-on contributes fully, which is exactly when a
 * line of sight travels furthest through the slab that pane stands for. Because the panes
 * cross at the axis, the ones that are edge-on are the ones whose bright part *is* the axis,
 * and the result is a soft core down the middle with no hard edge anywhere. A tube would
 * have given the opposite and read as a hollow pipe.
 *
 * **What that leaves out, and what the two optional terms below are for.** The shape above is
 * a monotone falloff along two axes times a constant per pane, so for the pass's whole first
 * life *nothing in it varied per fragment*. A consumer swept strength from 1.5 to 3.2 and
 * spread from 0.038 to 0.13 across six captures and reported the obvious consequence: the beam
 * gets brighter and wider and its shape never changes, which reads as a lit solid rather than
 * as light standing in air. Neither term is on by default, because a torch beam wants neither
 * and every volume drawn before they existed is entitled to the frame it had.
 *
 * - **`uDust`** breaks the body up with a noise field in world space. What is missing from a
 *   smooth cone is any variation at all, so the field does not have to be the one the scene's
 *   own motes use, and it deliberately does not read a clock: the offset is a position the
 *   caller supplies, so a consumer that evaluates arbitrary instants out of order reproduces
 *   the same frame every time. That is the same rule the wind field is under.
 * - **`uSunShadow`** cuts the volume where the sun does not reach, sampling the directional
 *   map the surfaces below are already shaded by. It is what makes a shaft carry the bars of
 *   the window it came through, and without it a barred floor under a smooth shaft is two
 *   halves of one frame disagreeing about the same light.
 */

import { resolveConditionals } from './conditionals.ts';

export const LIGHT_VOLUME_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
layout(location = 3) in float aEmissive;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec3 vColor;
out float vEnergy;
out vec3 vNormal;
out vec3 vWorldPos;
/**
 * The position in the volume's own space, which is where its shape is known.
 *
 * The falloffs along the axis and away from it are the two things that make this read as
 * light rather than as a pane, and both are smooth functions of *where in the volume* a
 * fragment is. There is no way to author them into the geometry: MeshBuilder states one
 * emissive per quad, so a gradient built that way is a staircase, and the first version of
 * this beam was eight steps a pane trying to hide that. A local position costs one varying
 * and gives both gradients per pixel.
 */
out vec3 vLocal;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  vLocal = aPosition;
  /*
   * The normal is rotated by the model matrix without being corrected for scale. A light
   * volume is placed by a rigid transform and a uniform scale, which leaves a normal pointing
   * where it was; the inverse transpose exists for non-uniform scale, and paying for one here
   * would be describing a case this pass does not have.
   */
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vEnergy = aEmissive;
  gl_Position = uViewProj * world;
}
`;

/** What the light volume program is built with. See `flatFrag` for why this is a permutation. */
export interface LightVolumeShaderOptions {
  /**
   * Whether the sun-shadow lookup is compiled in at all.
   *
   * A profile with directional shadows off has no map to read, and three `sampler2D`
   * declarations it can never reach are three the driver is handed anyway. The same
   * reasoning as the flat shader's permutation, at a twentieth of the scale.
   */
  readonly directionalShadows: boolean;
}

export function lightVolumeFrag(options: LightVolumeShaderOptions): string {
  return resolveConditionals(
    `#version 300 es
precision highp float;

in vec3 vColor;
in float vEnergy;
in vec3 vNormal;
in vec3 vWorldPos;
in vec3 vLocal;

uniform vec3 uCameraPos;
/** How much of the authored light to add, 0 to 1. A caller fades a beam with this. */
uniform float uStrength;
/**
 * How far the volume reaches along its own +Z, in the units its geometry was built in.
 *
 * The light dies at this distance rather than at whatever the geometry happens to end at,
 * which is what lets a beam dissolve into the air instead of stopping at a bright square.
 */
uniform float uLength;
/**
 * How wide the volume opens, as half-width over distance: the tangent of its half-angle.
 *
 * A cone of this aperture is where the light reaches zero, so the geometry should be built to
 * about the same shape. Larger than the geometry leaves a hard edge at the polygon; smaller
 * fades out before the polygon ends, which is safe and merely narrower than it looks.
 */
uniform float uSpread;
/**
 * How much of the beam's body the dust field takes away, 0 to 1. At 0 nothing is computed.
 *
 * An amount rather than a switch, because the useful range is narrow and low: this is the
 * difference between a shaft and a solid, not a texture to be read.
 */
uniform float uDust;
/** Metres per cell of the field. Small is fine dust; large is smoke and shafts of weather. */
uniform float uDustScale;
/**
 * Where the field has drifted to, in metres.
 *
 * A position and not a rate, so nothing in this pass reads a clock. Air moves, and what moves
 * it is the scene's wind, which the caller already samples once a frame for everything else in
 * the air; handing that same accumulated drift here is what keeps the motes in a shaft going
 * the way the smoke outside it goes. It also lets a caller that renders instants out of order
 * ask for any one of them twice and get the same frame.
 */
uniform vec3 uDustOffset;

#if DIRECTIONAL_SHADOWS
/** How much of the volume the sun's own shadow map removes, 0 to 1. At 0 nothing is sampled. */
uniform float uSunShadow;
uniform mat4 uLightViewProj;
uniform float uShadowMapSize;
uniform sampler2D uStaticShadowMap;
uniform sampler2D uPeeledShadowMap;
uniform sampler2D uDynamicShadowMap;
uniform int uPeeledShadowEnabled;
#endif

out vec4 fragColor;

/** Where the drawn volume starts along its own +Z, so a shaft can be a slice of a wide cone. */
uniform float uNear;
/** Camera position in the volume's own space, so the whole march happens in one frame of reference. */
uniform vec3 uCameraLocal;
/** The volume's placement, used only to put a sample back into world space for dust and shadow. */
uniform mat4 uModelWorld;
/** How many samples the ray takes. See lightVolumeSamples on the renderer's quality options. */
uniform int uSamples;

/**
 * The frame's own depth, so the march stops where the light actually lands.
 *
 * **Without this a ray is bounded by the hull and by nothing else**, so a beam whose hull
 * continues past a solid surface keeps integrating light through it: the shaft carries on under
 * the floor and terminates on the hull's boundary rather than on the ground. Reported from Drift
 * Cut about \`cathedral-of-light\` — the ray on the ground read as unnatural — and it was never a
 * difference between the backends, because both did it. \`demo/dev/volume.html\` is the page that
 * shows it, and \`?length=\` is what turns a hard edge into an unmistakable slab.
 *
 * A *copy* of the depth rather than the attachment itself. Neither backend may sample the depth
 * it is currently testing against: WebGL2 calls it undefined and WebGPU rejects the pass, so the
 * renderer takes a single-sample copy before the first volume of the frame draws.
 */
uniform sampler2D uSceneDepth;
/** Zero where no copy could be taken, and then nothing below runs. See \`uSceneDepth\`. */
uniform int uSceneDepthEnabled;
/** One over the drawing buffer, to turn \`gl_FragCoord\` into the copy's own coordinates. */
uniform vec2 uInvViewport;
/**
 * Straight from a stored depth to this volume's local space, in one matrix.
 *
 * **Built on the CPU, per draw, because the two backends disagree about clip space and this is
 * the only place that disagreement can live without a second shader.** It is the inverse of
 * (clip correction × view-projection × model), with the depth remap folded in: WebGL2 stores
 * depth in [0,1] and wants NDC z in [-1,1], WebGPU stores and wants [0,1], so one backend's
 * matrix carries a remap the other's does not. The shader is then identical for both and reads
 * \`vec4(ndc.xy, stored, 1)\` without knowing which it is running on.
 *
 * Local rather than world, so the clamp is in the same units as \`enter\` and \`leave\` and costs
 * no second transform inside the march.
 */
uniform mat4 uDepthToLocal;

/** How quickly the light dies toward the far end. Above 1 keeps the near half bright. */
const float ALONG_POWER = 1.3;
/**
 * How quickly it dies away from the axis. This is what gives the beam a core.
 *
 * Two rather than the one the pane version used, and the difference is the march. A pane is a
 * thin sheet, so a linear falloff across it already looked tight; integrating the same falloff
 * along a ray sums every value it passes through, and the shoulders that were invisible on one
 * sheet accumulate into a haze with no edge. Squaring puts the beam back inside its own cone.
 */
const float ACROSS_POWER = 2.0;
/** The most a march will cover, as a multiple of the volume's own length. A ray running along
    the axis would otherwise have no far bound at all when the slab clip degenerates. */
const float MAX_SPAN = 2.0;
/** The enclosing cylinder's radius, as a multiple of the cone's own far radius. See the clip. */
const float WIDEST = 1.05;
/**
 * How much light a volume gives up per unit of normalised path. See the end of main.
 *
 * Not derived from anything: it sets where the usable range of strength sits, and it is
 * chosen so a beam authored against the pass this replaced lands at about the brightness it had. Raising it makes every volume saturate sooner rather than making any of them better.
 */
const float VOLUME_GAIN = 3.0;
/**
 * Depth tolerance for the shadow lookup, and the width the comparison ramps over.
 *
 * There is no acne to bias away from here, since nothing in the air shadows itself; the offset
 * covers the map's own quantisation, which would otherwise stipple the inside of a shaft where
 * the light and the air agree about it.
 */
const float BIAS = 0.0015;
const float SOFTEN = 0.0025;

float hash31(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

/**
 * Value noise on a world position, trilinear between eight corners of a cell.
 *
 * Its own rather than the sky's, because the sky's is two-dimensional and a shaft of light is
 * a body seen from any side: a 2D field extruded along an axis is a set of stripes as soon as
 * the camera moves off that axis, which is precisely the view a shaft is looked at from.
 */
float volumeNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float x00 = mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), u.x);
  float x10 = mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), u.x);
  float x01 = mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), u.x);
  float x11 = mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

/**
 * Two octaves, and the second one is what stops it reading as a lava lamp.
 *
 * One octave is a field of soft blobs whose size the eye immediately measures, which replaces
 * "no structure" with "one structure". Two is where the picture stopped changing.
 */
float dustField(vec3 p) {
  return volumeNoise(p) * 0.65 + volumeNoise(p * 2.17 + 19.3) * 0.35;
}

#if DIRECTIONAL_SHADOWS
/**
 * How much sun reaches one point in the air.
 *
 * Deliberately not the flat shader's shadowFactor, and the difference is why this is short.
 * Almost everything expensive there is about a receiving *surface*: a receiver-plane depth
 * gradient from screen derivatives, a terminator fade by the angle between a normal and the
 * light, a slope bias. A point in the air has no normal, no plane and no self-shadowing, so
 * none of it applies and none of it is paid for.
 *
 * One tap, because the march is already averaging tens of samples along the ray and a filter
 * on top of that is paying twice for the same softness.
 *
 * textureLod at level zero rather than plain texture: these maps carry one storage level and
 * NEAREST filtering, so the fetch is identical, and an implicit derivative reached through the
 * early exits above is exactly the shape AGENTS.md 2026-08-07 is about.
 */
/**
 * A ramp rather than a comparison, which is what keeps the march's own dither invisible.
 *
 * A hard test makes every sample along a ray fully lit or fully dark, so where a shaft crosses
 * the edge of an occluder the only thing separating neighbouring pixels is *how many* of their
 * samples fell on each side — an integer, over a couple of dozen samples, and the dither pattern
 * that decides it becomes legible as a screen door. Softening the comparison over a few
 * centimetres of depth gives each sample a fractional answer near the boundary, and the pattern
 * goes with it. It costs one smoothstep and buys back nothing else: away from an edge this is
 * still exactly 0 or 1.
 */
float occlusion(float stored, float compare) {
  return smoothstep(-SOFTEN, SOFTEN, compare - stored);
}

float sunReach(vec3 worldPos) {
  vec4 lightPos = uLightViewProj * vec4(worldPos, 1.0);
  if (lightPos.w <= 0.0) return 1.0;
  vec3 p = lightPos.xyz / lightPos.w * 0.5 + 0.5;
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;

  /*
   * Fade toward lit at the border of the map rather than cutting at it, for the reason the
   * flat shader gives: the map covers a radius around the viewer, and a hard edge makes a
   * shaft's bars blink on as the camera walks toward them.
   */
  vec2 fromCentre = abs(p.xy - 0.5) * 2.0;
  float edgeFade = 1.0 - smoothstep(0.72, 0.98, max(fromCentre.x, fromCentre.y));
  edgeFade *= 1.0 - smoothstep(0.90, 1.0, p.z);
  if (edgeFade <= 0.0) return 1.0;

  float compare = p.z - BIAS;
  float blocked = occlusion(textureLod(uStaticShadowMap, p.xy, 0.0).r, compare);
  if (uPeeledShadowEnabled != 0) {
    blocked = max(blocked, occlusion(textureLod(uPeeledShadowMap, p.xy, 0.0).r, compare));
  }
  blocked = max(blocked, occlusion(textureLod(uDynamicShadowMap, p.xy, 0.0).r, compare));
  return mix(1.0, 1.0 - blocked, uSunShadow * edgeFade);
}
#endif

/**
 * How much light the air holds at one point of the volume, in its own space.
 *
 * **The two falloffs are measured against different things, and that is deliberate.** Along the
 * axis, the fade runs across the extent actually drawn, from full at uNear to nothing at uLength, so a volume is brightest where it starts whatever a caller chose to draw. Across
 * the axis it is measured from the *apex*, because the aperture is an angle and an angle is
 * only meaningful from the point it opens at.
 *
 * The alternative, running both from the apex, was what shipped first and it punishes exactly
 * the case the near plane exists for. A shaft of daylight is authored as a slice taken far down
 * a very wide cone, so that it barely widens over the room; measured from the apex, that slice
 * begins two thirds of the way down its own fade and arrives at a quarter of the light, and the
 * scene it was measured on read as haze rather than as a shaft. Nothing about being a slice
 * should make a volume dim.
 */
float densityAt(vec3 local, float near) {
  float drawn = max(uLength - near, 1e-4);
  float along = clamp((local.z - near) / drawn, 0.0, 1.0);
  float openness = length(local.xy) / max(local.z, 1e-3);
  float across = clamp(openness / max(uSpread, 1e-4), 0.0, 1.0);
  return pow(1.0 - along, ALONG_POWER) * pow(1.0 - across, ACROSS_POWER);
}

void main() {
  /*
   * The ray, in the volume's own space.
   *
   * **This pass integrates rather than draws sheets, and that is the whole of the second
   * rewrite.** What it used to do was rasterise a few flat panes through the axis and weight
   * each fragment by how far from face-on its pane was turned, which is a stand-in for the
   * path length a line of sight takes through the slab that pane represents. It works from the
   * side and it cannot work down the barrel: every pane contains the axis, so a view lying near
   * that axis lies nearly *within all of them at once*, each one collapses to a narrow bright
   * wedge on screen, and their union reads as a six-armed asterisk rather than as the disc a
   * cone's cross-section actually is. It was reported twice from outside, once as a beam whose
   * shape never changed however it was tuned and once as raw lines in the opening of a room,
   * and switching the pass off in a single capture is what identified the second one.
   *
   * No stand-in survives that, because the failure is not in the weight — it is that a handful
   * of flat sheets is not a volume. So the geometry is now only a hull that decides which
   * pixels to run on, and every one of them walks the ray itself. The path length falls out of
   * the walk instead of being modelled, which is also why the grazing term is gone rather than
   * corrected: there is nothing left for it to stand in for.
   */
  vec3 origin = uCameraLocal;
  vec3 toFragment = vLocal - origin;
  float span = length(toFragment);
  vec3 dir = span > 1e-5 ? toFragment / span : vec3(0.0, 0.0, 1.0);

  /*
   * Clipped to the volume twice: the slab it occupies along its axis, and the cylinder that
   * encloses its widest point.
   *
   * The slab alone is what shipped first and it is only tight for a ray running down the barrel.
   * Side-on, which is how a beam is almost always watched, a ray crosses the slab in one step
   * and the clip does nothing at all: the march then spreads its samples over the fallback span
   * while the beam itself is a few metres thick, so a handful of samples land inside it and the
   * rest integrate empty air. It arrives as the beam breaking into a row of separate blobs, and
   * that is what a ninety-metre lighthouse beam did on the first capture of this pass.
   *
   * The enclosing cylinder is the cheap half of the fix and gets the common case: one quadratic
   * in xy, always a bounded interval, and conservative, since the cone is inside the cylinder
   * and no real volume can be clipped away. A ray-cone test would be tighter and brings a second
   * nappe behind the apex and a sign flip in the quadratic with it, for samples that the
   * across-axis falloff already values at zero.
   */
  float near = min(uNear, uLength);
  float enter = 0.0;
  float leave = uLength * MAX_SPAN;
  if (abs(dir.z) > 1e-5) {
    float toNear = (near - origin.z) / dir.z;
    float toFar = (uLength - origin.z) / dir.z;
    enter = min(toNear, toFar);
    leave = max(toNear, toFar);
  } else if (origin.z < near || origin.z > uLength) {
    discard;
  }

  float reach = uSpread * uLength * WIDEST;
  float ca = dot(dir.xy, dir.xy);
  float cb = 2.0 * dot(origin.xy, dir.xy);
  float cc = dot(origin.xy, origin.xy) - reach * reach;
  if (ca > 1e-8) {
    float disc = cb * cb - 4.0 * ca * cc;
    if (disc <= 0.0) discard;
    float root = sqrt(disc);
    enter = max(enter, (-cb - root) / (2.0 * ca));
    leave = min(leave, (-cb + root) / (2.0 * ca));
  } else if (cc > 0.0) {
    /* Parallel to the axis and outside the cylinder: this ray never enters the volume. */
    discard;
  }

  enter = max(enter, 0.0);
  leave = min(leave, enter + uLength * MAX_SPAN);

  /*
   * And clipped a third time, by whatever the frame already drew at this pixel.
   *
   * The two clips above are both about the *hull*, and a hull knows nothing about the room it
   * is in. This is the one that makes the beam end on the floor instead of passing through it:
   * the stored depth is where the eye ray met something opaque, so no air beyond it is lit and
   * none of it may be integrated.
   *
   * \`hit.w\` is the perspective divide and it can be non-positive for a pixel at the far plane
   * on some projections, which would flip the comparison and clamp the march to nothing — a
   * beam that vanishes wherever it crosses the sky. Guarded rather than assumed.
   */
  if (uSceneDepthEnabled != 0) {
    vec2 uv = gl_FragCoord.xy * uInvViewport;
    float stored = textureLod(uSceneDepth, uv, 0.0).r;
    vec4 hit = uDepthToLocal * vec4(uv * 2.0 - 1.0, stored, 1.0);
    if (hit.w > 1e-6) {
      leave = min(leave, dot(hit.xyz / hit.w - origin, dir));
    }
  }

  if (leave <= enter) discard;

  int samples = clamp(uSamples, 2, 64);
  float step = (leave - enter) / float(samples);

  /*
   * The samples sit on an even lattice, and only the shadow lookup is dithered off it.
   *
   * **Which half gets the jitter took three captures to get right.** A march that starts every
   * ray at the same place quantises anything with a hard edge in it into shells, so a shaft
   * crossing an occluder needs its shadow lookup dithered or the boundary arrives as bands.
   * Jittering the *sample positions* to achieve that is the obvious move and it is wrong: the
   * offset shifts every sample on a ray together, so against a smooth integrand it does not
   * average out at all, it slides the whole integral along the integrand's own gradient. Two
   * captures found it twice, once as a rattle over the body of a dusty shaft and once as a
   * screen door down the length of a ninety-metre beam carrying no dust and no shadow, which
   * is what finally named it: the term with nothing sharp in it was the one being spoiled.
   *
   * So the lattice is the plain midpoint rule, which for a smooth density is both quieter and
   * more accurate, and the dither is applied only where something is genuinely discontinuous.
   * The pattern is ordered rather than random — any four-by-four block covers the step at
   * sixteen evenly spaced offsets, so a block averages to the truth however a shadow edge falls
   * across it — and roughened inside its own sixteenth, because a regular figure is what an eye
   * finds once a step is worth about one value of an eight-bit channel.
   */
  const float BAYER[16] = float[16](
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  int cell = int(mod(gl_FragCoord.y, 4.0)) * 4 + int(mod(gl_FragCoord.x, 4.0));
  float shadowOffset = ((BAYER[cell] + hash31(vec3(gl_FragCoord.xy, 3.7))) / 16.0 - 0.5) * step;

  float total = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= samples) break;
    float travelled = enter + (float(i) + 0.5) * step;
    vec3 local = origin + dir * travelled;

    float density = densityAt(local, near);
    if (density <= 0.0) continue;

    vec3 world = (uModelWorld * vec4(local, 1.0)).xyz;
    if (uDust > 0.0) {
      density *= mix(1.0, dustField((world + uDustOffset) / max(uDustScale, 1e-3)), uDust);
    }
#if DIRECTIONAL_SHADOWS
    if (uSunShadow > 0.0) {
      vec3 dithered = (uModelWorld * vec4(origin + dir * (travelled + shadowOffset), 1.0)).xyz;
      density *= sunReach(dithered);
    }
#endif
    total += density;
  }

  /*
   * The integral, made dimensionless, then saturated.
   *
   * A raw metre-integral is what the physics wants and is unusable as an authored value: the
   * same settings that read as a shaft across a room would arrive white on a ninety-metre beam,
   * because the longer one simply has more air in it. So it is divided by a length belonging to
   * the volume itself.
   *
   * **The aperture, and not the length, which is the mistake this was written with.** Dividing
   * by the axial extent looks like the obvious choice and quietly assumes every ray runs down
   * the axis. Almost none do: a shaft is nearly always watched from the side, where a ray
   * crosses only the cone's width, so the first version of this divided a two-metre crossing by
   * a twelve-metre extent and the volume arrived at a fifth of the light it should have. It was
   * invisible in the frame and it was invisible in the arithmetic, which is why it took a debug
   * capture writing the span and the accumulation into separate channels to see that the march
   * was running correctly the whole time and only the last line was wrong. The far radius is the
   * transverse scale, so a side-on ray now lands near 1 and an axial one, which really does
   * travel further through more air, lands brighter.
   *
   * Saturating rather than clipping, because a volume of light is a medium: doubling the dust in
   * a shaft does not double what comes out of it, and a linear term either reads flat at usable
   * settings or blows to a white slab past them. This cannot exceed 1 whatever it is handed.
   */
  float reference = max(uSpread * uLength, 1e-4);
  float lit = 1.0 - exp(-total * step / reference * VOLUME_GAIN);

  /*
   * Alpha is 1 and the energy is in the colour, because the blend is SRC_ALPHA, ONE. Putting
   * it in both squares it, which is how an effect authored as bright arrives as faint. Every
   * emissive material in this renderer has to pick one channel and mean it: see bolt.ts.
   */
  fragColor = vec4(vColor * (vEnergy * lit * uStrength), 1.0);
}
`,
    { DIRECTIONAL_SHADOWS: options.directionalShadows },
    'lightVolume',
  );
}
