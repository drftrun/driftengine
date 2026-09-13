import { OCTAHEDRAL_GLSL } from './octahedral.ts';

/**
 * A fullscreen triangle built from the vertex index, so the pass binds no buffer.
 *
 * Three vertices rather than a quad's six: a quad's diagonal is a seam every fragment on it is
 * rasterised twice across, and this pass writes depth, so twice is not free.
 */
export const OCTAHEDRAL_RESOLVE_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * One cube face into its region of an octahedral map, as linear radial distance.
 *
 * **Every octahedral texel has exactly one dominant axis, so the six regions are disjoint and
 * together cover the map.** That is what makes one scratch texture enough for the whole engine
 * rather than one cube per pool slot: a face is consumed the moment it is resolved, so a bake
 * spread across frames — which is how bakes work here, a couple of faces at a time against
 * `pointShadowBudget.ts` — never needs a second face to still exist.
 *
 * **The perspective decode happens here, once per texel, instead of twelve times per shaded
 * fragment.** What lands in the layer is `radius / far`, linear, which at a far plane of 20 m
 * quantises to about a micrometre in DEPTH_COMPONENT24 against a bias that starts at 4 cm. A cube
 * spends most of its bits near the light instead, which is the wrong end for a shadow.
 *
 * The face index and the sampler are named apart on purpose: two uniforms called `uFace` is a
 * redeclaration and GLSL rejects the whole shader.
 */
export const OCTAHEDRAL_RESOLVE_FRAG = `#version 300 es
precision highp float;

/** The face the bake just rendered, as a depth texture. */
uniform highp sampler2D uFace;
/** That face's world-to-face rotation. See pointShadowFaceRotation. */
uniform mat3 uFaceRotation;
/** Which of the six this pass is resolving. Every other texel discards. */
uniform int uFaceIndex;
uniform float uFar;
uniform float uNear;
/** The octahedral map's edge, so this needs no viewport query. */
uniform float uEdge;

${OCTAHEDRAL_GLSL}

void main() {
  vec3 d = octDecode(gl_FragCoord.xy / uEdge);

  /*
   * Which face owns this texel. The tie-breaking is x, then y, then z, and it has to match the
   * CPU's exactly or a sliver of texels along a boundary belongs to two faces or to none.
   */
  vec3 a = abs(d);
  int face;
  if (a.x >= a.y && a.x >= a.z) face = d.x >= 0.0 ? 0 : 1;
  else if (a.y >= a.z) face = d.y >= 0.0 ? 2 : 3;
  else face = d.z >= 0.0 ? 4 : 5;
  if (face != uFaceIndex) discard;

  /* lookAt looks down -z, so a direction inside this face has a negative z here. */
  vec3 v = uFaceRotation * d;
  float forward = -v.z;
  vec2 faceUv = (v.xy / forward) * 0.5 + 0.5;

  /*
   * textureLod at level zero rather than plain texture. The scratch carries one storage level and
   * NEAREST filtering so the fetch is identical, and this call sits after a discard — which is
   * non-uniform control flow, where an implicit derivative is undefined in GLSL and rejected
   * outright in WGSL. AGENTS.md, 2026-08-07.
   */
  float stored = textureLod(uFace, faceUv, 0.0).r;
  if (stored >= 0.9999) {
    /* Nothing was rendered along this direction, so the stored radius is the far plane. */
    gl_FragDepth = 1.0;
    return;
  }
  float ndc = stored * 2.0 - 1.0;
  float faceLocalZ = (2.0 * uFar * uNear) / (uFar + uNear - ndc * (uFar - uNear));
  /* d is a unit vector, so forward is its cosine to the axis and this is the true radius. */
  gl_FragDepth = clamp((faceLocalZ / forward) / uFar, 0.0, 1.0);
}`;
