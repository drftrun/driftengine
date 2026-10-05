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
 * Skin's screen-space scattering, as two halves of one surface: the scene pass without its diffuse,
 * and a pass that is nothing but it, which the blur spreads before it is added back. Both off but
 * where \`skinScattering\` is \`'screen-space'\`; see \`skinBlur.ts\`.
 */
const bool SKIN_SCREEN = false;  // wgsl:override
const bool SKIN_DIFFUSE = false;  // wgsl:override

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

/** The standard model's answer to one light, which a model falls back to for what it does not change. */
void standardLight(vec3 l, float sourceRadius, float dist) {
  float ndl = max(dot(mNormal, l), 0.0);
  vec3 h = normalize(l + mToEye);
  float ndh = max(dot(mNormal, h), 0.0);
  float lobe = sourceRadius > 0.0
    ? sphereLobe(ndh, mRoughness, sourceRadius, dist)
    : specularLobe(ndh, mRoughness);
  vec3 tint = mix(mSpecColor, vec3(1.0), pow(1.0 - max(dot(mToEye, h), 0.0), 5.0) * mMetal);
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

/** The models' whole chunk, at depth zero before `main`: see `flatFrag`. */
export const MODELS_GLSL = [
  MODELS_HEAD,
  ANISOTROPIC_GLSL,
  HAIR_GLSL,
  SKIN_GLSL,
  EYE_GLSL,
  MODELS_DISPATCH,
].join('\n');

/**
 * Which half of a skin a lit pipeline draws under `skinScattering: 'screen-space'`: the whole
 * surface (every other pipeline), the frame's half without its diffuse, or the diffuse alone into
 * the blur's target — that last one depth-tested for equality against what the frame's half wrote
 * and writing none, since it is the same surface drawn again. See `skinBlur.ts`.
 */
export type SkinHalf = 'whole' | 'scene' | 'diffuse';

/** A skin lit stage with one half's switch on, WebGL2's way: see `SkinHalf`. */
export function skinHalfBound(source: string, half: SkinHalf): string {
  if (half === 'whole') return source;
  const name = half === 'scene' ? 'SKIN_SCREEN' : 'SKIN_DIFFUSE';
  const off = `const bool ${name} = false;`;
  if (!source.includes(off)) {
    throw new Error(`skinHalfBound: this lit stage declares no ${name} constant`);
  }
  return source.replace(off, `const bool ${name} = true;`);
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
