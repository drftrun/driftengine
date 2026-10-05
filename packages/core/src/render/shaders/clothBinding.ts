/**
 * The vertex-stage cloth binding: a skinned vertex moved toward the cloth simulation's triangle it
 * is bound to, by a weight painted per vertex — the GLSL of `clothPlacement.ts`, line for line.
 *
 * **Textures read by vertex index, not attributes**, for the reason morph targets are: the skinned
 * variants already use all sixteen attribute locations once eight influences are in. Three
 * textures, each wrapped onto rows at its own width (read back with `textureSize`, so no uniform
 * joins the vertex block and no shared field moves):
 *
 * - **the binding**, two texels a render vertex: the three particle indices and the weight, then
 *   the barycentric (u, v) for the second and third particle and the offset along the normal;
 * - **the particles now**, one texel a particle, world space — the simulation's output;
 * - **the particles at rest**, one texel a particle, model space — the rest frames are built from
 *   these, so a vertex's own bind-pose normal turns as its triangle has turned.
 *
 * **A pipeline constant, not a permutation**, as `SKIN_EIGHT` is: declared in the skinned variants
 * and folded away where a draw binds no cloth. The textures are bound either way, to stand-ins
 * where there is no cloth.
 */
export const CLOTH_BINDING_GLSL = `
/** Whether this pipeline places vertices by a cloth binding. */
const bool CLOTH_BOUND = false; // wgsl:override
uniform highp sampler2D uClothBinding;
uniform highp sampler2D uClothParticles;
uniform highp sampler2D uClothRest;

/** Texel i of a texture wrapped onto rows of the given width. */
ivec2 clothTexel(int i, int width) {
  return ivec2(i % width, i / width);
}

/** A triangle's frame: its first edge, the normal crossed with it, and its normal. */
mat3 clothFrame(vec3 a, vec3 b, vec3 c) {
  vec3 edge = b - a;
  vec3 n = normalize(cross(edge, c - a));
  vec3 t = normalize(edge);
  return mat3(t, cross(n, t), n);
}

/**
 * Where this vertex's triangle puts it, the turn its normal takes, and how far it follows (the
 * painted weight: 0 skinned, 1 cloth). One particle named three times is a vertex bound to that
 * particle alone: on it, with no turn.
 */
float clothPlace(out vec3 position, out mat3 turn) {
  int bindingWidth = textureSize(uClothBinding, 0).x;
  int particleWidth = textureSize(uClothParticles, 0).x;
  int restWidth = textureSize(uClothRest, 0).x;
  vec4 indices = texelFetch(uClothBinding, clothTexel(gl_VertexID * 2, bindingWidth), 0);
  vec4 at = texelFetch(uClothBinding, clothTexel(gl_VertexID * 2 + 1, bindingWidth), 0);
  int a = int(indices.x);
  int b = int(indices.y);
  int c = int(indices.z);
  vec3 pa = texelFetch(uClothParticles, clothTexel(a, particleWidth), 0).xyz;
  if (a == b && b == c) {
    position = pa;
    turn = mat3(1.0);
    return indices.w;
  }
  vec3 pb = texelFetch(uClothParticles, clothTexel(b, particleWidth), 0).xyz;
  vec3 pc = texelFetch(uClothParticles, clothTexel(c, particleWidth), 0).xyz;
  mat3 now = clothFrame(pa, pb, pc);
  mat3 rest = clothFrame(
    texelFetch(uClothRest, clothTexel(a, restWidth), 0).xyz,
    texelFetch(uClothRest, clothTexel(b, restWidth), 0).xyz,
    texelFetch(uClothRest, clothTexel(c, restWidth), 0).xyz
  );
  position = pa * (1.0 - at.x - at.y) + pb * at.x + pc * at.y + now[2] * at.z;
  turn = now * transpose(rest);
  return indices.w;
}
`;

/** A skinned vertex stage with the cloth binding on: the same source, the constant flipped. */
export function clothBound(source: string): string {
  const off = 'const bool CLOTH_BOUND = false;';
  if (!source.includes(off)) {
    throw new Error('clothBound: this vertex stage declares no CLOTH_BOUND constant');
  }
  return source.replace(off, 'const bool CLOTH_BOUND = true;');
}
