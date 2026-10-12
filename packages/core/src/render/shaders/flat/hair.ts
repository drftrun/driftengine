/**
 * The hair model in GLSL: `hairLobes.ts` is the same arithmetic, and its tests hold the lobes to
 * their tilted peaks, the transmitted lobe to the backlight, the sum to what a white strand
 * receives, and every term to a finite answer where the geometry degenerates.
 *
 * **The strand is the tangent, root to tip**, unless the model map says otherwise. Its red is the
 * strand's specular, which scales the reflected lobe by twice it, so 0.5 is the lobe as drawn and 0
 * a root that reflects nothing; its green turns each strand's tilt by up to half of it either way
 * (0.5 is none); and its blue is occlusion, which light from every side takes and the lamps do not
 * — their shadows are theirs to cast. A colour from root to tip is the albedo map's to carry.
 *
 * **A strand's direction, texel by texel**, where the model has a \`directionOffset\`: that many
 * layers past the one the other channels are read at, a direction in the surface's tangent frame —
 * red along the tangent, green along the bitangent and blue out of the surface along its normal,
 * each −1 to 1 as a normal map packs them — which the strand runs along instead of the tangent. So
 * a card's strands can lean out of its plane, each its own way, as the strands it stands for do.
 * **What it gives up** is the frame's own precision: eight bits a component turns a strand in
 * steps of about half a degree, which the lobes, a few degrees wide, do not resolve.
 *
 * **Light from every side** — the sky, the probes, DriftLight — goes through the lobes rather than
 * past them: they are evaluated once, for a light along the eye flattened across the strand, every
 * lobe widened by \`HAIR_AREA\` as a source that large would widen it, and their sum taken as the
 * share of that light the strand returns (\`hairIndirect\`). That is how a real-time hair model
 * stands one direction in for the sphere: a strand returns most toward the eye what arrives from
 * the eye's side of it, and the R and TRT lobes are what make a fibre gold rather than a wash of
 * its scatter. The environment's reflection leaves hair out, because R already took its share.
 *
 * **What it gives up**: light from behind. The direction stands for the eye's side only, so there
 * is no transmitted lobe in it, and a head of hair lit from behind by an open sky shows no rim
 * from the sky; the lamps carry one. And the share is one direction's, not the sphere's integral,
 * so it moves with the eye as the lobes do rather than holding still as an average would. **What
 * would make it wrong** is hair seen mostly against its light, a head against a bright window,
 * whose sky arrives through the strands rather than off them and wants the transmitted lobe back.
 */
import { HAIR_AREA, HAIR_F0, HAIR_MIN_BETA } from '../../hairLobes.ts';

export const HAIR_GLSL = /* glsl */ `
const float HAIR_F0 = ${HAIR_F0.toFixed(9)};
const float HAIR_MIN_BETA = ${HAIR_MIN_BETA.toFixed(3)};
const float HAIR_AREA = ${HAIR_AREA.toFixed(3)};

/* This texel's tilt, its specular, and the share of light from every side it returns: gathered
   with the surface. */
float hShift;
float hSpecular;
vec3 hAround;

/** A longitudinal lobe: a normalised Gaussian of width \`beta\` at \`x\` from its centre. */
float hairLongitudinal(float beta, float x) {
  return exp(-0.5 * x * x / (beta * beta)) / (2.5066283 * beta);
}

float hairFresnel(float cosine) {
  float c = 1.0 - clamp(cosine, 0.0, 1.0);
  return HAIR_F0 + (1.0 - HAIR_F0) * c * c * c * c * c;
}

/** The normal turned toward the eye across the strand: the scatter's, and light from every side's. */
vec3 hairAcross() {
  vec3 across = mToEye - mTangent * dot(mTangent, mToEye);
  float length2 = dot(across, across);
  return length2 > 1e-8 ? across * inversesqrt(length2) : mNormal;
}

/**
 * The lobes for light arriving along \`l\`, into \`mSpecular\` and \`mDiffuse\`: every lobe widened by
 * \`grow\` radians, and the transmitted one scaled by \`backlit\`.
 */
void hairLobes(vec3 l, float grow, float backlit) {
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
  float x = sinI + sinO;

  float r = hairLongitudinal(beta + grow, x + 2.0 * hShift) * 0.25 * cosHalfPhi
    * hairFresnel(sqrt(clamp(0.5 + 0.5 * dot(l, mToEye), 0.0, 1.0))) * hSpecular;

  float a = 1.0 / (1.19 / cosD + 0.36 * cosD);
  float h = cosHalfPhi * (1.0 + a * (0.6 - 0.8 * cosPhi));
  float fTT = hairFresnel(cosD * sqrt(clamp(1.0 - h * h, 0.0, 1.0)));
  float tt = hairLongitudinal(0.5 * beta + grow, x - hShift) * exp(-3.65 * cosPhi - 3.98)
    * (1.0 - fTT) * (1.0 - fTT) * backlit;
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

/** A lamp, or the sun at no size: widened by the angle it subtends, as \`sphereLobe\` takes it. */
void hairLight(vec3 l, float sourceRadius, float dist) {
  hairLobes(l, sourceRadius / max(2.0 * dist, 1e-3), uModelParams[0].z);
}

/**
 * A shadow on the scatter: light that reaches a strand in another's shadow has passed through
 * hair to get there, so a penumbra deepens toward the fibre's own hue.
 */
vec3 hairShade(float shadow) {
  vec3 hue = mAlbedo / max(dot(mAlbedo, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  return shadow * pow(max(hue, vec3(1e-4)), vec3(1.0 - shadow));
}

/**
 * The share of light from every side a strand returns: the lobes for a light along the eye
 * flattened across the strand, unshadowed, with nothing from behind and every lobe widened by
 * \`HAIR_AREA\`, twice their sum and at most all of it. Twice, in this engine's units, because the
 * lobes are per unit irradiance and the scatter's half is then exactly \`HAIR_SCATTER_SPHERE\`, its
 * own average over the sphere: \`hairLobes.ts\` says why, and holds the arithmetic to it.
 */
vec3 hairIndirect() {
  hairLobes(hairAcross(), HAIR_AREA, 0.0);
  return min(vec3(1.0), 2.0 * (mSpecular + mDiffuse));
}

/**
 * The strand at this texel: its tilt and specular from the model map, its direction from the layer
 * \`directionOffset\` names where there is one, and then its share of light from every side, which
 * reads all three. On a branch of uniforms alone, so the read's derivatives are in uniform flow; a
 * direction that decodes to nothing keeps the tangent.
 */
void hairSurface(vec3 at) {
  hShift = uModelParams[0].x * (0.5 + mMap.g);
  hSpecular = 2.0 * mMap.r;
  if (uModelParams[0].w > 0.0 && uModelParams[1].w > 0.0) {
    vec3 d = texture(uModelMap, vec3(at.xy, at.z + uModelParams[0].w)).rgb * 2.0 - 1.0;
    vec3 strand = mTangent * d.x + mBitangent * d.y + mNormal * d.z;
    float length2 = dot(strand, strand);
    if (length2 > 1e-4) mTangent = strand * inversesqrt(length2);
  }
  hAround = hairIndirect();
}

/** Light from every side, through the lobes, under the map's occlusion. */
vec3 hairAround(vec3 light) {
  return hAround * (mMap.b * light);
}
`;
