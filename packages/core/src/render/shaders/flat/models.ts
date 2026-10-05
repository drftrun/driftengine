/**
 * The lit stage's shading models: how a material that is not the standard one answers light.
 *
 * **One switch a model, each a pipeline constant, and a branch only ever on the switch itself.**
 * `MODEL_ANISOTROPIC`, `MODEL_HAIR`, `MODEL_SKIN` and `MODEL_EYE` are off in every pipeline but the
 * ones a material with that model asks for, so the device compiles every model out of the standard
 * pipelines and a scene that names none carries none — the arrangement `litSwitchesGlsl` has, for
 * its reason. Not one constant numbering the models: a comparison against an override is a
 * specialisation-constant operation, which the WGSL generator refuses (`overridableConstants`), so
 * every way in is a function that branches on the switches one at a time.
 *
 * **Where the models plug in.** `main` gathers the surface once (`modelSurface`), then asks at each
 * place light arrives: `modelLight` for the sun, each lamp and each rectangle, `modelAmbient` for
 * the sky and the probe's irradiance, `modelIrradiance` for DriftLight, `modelReflectNormal` and
 * `modelReflectance` for the environment's reflection. Each returns today's term for the standard
 * model, and each model's file is where its own answers are.
 *
 * **What a model returns from a light** is the two halves the standard terms are: a diffuse already
 * weighted by the angle of arrival, and a specular lobe in the engine's peak-normalised units (see
 * `specularLobe`), both before any shadow — the caller shadows the specular, and the diffuse through
 * `modelShade`, which is the identity but for skin, whose penumbra reddens.
 */
import { SURFACE_MODEL_SWITCH } from '../../surfaceModel.ts';
import type { SurfaceModelKind } from '../../surfaceModel.ts';
import { ANISOTROPIC_GLSL } from './anisotropic.ts';
import { HAIR_GLSL } from './hair.ts';
import { SKIN_GLSL } from './skin.ts';
import { EYE_GLSL } from './eye.ts';

