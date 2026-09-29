/**
 * What the lit stage shares between every glass tint it reads: whether it reads any, and
 * `glassShadow.ts`'s `unmixTint`, stated once for the sun's lookup and the lamps'. At depth zero,
 * outside every conditional, so each lookup can call it whichever shadows a permutation compiles.
 */
export function glassTintGlsl(glassShadows: boolean): string {
  return /* glsl */ `
/*
 * Whether this build reads glass at all, which every way into the lookups asks first — and as a
 * branch's own condition, never negated: see \`overridableConstants\` in scripts/wgsl/transform.mjs.
 */
const bool GLASS_SHADOWS = ${glassShadows ? 'true' : 'false'};  // wgsl:override
/*
 * A coarse level of a glass tint with the open ground's white taken back out, by how milky the pane
 * at the centre is: rgb the pane's colour, a its share of the texel (glassShadow.ts's unmixTint).
 * A clear centre is never read coarse, so it is returned as it stands.
 */
vec4 glassUnmix(vec4 mip, float centreClarity) {
  if (centreClarity >= 1.0) return vec4(mip.rgb, 1.0);
  float share = clamp((1.0 - mip.a) / (1.0 - centreClarity), 0.0, 1.0);
  if (share <= 0.0) return vec4(1.0, 1.0, 1.0, 0.0);
  return vec4(clamp((mip.rgb - vec3(1.0 - share)) / share, 0.0, 1.0), share);
}
`;
}
