import { resolveConditionals } from './conditionals.ts';
import { SKINNING_GLSL } from './skinning.ts';
import { CHANNEL_ATTRIBUTE, CHANNEL_BEND } from './vertexChannel.ts';

/**
 * Depth-only shadow pass. Its optional peel mode rejects the first recorded
 * surface so the next independently fading occluder can be retained.
 *
 * **Two vertex variants, skinned and not**, for the reason `ShadowCasterSink.scatter` already
 * states about the wind: handing the depth pass a different deformation from the colour pass is
 * how a shadow comes loose from its caster. A skinned character cast rigidly does not drift
 * slightly — it casts its bind pose, so a running figure throws the shadow of a statue.
 *
 * The permutation rather than a uniform gate is the same decision `skinning.ts` measured for the
 * flat shader, and it is cheaper here: this vertex shader is a fifth the size of that one, so the
 * second copy dedupes almost entirely inside deflate's window.
 */
const DEPTH_VERT_SOURCE = `#version 300 es
layout(location = 0) in vec3 aPosition;
#if SKINNED
${SKINNING_GLSL}
#endif

uniform mat4 uLightViewProj;
/*
 * Placement last, and in the instanced variant not at all — see the flat shader, where the same
 * arrangement is load-bearing. Here it costs nothing to keep: uModel is already the last field,
 * so the instanced block is this one without its tail and uLightViewProj does not move.
 */
#if INSTANCED
/**
 * One instance's placement, four vec4 columns, at the same locations the flat stage uses.
 *
 * No tint: this stage writes depth and nothing samples its colour.
 *
 * The same exclusions apply and for the same reasons — skinning owns locations 11 and 12, and a
 * shadow must be deformed exactly as its caster is or it comes loose from the body casting it.
 */
layout(location = 11) in vec4 aInstanceModel0;
layout(location = 12) in vec4 aInstanceModel1;
layout(location = 13) in vec4 aInstanceModel2;
layout(location = 14) in vec4 aInstanceModel3;
#else
uniform mat4 uModel;

/*
 * **The same channel and the same bend the colour pass runs, and it is not optional here.**
 * scatter.ts records why it shares one expression between its two programs: a canopy that bends
 * in the picture and stands still in the shadow map slides its whole shade off the ground it
 * belongs to, and the offset follows the gust, so it never reads as a fixed error anybody could
 * find by looking at one frame.
 *
 * Only .x is read. The sky and alpha lanes are shading, and this stage writes depth.
 */
${CHANNEL_ATTRIBUTE}
${CHANNEL_BEND}
#endif

out vec4 vLightPosition;

void main() {
#if SKINNED
  /* In model space, before uModel, because a palette entry already carries the bind pose —
     the same order the flat shader applies it in, and the two must agree or a shadow parts
     from the body casting it. */
  vec4 local = skinMatrix() * vec4(aPosition, 1.0);
#else
  vec4 local = vec4(aPosition, 1.0);
#endif
#if INSTANCED
  mat4 model = mat4(aInstanceModel0, aInstanceModel1, aInstanceModel2, aInstanceModel3);
#else
  mat4 model = uModel;
#endif
  vec4 world = model * local;
#if INSTANCED
  vec3 bent = world.xyz;
#else
  vec3 bent = channelBend(world.xyz, aChannel.x);
#endif
  vLightPosition = uLightViewProj * vec4(bent, world.w);
  gl_Position = vLightPosition;
}
`;

/** The rigid variant: the world, a prop, a mesh with no rig behind it. */
export const DEPTH_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: false },
  'depth',
);

/** The skinned variant, which reads a joint palette and moves the vertex by it. */
export const DEPTH_SKINNED_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: true, INSTANCED: false },
  'depth-skinned',
);

/**
 * The variant an instanced draw casts its shadow through.
 *
 * **It exists because a shadow is not optional.** An instanced mesh whose depth pass still read
 * uModel would cast every instance's shadow from the last matrix uploaded — one shadow in the
 * right place and the rest stacked underneath it, which reads as a lighting fault rather than as
 * a missing variant, and is the shape the per-draw ring exists to prevent one level up.
 */
export const DEPTH_INSTANCED_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: true },
  'depth-instanced',
);

export const DEPTH_FRAG = `#version 300 es
precision highp float;
in vec4 vLightPosition;

uniform highp sampler2D uPreviousShadowMap;
uniform int uPeelShadowLayer;

void main() {
  if (uPeelShadowLayer != 0) {
    vec3 p = vLightPosition.xyz / vLightPosition.w;
    vec2 uv = p.xy * 0.5 + 0.5;
    float previousDepth = texture(uPreviousShadowMap, uv).r;
    // Discard the already-recorded surface and everything in front of it. The
    // ordinary depth test then stores the next independently fading occluder.
    if (gl_FragCoord.z <= previousDepth + 0.00001) discard;
  }
}
`;
