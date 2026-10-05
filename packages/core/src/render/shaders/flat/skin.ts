/**
 * The skin model in GLSL: `skinScatter.ts` is the same arithmetic, and its tests hold the
 * pre-integrated fit to the ring integral done numerically, Lambert at no curvature, the
 * transmission through thin and thick parts, and the penumbra's ends.
 *
 * **Each channel scatters its own distance**, the model's radius times its scatter colour, and the
 * surface's curvature turns that into the one number per channel the fit takes. The curvature is
 * the model map's green where one is bound — 1 is a radius of a centimetre — and otherwise the
 * screen's: how fast the interpolated normal turns against how fast the position moves, which is a
 * derivative and so is taken where control flow is uniform, with the surface. **A thin part's
 * thickness** is the map's red — 1 is two centimetres — and otherwise its curvature's diameter,
 * which is what an ear's rim and a nostril's wall are about as thick as.
 *
 * **Transmission is not shadowed by the lamp it comes from.** That lamp's shadow map sees a thin
 * part's own back as the occluder of its front, so a shadowed lamp would put out exactly the light
 * that passes through. What it gives up is an occluder further back: an ear behind a wall, its lamp
 * behind both, still glows. The shadow map's depth at the receiver would separate the two, and the
 * lamp loop reads a visibility rather than a depth.
 *
 * **Under \`skinScattering: 'screen-space'\`** the surface is drawn in two halves: the frame's
 * without its diffuse, and the diffuse alone into the blur's target — Lambert's, with the shadow as
 * it is, because the blur that follows carries light across curvature and shadow edges in the
 * picture and the fit as well would count it twice — keeping the transmission, which the picture
 * cannot see. \`skinBlur.ts\` is the rest.
 *
 * **The highlight** is two GGX lobes — 0.85 at the material's roughness and 0.15 at 0.6 of it, for
 * the skin's oil — normalised, with Smith's masking and the Fresnel of index 1.4, in lamp units, so
 * like hair it ignores the specular attribute, which defaults to nothing. The environment is
 * reflected at that Fresnel's split-sum share.
 */
import { SKIN_F0, SKIN_FIT, SKIN_MAX_K, SKIN_PENUMBRA_WIDTH } from '../../skinScatter.ts';

/** A fitted number as the shader writes it: six figures, which is as many as the fit has. */
const literal = (value: number): string => value.toPrecision(6);

export const SKIN_GLSL = /* glsl */ `
const float SKIN_F0 = ${SKIN_F0.toFixed(9)};
const float SKIN_PENUMBRA_WIDTH = ${SKIN_PENUMBRA_WIDTH.toFixed(3)};

/* What the surface gives every light: the fit's four terms per channel, squared where they are used so. */
vec3 sDistance;
vec3 sKappa;
vec3 sSpread;
vec3 sSoften2;
vec3 sFloor;
float sThickness;
/* What the last light left, for modelShade: the part lit from the front, and the part through. */
vec3 sFront;
vec3 sThrough;

void skinSurface() {
  sDistance = max(uModelParams[0].xyz * uModelParams[0].w, vec3(1e-6));
  /* The screen's curvature, taken here, where control flow is uniform, whether a map replaces it. */
  float screen = length(fwidth(normalize(vNormal))) / max(length(fwidth(vWorldPos)), 1e-6);
  float curvature = uModelParams[1].w > 0.0 ? mMap.g * 100.0 : screen;
  sThickness = uModelParams[1].w > 0.0 ? mMap.r * 0.02 : 2.0 / max(curvature, 1e-3);
  vec3 k = min(sDistance * curvature, vec3(${literal(SKIN_MAX_K)}));
  /*
   * Under the screen-space blur the diffuse half is Lambert's, k at 0: the blur spreads the light
   * across the picture, curvature and all, and the fit as well would count that light twice.
   */
  if (SKIN_DIFFUSE) k = vec3(0.0);
  vec3 k2 = k * k;
  sKappa = pow(1.0 + ${literal(SKIN_FIT.kappa[0])} * k2 + ${literal(SKIN_FIT.kappa[1])} * k2 * k, vec3(-1.0 / 6.0));
  sSpread = pow(1.0 + ${literal(SKIN_FIT.spread)} * k2 * k, vec3(-1.0 / 6.0));
  vec3 soften = ${literal(SKIN_FIT.soften[0])} * k / (1.0 + ${literal(SKIN_FIT.soften[1])} * k);
  sSoften2 = soften * soften;
  vec3 given = 1.0 - sSpread;
  sFloor = given * (${literal(SKIN_FIT.floor[0])} + ${literal(SKIN_FIT.floor[1])} * given);
}

void skinLight(vec3 l, float sourceRadius, float dist) {
  float c = dot(mNormal, l);
  vec3 ring = 0.5 * (sKappa * c + sSpread * sqrt(c * c + sSoften2) + sFloor);
  vec3 through = uModelParams[1].x * exp(-sThickness / sDistance) * max(-c, 0.0);
  sFront = mAlbedo * ring * (1.0 - mMetal);
  sThrough = mAlbedo * through * (1.0 - mMetal);
  mDiffuse = sFront + sThrough;

  float ndl = max(c, 0.0);
  vec3 h = normalize(l + mToEye);
  float ndh = max(dot(mNormal, h), 0.0);
  float ndv = max(dot(mNormal, mToEye), 1e-4);
  /* A lamp's size widens both lobes; a normalised lobe keeps its energy as it widens. */
  float grow = sourceRadius / max(2.0 * dist, 1e-3);
  float alpha = min(max(mRoughness * mRoughness, MIN_LOBE_ALPHA) + grow, 1.0);
  float oil = min(max(0.36 * mRoughness * mRoughness, MIN_LOBE_ALPHA) + grow, 1.0);
  float f = SKIN_F0 + (1.0 - SKIN_F0) * pow(1.0 - max(dot(mToEye, h), 0.0), 5.0);
  float masking = smithMasking(ndl, ndv, alpha);
  float lobe = 0.85 * ggxLobe(ndh, alpha) + 0.15 * ggxLobe(ndh, oil);
  /* π: a lamp here is π of unit irradiance, as hair's are. */
  mSpecular = vec3(3.14159265 * f * masking * lobe * ndl);
  /* Under the screen-space blur each pass keeps its half: models.ts. */
  if (SKIN_SCREEN) mDiffuse = vec3(0.0);
  if (SKIN_DIFFUSE) mSpecular = vec3(0.0);
}

/** Which profile the blur spreads this skin by, as the diffuse pass's alpha: (index + 1) / 8. */
float skinProfileCode() {
  return (uModelParams[1].y + 1.0) / 8.0;
}

/** The front-lit part through the penumbra, each channel by how far it travels; the part through, whole. */
vec3 skinShade(float shadow) {
  /* The blur carries light across a shadow's edge itself, so its half takes the shadow as it is. */
  if (SKIN_DIFFUSE) return (sFront * max(shadow, 0.0) + sThrough) / max(mDiffuse, vec3(1e-6));
  vec3 penumbra = pow(vec3(max(shadow, 0.0)), 1.0 / (1.0 + sDistance / SKIN_PENUMBRA_WIDTH));
  return (sFront * penumbra + sThrough) / max(mDiffuse, vec3(1e-6));
}

/** The environment at the highlight's Fresnel, by the split sum's share. */
float skinReflectance() {
  vec2 dfg = envBrdfApprox(max(dot(mNormal, mToEye), 0.0), mRoughness);
  return SKIN_F0 * dfg.x + dfg.y;
}
`;