/** The switches, the numbers, the surface every model reads, and the standard answer it falls back on. */
const MODELS_HEAD = /* glsl */ `
/* Which model a pipeline shades by. Each off but where a material asks for it: see models.ts. */
const bool MODEL_ANISOTROPIC = false;  // wgsl:override
const bool MODEL_HAIR = false;  // wgsl:override
const bool MODEL_SKIN = false;  // wgsl:override
const bool MODEL_EYE = false;  // wgsl:override
/*
 * Skin's screen-space scattering, as halves of one surface: the scene pass without its diffuse; a
 * pass that is nothing but the light the diffuse is made of, which the blur spreads; and a pass that
 * is nothing but the colour that light is multiplied by once it has spread. All off but where
 * \`skinScattering\` is \`'screen-space'\`; see \`skinBlur.ts\`.
 */
const bool SKIN_SCREEN = false;  // wgsl:override
const bool SKIN_DIFFUSE = false;  // wgsl:override
const bool SKIN_ALBEDO = false;  // wgsl:override
/*
 * Not a model of light but a page of it: the standard model, plus what a bake left (lightmap.ts).
 * Declared after skin's halves so that every switch before it keeps the id it shipped with.
 */
const bool MODEL_LIGHTMAP = false;  // wgsl:override
/*
 * Not a model either: whether this program carries GGX's own highlight for a material that asks
 * (\`SurfaceMaterial.physicalSpecular\`). A lit switch, off until a material first asks and then
 * on for good, as \`litSwitchesGlsl\`'s are; declared last so every switch before it keeps its id.
 */
const bool PHYSICAL_SPECULAR = PHYSICAL_SPECULAR_ON;  // wgsl:override

/*
 * A model's numbers, two vectors a material — the lit stage's uniform budget has no more room
 * (surfaceModel.ts) — and whether a model map is bound, in the last component.
 */
uniform vec4 uModelParams[2];
/* The model's own channels, in the albedo's layout: what each means is each model's to say. */
uniform highp sampler2DArray uModelMap;

/** Whether this pipeline shades by any model but the standard one. */
bool modelOn() {
  if (MODEL_ANISOTROPIC) return true;
  if (MODEL_HAIR) return true;
  if (MODEL_SKIN) return true;
  if (MODEL_EYE) return true;
  return false;
}

/** Whether this pipeline draws skin's diffuse alone, for the screen-space blur. */
bool modelDiffuseAlone() {
  if (MODEL_SKIN) {
    if (SKIN_DIFFUSE) return true;
  }
  return false;
}

/** Whether this pipeline draws skin's colour alone, which the spread light is multiplied by. */
bool modelAlbedoAlone() {
  if (MODEL_SKIN) {
    if (SKIN_ALBEDO) return true;
  }
  return false;
}

/** Whether light from behind the surface reaches the eye through it: hair, and skin's thin parts. */
bool modelSeesBehind() {
  if (MODEL_HAIR) return true;
  if (MODEL_SKIN) return true;
  return false;
}

/* The surface a model shades, gathered once in main before any light reaches it. */
vec3 mNormal;
vec3 mToEye;
vec3 mTangent;
vec3 mBitangent;
vec3 mAlbedo;
vec3 mSpecColor;
float mRoughness;
float mMetal;
vec4 mMap;
/*
 * What \`modelLight\` leaves: the diffuse weighted by its angle and the lobe, neither shadowed.
 * Globals rather than out parameters, because every parameter a call passes is a local, a store and
 * a pointer at each call site in \`main\` — sixteen copies of it, one a permutation.
 */
vec3 mDiffuse;
vec3 mSpecular;

/**
 * Normalised GGX — the distribution itself, not the engine's peak-normalised look — for the models
 * whose highlight is physical: skin's and the cornea's.
 */
float ggxLobe(float ndh, float alpha) {
  float a2 = alpha * alpha;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}

/** Smith's height-correlated masking with the BRDF's 1 / 4 N·L N·V folded in, for the same. */
float smithMasking(float ndl, float ndv, float alpha) {
  float a2 = alpha * alpha;
  return 0.5 / max(
    ndl * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndl * ndl * (1.0 - a2) + a2),
    1e-5
  );
}

/*
 * Whether this surface's highlights are GGX's own (\`SurfaceMaterial.physicalSpecular\`), from the
 * lane the standard, lightmap and anisotropic models leave free (\`packModel\`). Skin, hair and the
 * eye shade their own highlights, and the eye's axis holds that lane, so they are never asked. The
 * lit switch first, so a program built before any material asked carries none of it.
 */
bool physicalSpecular() {
  if (PHYSICAL_SPECULAR) {
    if (MODEL_HAIR) return false;
    if (MODEL_SKIN) return false;
    if (MODEL_EYE) return false;
    return uModelParams[1].z > 0.5;
  }
  return false;
}

/**
 * GGX as a BRDF in this engine's light units, \`π · D · Vis · N·L\` with Fresnel left to the caller:
 * the term skin's and the eye's highlights are, for a surface that asks for it. Its peak is
 * \`1 / (4 α²)\` of the light head-on, against the look's 1. A lamp's size widens α as \`sphereLobe\`
 * widens it, and a normalised distribution keeps its energy as it widens.
 */
float physicalLobe(float ndh, float ndl, float ndv, float roughness, float sourceRadius, float dist) {
  float grow = sourceRadius / max(2.0 * dist, 1e-3);
  float alpha = min(max(roughness * roughness, MIN_LOBE_ALPHA) + grow, 1.0);
  return 3.14159265 * ggxLobe(ndh, alpha) * smithMasking(ndl, max(ndv, 1e-4), alpha) * ndl;
}

/**
 * A highlight's colour: Schlick's Fresnel from the surface's reflectance toward white at a grazing
 * \`voh\`. On a metal alone for the look, whose dielectric attribute is a strength rather than a
 * reflectance; on every surface where the highlight is physical, whose attribute is its F0 — but
 * one reflecting nothing head-on keeps nothing, as the lamps' gate on that attribute has it.
 */
vec3 highlightTint(vec3 specColor, float voh, float metal) {
  float edge = pow(1.0 - voh, 5.0);
  bool reflects = max(max(specColor.r, specColor.g), specColor.b) > 0.0;
  return mix(specColor, vec3(1.0), physicalSpecular() && reflects ? edge : edge * metal);
}

/** The standard model's answer to one light, which a model falls back to for what it does not change. */
void standardLight(vec3 l, float sourceRadius, float dist) {
  float ndl = max(dot(mNormal, l), 0.0);
  vec3 h = normalize(l + mToEye);
  float ndh = max(dot(mNormal, h), 0.0);
  float lobe = physicalSpecular()
    ? physicalLobe(ndh, ndl, dot(mNormal, mToEye), mRoughness, sourceRadius, dist)
    : sourceRadius > 0.0
      ? sphereLobe(ndh, mRoughness, sourceRadius, dist)
      : specularLobe(ndh, mRoughness);
  vec3 tint = highlightTint(mSpecColor, max(dot(mToEye, h), 0.0), mMetal);
  mDiffuse = mAlbedo * ndl * (1.0 - mMetal);
  mSpecular = ndl > 0.0 ? tint * lobe : vec3(0.0);
}

`;

