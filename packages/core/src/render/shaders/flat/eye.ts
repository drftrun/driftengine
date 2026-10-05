/**
 * The eye model in GLSL: `eyeRefraction.ts` is the refraction's arithmetic, and its tests hold it
 * to no shift head-on, the refracted crossing at 30°, a bounded shift edge-on and the map-less iris.
 *
 * **The iris is moved before any map is read** (`modelSurfaceAt`), by how far the eye's ray crosses
 * the iris plane after the cornea bends it, so the whole iris — colour, relief, the model's own
 * channels — moves as one. The crossing is turned into texture coordinates by the tangent frame and
 * by how many of them a metre spans here, which the screen's derivatives say: so it is in uniform
 * control flow, as `modelSurfaceAt` is. **What it gives up** is an anisotropic mapping — a texture
 * stretched one way more than the other moves by the average of the two.
 *
 * **The model map**: red is the iris (1 inside), green the cornea's height above the iris plane as a
 * share of `irisDepth`. Without one, the iris is a disc of `irisRadius` about the texture's centre
 * and the height is `irisDepth` throughout.
 *
 * **Lit as an eye is**: the iris by a normal mirrored about the axis — concave where the cornea is
 * convex, so light pools on the side away from it — and the sclera by the surface's own; and over
 * both, the cornea's highlight, normalised GGX at `corneaRoughness` with the Fresnel of index 1.336,
 * in lamp units like skin's. The environment is reflected at the cornea's split-sum share.
 */
import { CORNEA_F0, EYE_MIN_DESCENT } from '../../eyeRefraction.ts';

export const EYE_GLSL = /* glsl */ `
const float CORNEA_F0 = ${CORNEA_F0.toFixed(9)};
const float EYE_MIN_DESCENT = ${EYE_MIN_DESCENT.toFixed(4)};

/* How much of this texel is iris, gathered with the surface. */
float eIris;

/** Where the iris is without a map: a disc of the model's radius about the centre, a soft limbus. */
float eyeIrisDisc(vec2 uv) {
  float r = length(uv - 0.5);
  return 1.0 - smoothstep(uModelParams[0].x - 0.01, uModelParams[0].x + 0.01, r);
}

/** The iris's texture coordinate, moved by the cornea: \`eyeRefraction.ts\`. Before any map is read. */
vec3 eyeRefract(vec3 at) {
  vec3 n = normalize(vNormal);
  vec3 axis = uModelParams[1].xyz;
  vec4 map = texture(uModelMap, at);
  bool mapped = uModelParams[1].w > 0.0;
  float iris = mapped ? map.r : eyeIrisDisc(at.xy);
  float height = uModelParams[0].y * (mapped ? map.g : 1.0);
  vec3 ray = refract(-normalize(uCameraPos - vWorldPos), n, 1.0 / uModelParams[0].z);
  float descent = max(-dot(ray, axis), EYE_MIN_DESCENT);
  vec3 travel = ray * (height / descent);
  vec3 across = travel - axis * dot(travel, axis);
  mat3 frame = tangentFrame(n, vWorldPos, vUv.xy, vTangent, vHasTangents);
  /* How many texture coordinates a metre spans here, from the screen's two derivatives. */
  float perMetre = length(fwidth(vUv.xy)) / max(length(fwidth(vWorldPos)), 1e-9);
  vec2 shift = vec2(dot(across, frame[0]), dot(across, frame[1])) * (perMetre * iris);
  return vec3(at.xy + shift, at.z);
}

void eyeSurface(vec3 at) {
  eIris = uModelParams[1].w > 0.0 ? mMap.r : eyeIrisDisc(at.xy);
  mRoughness = uModelParams[0].w;
}

void eyeLight(vec3 l, float sourceRadius, float dist) {
  vec3 axis = uModelParams[1].xyz;
  /* The iris is concave where the cornea over it is convex: the surface's normal mirrored about the axis. */
  vec3 irisNormal = normalize(2.0 * dot(mNormal, axis) * axis - mNormal);
  vec3 lit = normalize(mix(mNormal, irisNormal, eIris));
  mDiffuse = mAlbedo * max(dot(lit, l), 0.0) * (1.0 - mMetal);

  float ndl = max(dot(mNormal, l), 0.0);
  vec3 h = normalize(l + mToEye);
  float ndh = max(dot(mNormal, h), 0.0);
  float ndv = max(dot(mNormal, mToEye), 1e-4);
  float grow = sourceRadius / max(2.0 * dist, 1e-3);
  float alpha = min(max(mRoughness * mRoughness, MIN_LOBE_ALPHA) + grow, 1.0);
  float f = CORNEA_F0 + (1.0 - CORNEA_F0) * pow(1.0 - max(dot(mToEye, h), 0.0), 5.0);
  mSpecular = vec3(3.14159265 * f * smithMasking(ndl, ndv, alpha) * ggxLobe(ndh, alpha) * ndl);
}

/** The environment at the cornea's Fresnel, by the split sum's share at its own roughness. */
float eyeReflectance() {
  vec2 dfg = envBrdfApprox(max(dot(mNormal, mToEye), 0.0), uModelParams[0].w);
  return CORNEA_F0 * dfg.x + dfg.y;
}
`;
