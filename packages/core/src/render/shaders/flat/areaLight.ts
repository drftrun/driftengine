/**
 * One rectangle's light on a fragment: its form factor, and what it adds once its occlusion is
 * known. **The one statement of it**, called by the fixed loop over the first `maxAreaLights`
 * rectangles and by the froxel table's for the rest, so the two arms shade a rectangle with one
 * body rather than two transcriptions of it — the zero-pixel gate between them means something
 * only if that is so.
 *
 * Depth zero and after the models, whose `modelLight` it calls; see `flatFrag`.
 */
export const AREA_LIGHT_GLSL = /* glsl */ `
/**
 * The rectangle's signed form factor at this fragment: its corners **wound so a surface on the
 * emitting side sees them counter-clockwise**, which is what makes it positive there. The natural
 * order — minus, plus, plus, minus — winds the other way, and every one-sided light then clamped to
 * zero and the frame was black. The sign is the sidedness: a one-sided rectangle takes the positive
 * part and a two-sided one the magnitude.
 */
float areaSignedForm(vec3 n, vec3 centre, vec3 right, vec3 up, vec2 halfSize) {
  vec3 c0 = centre - right * halfSize.x + up * halfSize.y;
  vec3 c1 = centre + right * halfSize.x + up * halfSize.y;
  vec3 c2 = centre + right * halfSize.x - up * halfSize.y;
  vec3 c3 = centre - right * halfSize.x - up * halfSize.y;
  return quadFormFactor(n, vWorldPos, c0, c1, c2, c3);
}

/**
 * What one rectangle of colour \`color\` and form factor \`form\` adds to the lamps' two sums, open
 * and shadowed by \`occl\` and \`glass\`.
 *
 * **A model answers a rectangle as it answers a lamp at its centre**, carried at the rectangle's
 * own energy: the diffuse by the exact form factor over the centre's cosine, the specular by the
 * form factor. An approximation, stated: a model's lobe is not integrated over the rectangle as the
 * standard lobe is, so a glossy model under a large softbox shows a lobe from its centre rather than
 * its shape.
 *
 * **The standard lobe is integrated over the rectangle**, rather than sampled at one point on it.
 * What stood here once handed the closest point on the rectangle to \`sphereLobe\` and scaled it by
 * \`form\`, the *diffuse* form factor. Measured against a brute-force integral by
 * \`scripts/areaSpecular.mjs\`, that lost the reflection rather than blurring it: on polished metal
 * facing a softbox it returned 0.000233 where the integral is 0.9207, and head-on on a rough surface
 * it was 3.7 times too bright. Worst 287% either way; this is 40.1% where the light is what the
 * surface reflects and 79.0% for one overhead. \`quadCoverage\` says what fraction of the specular
 * lobe the rectangle covers and the environment BRDF says how much the surface returns, the split
 * the probe path uses. **\`dfg.x + dfg.y\` and not \`envSpecularEnergy\`**, deliberately: the
 * compensation returns the multiply-scattered share, and every direct lobe in this shader is
 * single-scattering, so adding it here returns energy the light never had. Measured at 211%
 * against 40.1%.
 */
void areaLightAdd(
  vec3 centre,
  vec3 right,
  vec3 up,
  vec2 halfSize,
  vec3 color,
  float form,
  float occl,
  vec3 glass,
  vec3 n,
  vec3 albedo,
  float metal,
  vec3 specColor,
  float roughness,
  bool modelled,
  inout vec3 lampOpen,
  inout vec3 lampShadowed
) {
  if (modelled) {
    vec3 areaL = normalize(centre - vWorldPos);
    modelLight(areaL, 0.0, 0.0);
    vec3 areaModel = (mDiffuse * (form / max(dot(n, areaL), 1e-3)) + mSpecular * form) * color;
    lampOpen += areaModel;
    lampShadowed += areaModel * occl * glass;
    return;
  }
  /* Held back with the point lamps', and shadowed by the same term it always was. */
  vec3 areaDiffuse = albedo * color * form * (1.0 - metal);
  lampOpen += areaDiffuse;
  lampShadowed += areaDiffuse * occl * glass;

  if (vSpecular > 0.0 || metal > 0.0) {
    vec3 c0 = centre - right * halfSize.x + up * halfSize.y;
    vec3 c1 = centre + right * halfSize.x + up * halfSize.y;
    vec3 c2 = centre + right * halfSize.x - up * halfSize.y;
    vec3 c3 = centre - right * halfSize.x - up * halfSize.y;
    vec3 toEyeArea = normalize(uCameraPos - vWorldPos);
    float coverage = quadCoverage(n, vWorldPos, toEyeArea, roughness, c0, c1, c2, c3);
    if (coverage > 0.0) {
      vec2 areaDfg = envBrdfApprox(max(dot(n, toEyeArea), 0.0), roughness);
      vec3 areaSpec = specColor * areaDfg.x + vec3(areaDfg.y);
      vec3 areaHighlight = areaSpec * color * coverage;
      lampOpen += areaHighlight;
      lampShadowed += areaHighlight * occl * glass;
    }
  }
}
`;