/** Where `main` asks: each model's answer, and the standard's where a model keeps it. */
const MODELS_DISPATCH = /* glsl */ `
/**
 * Where the material's maps are read: the surface's own coordinate, but for an eye, whose iris is
 * seen through its cornea and moved by it (\`eyeRefraction.ts\`). Before any map is read, and on a
 * branch on the switches alone, so its derivatives are in uniform control flow.
 */
vec3 modelSurfaceAt(vec3 at) {
  if (MODEL_EYE) return eyeRefract(at);
  return at;
}

/**
 * Gather the surface. The frame and the map read derivatives, so this is called under a branch on
 * the switches alone, which is uniform control flow by construction.
 */
void modelSurface(vec3 n, vec3 albedo, float roughness, float metal, vec3 at) {
  mNormal = n;
  mToEye = normalize(uCameraPos - vWorldPos);
  mat3 frame = tangentFrame(n, vWorldPos, vUv.xy, vTangent, vHasTangents);
  mTangent = frame[0];
  mBitangent = frame[1];
  mAlbedo = albedo;
  /*
   * **The diffuse half is light, not colour.** The blur spreads what this half writes, and what
   * spreads beneath skin is the light: a brow, a lip line and a freckle stay where they are drawn.
   * So this half shades a white surface and the colour is applied after the spread, from a half of
   * its own. Spreading the coloured diffuse smeared every mark on a face into the skin around it.
   */
  if (MODEL_SKIN) {
    if (SKIN_DIFFUSE) mAlbedo = vec3(1.0);
  }
  mSpecColor = mix(vec3(vSpecular), albedo, metal);
  mRoughness = roughness;
  mMetal = metal;
  mMap = vec4(0.5, 0.5, 1.0, 1.0);
  if (uModelParams[1].w > 0.0) mMap = texture(uModelMap, at);
  if (MODEL_ANISOTROPIC) anisotropicSurface();
  if (MODEL_HAIR) hairSurface();
  if (MODEL_SKIN) skinSurface();
  if (MODEL_EYE) eyeSurface(at);
}

/**
 * One light, arriving along \`l\` (unit, toward the light), from a source \`sourceRadius\` across at
 * \`dist\` — 0 for the sun. Into \`mDiffuse\`, weighted by its angle, and \`mSpecular\`, in lobe
 * units, neither shadowed.
 */
void modelLight(vec3 l, float sourceRadius, float dist) {
  if (MODEL_ANISOTROPIC) {
    anisotropicLight(l, sourceRadius, dist);
    return;
  }
  if (MODEL_HAIR) {
    hairLight(l, sourceRadius, dist);
    return;
  }
  if (MODEL_SKIN) {
    skinLight(l, sourceRadius, dist);
    return;
  }
  if (MODEL_EYE) {
    eyeLight(l, sourceRadius, dist);
    return;
  }
  standardLight(l, sourceRadius, dist);
}

/** How a shadow of \`shadow\` darkens this model's diffuse: the identity, but for hair and skin. */
vec3 modelShade(float shadow) {
  if (MODEL_HAIR) return hairShade(shadow);
  if (MODEL_SKIN) return skinShade(shadow);
  return vec3(shadow);
}

/** The sky's or the probe's light on this surface, before any reflection. */
vec3 modelAmbient(vec3 ambient) {
  if (MODEL_HAIR) return hairAround(ambient);
  if (MODEL_SKIN) {
    if (SKIN_SCREEN) return vec3(0.0);
  }
  return mAlbedo * ambient;
}

/** Light arriving from every side at once — DriftLight's — as this surface returns it. */
vec3 modelIrradiance(vec3 irradiance) {
  if (MODEL_HAIR) return hairAround(irradiance);
  if (MODEL_SKIN) {
    if (SKIN_SCREEN) return vec3(0.0);
  }
  return mAlbedo * irradiance * (1.0 - mMetal);
}

/** The normal the environment is reflected about: the surface's own, but for a stretched lobe. */
vec3 modelReflectNormal(vec3 n) {
  if (MODEL_ANISOTROPIC) return anisotropicReflectNormal(n);
  if (MODEL_HAIR) return hairAcross();
  return n;
}

/**
 * The environment the reflection blends toward: black in skin's diffuse pass, so the blend dims
 * the light before it by the reflection's share — as the whole surface's does, and only that light,
 * the lamps arriving after it — and adds none of the reflection, which is the scene pass's half.
 */
vec3 modelEnvironment(vec3 environment) {
  if (MODEL_SKIN) {
    if (SKIN_DIFFUSE) return vec3(0.0);
  }
  return environment;
}

/**
 * One texel of a page's irradiance layer: its four bytes put back into the rgb9e5 word they are,
 * lowest first, and decoded — three 9-bit mantissas over the exponent in the top five bits.
 */
vec3 bakedIrradianceAt(ivec3 texel) {
  uvec4 bytes = uvec4(texelFetch(uModelMap, texel, 0) * 255.0 + 0.5);
  uint word = bytes.x | (bytes.y << 8u) | (bytes.z << 16u) | (bytes.w << 24u);
  float scale = exp2(float(word >> 27u) - 24.0);
  return vec3(float(word & 511u), float((word >> 9u) & 511u), float((word >> 18u) & 511u)) * scale;
}

/**
 * What a baked page adds to this surface's diffuse: nothing in any pipeline but a lightmapped one,
 * nor in one whose page is missing. The page's two layers at the surface's second coordinates, which
 * ride the grain and relief lanes as \`-1 - uv\` (lightmap.ts) and are placed by the material's
 * region: the irradiance, and the first-order harmonic its direction is, answered by the shading
 * normal.
 *
 * **Filtered here, because the page cannot be filtered as it is stored**: the irradiance is a
 * shared-exponent word in four bytes, and a blend of two words is not the blend of their colours.
 * So the four texels around the sample are fetched, decoded and blended, as a bilinear sampler
 * clamped at the page's edge would. Fetches need no derivative, so the branch costs nothing there.
 */
vec3 modelBaked(vec3 n, vec3 albedo, float metal) {
  if (MODEL_LIGHTMAP) {
    if (uModelParams[1].w <= 0.0) return vec3(0.0);
    vec2 at = (vec2(-1.0) - vec2(vGrain, vRelief)) * uModelParams[0].xy + uModelParams[0].zw;
    ivec2 size = textureSize(uModelMap, 0).xy;
    vec2 texel = at * vec2(size) - 0.5;
    vec2 corner = floor(texel);
    vec2 f = texel - corner;
    ivec2 last = size - 1;
    ivec2 lo = clamp(ivec2(corner), ivec2(0), last);
    ivec2 hi = clamp(ivec2(corner) + 1, ivec2(0), last);
    vec3 irradiance = mix(
      mix(bakedIrradianceAt(ivec3(lo.x, lo.y, 0)), bakedIrradianceAt(ivec3(hi.x, lo.y, 0)), f.x),
      mix(bakedIrradianceAt(ivec3(lo.x, hi.y, 0)), bakedIrradianceAt(ivec3(hi.x, hi.y, 0)), f.x),
      f.y
    );
    vec4 direction = mix(
      mix(texelFetch(uModelMap, ivec3(lo.x, lo.y, 1), 0), texelFetch(uModelMap, ivec3(hi.x, lo.y, 1), 0), f.x),
      mix(texelFetch(uModelMap, ivec3(lo.x, hi.y, 1), 0), texelFetch(uModelMap, ivec3(hi.x, hi.y, 1), 0), f.x),
      f.y
    );
    vec4 d = direction * 2.0 - 1.0;
    return albedo * (1.0 - metal) * irradiance * max(dot(d.xyz, n) + d.w, 0.0);
  }
  return vec3(0.0);
}

/** Skin's diffuse as the diffuse pass writes it, from the lit total before emission, fogged. */
vec3 modelDiffuseOut(vec3 diffuse, float fog) {
  return diffuse * (1.0 - fog);
}

/**
 * How much of the environment the surface reflects — the blend's weight, Fresnel and all — from
 * what the standard model would.
 */
float modelReflectance(float standard) {
  if (MODEL_HAIR) return hairReflectance();
  if (MODEL_SKIN) return skinReflectance();
  if (MODEL_EYE) return eyeReflectance();
  return standard;
}
`;

