/**
 * The hair model in GLSL: `hairLobes.ts` is the same arithmetic, and its tests hold the lobes to
 * their tilted peaks, the transmitted lobe to the backlight, the sum to what a white strand
 * receives, and every term to a finite answer where the geometry degenerates.
 *
 * **The strand is the tangent, root to tip.** The model map's green turns each strand's tilt by up
 * to half of it either way (0.5 is none) and its blue is occlusion, which the sky, DriftLight and
 * the environment's reflection take and the lamps do not — their shadows are theirs to cast. The
 * red is not read: a colour from root to tip is the albedo map's to carry.
 *
 * **The environment** is the reflected lobe's: mirrored about a normal turned toward the eye across
 * the strand, which is the cone R lies on, at the strand's own Fresnel — the lobe integrates to it
 * over every direction of arrival. **What it gives up** is the two transmitted lobes against the
 * sky, which a head of hair lit from behind by an open sky would show as a rim; the lamps carry
 * them.
 */
import { HAIR_F0, HAIR_MIN_BETA, HAIR_SCATTER_SPHERE } from '../../hairLobes.ts';

export const HAIR_GLSL = /* glsl */ `
const float HAIR_F0 = ${HAIR_F0.toFixed(9)};
const float HAIR_MIN_BETA = ${HAIR_MIN_BETA.toFixed(3)};
const float HAIR_SCATTER_SPHERE = ${HAIR_SCATTER_SPHERE.toFixed(3)};

/* This texel's tilt, gathered once with the surface. */
float hShift;

void hairSurface() {
  hShift = uModelParams[0].x * (0.5 + mMap.g);
}

/** A longitudinal lobe: a normalised Gaussian of width \`beta\` at \`x\` from its centre. */
float hairLongitudinal(float beta, float x) {
  return exp(-0.5 * x * x / (beta * beta)) / (2.5066283 * beta);
}

float hairFresnel(float cosine) {
  float c = 1.0 - clamp(cosine, 0.0, 1.0);
  return HAIR_F0 + (1.0 - HAIR_F0) * c * c * c * c * c;
}

/** The normal turned toward the eye across the strand: the scatter's and the environment's. */
vec3 hairAcross() {
  vec3 across = mToEye - mTangent * dot(mTangent, mToEye);
  float length2 = dot(across, across);
  return length2 > 1e-8 ? across * inversesqrt(length2) : mNormal;
}

void hairLight(vec3 l, float sourceRadius, float dist) {
  vec3 t = mTangent;
  float sinI = clamp(dot(t, l), -1.0, 1.0);
  float sinO = clamp(dot(t, mToEye), -1.0, 1.0);
  /* Floored for the half angle's limit, whose single-precision cosine is negative: hairLobes.ts. */
  float cosD = max(cos(0.5 * abs(asin(sinO) - asin(sinI))), 1e-3);
  vec3 lp = l - sinI * t;
  vec3 vp = mToEye - sinO * t;
  float cosPhi = dot(lp, vp) * inversesqrt(dot(lp, lp) * dot(vp, vp) + 1e-4);
  float cosHalfPhi = sqrt(clamp(0.5 + 0.5 * cosPhi, 0.0, 1.0));
  float beta = max(mRoughness * mRoughness, HAIR_MIN_BETA);
  float grow = sourceRadius / max(2.0 * dist, 1e-3);
  float x = sinI + sinO;

  float r = hairLongitudinal(beta + grow, x + 2.0 * hShift) * 0.25 * cosHalfPhi
    * hairFresnel(sqrt(clamp(0.5 + 0.5 * dot(l, mToEye), 0.0, 1.0)));

  float a = 1.0 / (1.19 / cosD + 0.36 * cosD);
  float h = cosHalfPhi * (1.0 + a * (0.6 - 0.8 * cosPhi));
  float fTT = hairFresnel(cosD * sqrt(clamp(1.0 - h * h, 0.0, 1.0)));
  float tt = hairLongitudinal(0.5 * beta + grow, x - hShift) * exp(-3.65 * cosPhi - 3.98)
    * (1.0 - fTT) * (1.0 - fTT) * uModelParams[0].z;
  float ttPower = 0.5 * sqrt(clamp(1.0 - h * h * a * a, 0.0, 1.0)) / cosD;

  float fTRT = hairFresnel(0.5 * cosD);
  float trt = hairLongitudinal(2.0 * beta + grow, x - 3.0 * hShift) * exp(17.0 * cosPhi - 16.78)
    * (1.0 - fTRT) * (1.0 - fTRT) * fTRT;

  /* Above zero, so pow never takes the logarithm of nothing: hairLobes.ts. */
  vec3 fibre = max(mAlbedo, vec3(1e-4));
  /* π: the published lobes are per unit irradiance, and a lamp here is π of that. */
  mSpecular = 3.14159265 * (vec3(r) + tt * pow(fibre, vec3(ttPower)) + trt * pow(fibre, vec3(0.8 / cosD)));
  float wrapped = clamp((dot(hairAcross(), l) + 1.0) * 0.25, 0.0, 1.0);
  mDiffuse = sqrt(mAlbedo) * uModelParams[0].y * mix(wrapped, 1.0 - abs(sinI), 0.33);
}

/**
 * A shadow on the scatter: light that reaches a strand in another's shadow has passed through
 * hair to get there, so a penumbra deepens toward the fibre's own hue.
 */
vec3 hairShade(float shadow) {
  vec3 hue = mAlbedo / max(dot(mAlbedo, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  return shadow * pow(max(hue, vec3(1e-4)), vec3(1.0 - shadow));
}

/** Light from every side, through the scatter term: \`HAIR_SCATTER_SPHERE\` says why that number. */
vec3 hairAround(vec3 light) {
  return sqrt(mAlbedo) * (uModelParams[0].y * HAIR_SCATTER_SPHERE * mMap.b) * light;
}

/** The reflected lobe's share of the environment: its Fresnel, which is what it integrates to. */
float hairReflectance() {
  return hairFresnel(dot(hairAcross(), mToEye)) * mMap.b;
}
`;
