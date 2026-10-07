/**
 * The vertex-stage bone animation: a crowd instance's vertex turned and placed by its bone, at its
 * instance's moment of the clip — the GLSL of `boneAnimation.ts`'s `animateBoneVertex`, line for
 * line. Shared by the lit stage and the depth stage, so a crowd's shadow moves with it.
 *
 * **Three textures, read by index and never filtered**: the places and the turns, a texel a bone a
 * frame (bones across, frames down, sizes read with `textureSize` so no uniform says them), and the
 * batch's clocks, two floats an instance wrapped onto rows, read at `gl_InstanceID`. The clip's speed
 * and its bone scale are the one uniform, `uBoneClip`; the scene's time is the pass's `uSceneTime`.
 *
 * **The bone is read from the grain lane**, which is where a mesh's second coordinates ride, stored
 * as `-1 - u` (`lightmap.ts`). An instanced batch reads no grain of its own from that lane: a crowd's
 * mesh carries second coordinates, which is what makes it one.
 *
 * Integer arithmetic for the lattice, by the 2026-09-20 rule, except where a float is clamped onto
 * it: the first frame is `min(floor(wrapped), frames - 1)`, so the wrap that division-by-reciprocal
 * lands on `frames` is the last frame fully blended into the first — the first, which is right.
 */
export const BONE_ANIMATION_GLSL = `
uniform highp sampler2D uBonePlaces;
uniform highp sampler2D uBoneTurns;
uniform highp sampler2D uInstanceClocks;
/** x the clip's frames a second, y how many bones one unit of the second coordinates' u counts. */
uniform vec2 uBoneClip;

/** v turned by the unit quaternion q. */
vec3 boneTurn(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

/**
 * Where the clip puts this vertex, from its place at rest; its normal and tangent turned with it.
 */
vec3 boneAnimate(vec3 position, inout vec3 normal, inout vec3 tangent) {
  ivec2 size = textureSize(uBonePlaces, 0);
  int clocksWidth = textureSize(uInstanceClocks, 0).x;
  vec2 clock = texelFetch(
    uInstanceClocks,
    ivec2(gl_InstanceID % clocksWidth, gl_InstanceID / clocksWidth),
    0
  ).xy;
  float moment = (uSceneTime * clock.y + clock.x) * uBoneClip.x;
  float frames = float(size.y);
  float wrapped = moment - frames * floor(moment / frames);
  int first = min(int(floor(wrapped)), size.y - 1);
  int second = first + 1 == size.y ? 0 : first + 1;
  float blend = clamp(wrapped - float(first), 0.0, 1.0);
  int bone = clamp(int(floor((-1.0 - aGrain) * uBoneClip.y + 0.5)), 0, size.x - 1);
  vec4 q0 = texelFetch(uBoneTurns, ivec2(bone, first), 0);
  vec4 q1 = texelFetch(uBoneTurns, ivec2(bone, second), 0);
  /* The shorter arc: a quaternion and its negation are one turn. */
  if (dot(q0, q1) < 0.0) q1 = -q1;
  vec4 q = normalize(mix(q0, q1, blend));
  vec3 place = mix(
    texelFetch(uBonePlaces, ivec2(bone, first), 0).xyz,
    texelFetch(uBonePlaces, ivec2(bone, second), 0).xyz,
    blend
  );
  normal = boneTurn(q, normal);
  tangent = boneTurn(q, tangent);
  return boneTurn(q, position) + place;
}
`;