/**
 * The models' whole chunk, at depth zero before `main`: see `flatFrag`. `physicalSpecular` is the
 * \`PHYSICAL_SPECULAR\` lit switch's value, written in as \`litSwitchesGlsl\` writes the others.
 */
export function modelsGlsl(physicalSpecular: boolean): string {
  return [
    MODELS_HEAD.replace('PHYSICAL_SPECULAR_ON', physicalSpecular ? 'true' : 'false'),
    ANISOTROPIC_GLSL,
    HAIR_GLSL,
    SKIN_GLSL,
    EYE_GLSL,
    MODELS_DISPATCH,
  ].join('\n');
}

/**
 * Which half of a skin a lit pipeline draws under `skinScattering: 'screen-space'`: the whole
 * surface (every other pipeline), the frame's half without its diffuse, the diffuse's light alone
 * into the blur's target, or the colour that light is multiplied by after the blur into a target
 * of its own — those last two depth-tested for equality against what the frame's half wrote and
 * writing none, since they are the same surface drawn again. See `skinBlur.ts`.
 */
export type SkinHalf = 'whole' | 'scene' | 'diffuse' | 'albedo';

/** The constant each half of a skin turns on. See `SkinHalf`. */
export const SKIN_HALF_SWITCH = {
  scene: 'SKIN_SCREEN',
  diffuse: 'SKIN_DIFFUSE',
  albedo: 'SKIN_ALBEDO',
} as const;

