/**
 * The material's normal map applied to a surface normal. **The one statement of it**, read by the
 * lit block for every light and by an unlit refracting draw for the direction it bends, so a lit
 * pane and an unlit distortion bend by one tilt rather than two transcriptions of it.
 *
 * Depth zero, after the tangent frame it calls; see `flatFrag`. **Only ever called under a branch
 * on a uniform** — `uNormalStrength` and whatever gates its caller — which is what makes the
 * derivatives inside `tangentFrame` and the implicit level of the read legal: AGENTS.md 2026-08-07.
 */
export const NORMAL_MAP_GLSL = /* glsl */ `
vec3 normalMapped(vec3 n, vec3 at) {
  vec3 mapped = texture(uNormalMap, at).xyz * 2.0 - 1.0;
  /*
   * z rebuilt where none is stored. A tangent-space normal points out of its surface, so a
   * stored z at or below zero is never a real one: it is a two-channel map, BC5, whose blue a
   * device samples as zero and which arrives here as -1. Every map baked from BC5 to PNG before
   * 4.8.4 carried the same zero. A select rather than a flag: no uniform to bind, no material
   * that has to say what format it holds, and continuous at the boundary, since a unit texel
   * lying flat has its z near zero either way. A texel with z above zero is left as it was.
   */
  mapped.z = mapped.z > 0.0 ? mapped.z : sqrt(max(0.0, 1.0 - dot(mapped.xy, mapped.xy)));
  mat3 tbn = tangentFrame(n, vWorldPos, vUv.xy, vTangent, vHasTangents);
  return normalize(mix(n, normalize(tbn * mapped), uNormalStrength));
}
`;