/** A skin lit stage with one half's switch on, WebGL2's way: see `SkinHalf`. */
export function skinHalfBound(source: string, half: SkinHalf): string {
  if (half === 'whole') return source;
  const name = SKIN_HALF_SWITCH[half];
  const off = `const bool ${name} = false;`;
  if (!source.includes(off)) {
    throw new Error(`skinHalfBound: this lit stage declares no ${name} constant`);
  }
  return source.replace(off, `const bool ${name} = true;`);
}

/**
 * An instanced vertex stage whose tint lane is a lightmap region: the same source, the constant
 * flipped — WebGL2's way. Only the instanced stage declares it.
 */
export function lightmapRegionsBound(source: string): string {
  const off = 'const bool LIGHTMAP_REGIONS = false;';
  if (!source.includes(off)) {
    throw new Error(
      'lightmapRegionsBound: this vertex stage declares no LIGHTMAP_REGIONS constant',
    );
  }
  return source.replace(off, 'const bool LIGHTMAP_REGIONS = true;');
}

/** A lit stage with one model's switch on: the same source, the constant flipped — WebGL2's way. */
export function modelBound(source: string, kind: SurfaceModelKind): string {
  const name = SURFACE_MODEL_SWITCH[kind];
  const off = `const bool ${name} = false;`;
  if (!source.includes(off)) {
    throw new Error(`modelBound: this lit stage declares no ${name} constant`);
  }
  return source.replace(off, `const bool ${name} = true;`);
}
