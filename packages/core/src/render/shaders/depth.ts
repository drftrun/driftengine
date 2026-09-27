import { resolveConditionals } from './conditionals.ts';
import { CUTOUT_COVERAGE_GLSL } from './cutoutCoverage.ts';
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

#if CUTOUT
/*
 * **What a cutout caster adds, and where.** The UV at location 5, where every mesh carries it; two
 * uniforms declared after every other, so no field of the plain variant moves and a binder written
 * against it stays right for this one; and two outputs after vLightPosition, which keeps location 0.
 */
layout(location = 5) in vec2 aUv;
uniform vec2 uUvScale;
uniform float uAlphaCutout;
#endif

out vec4 vLightPosition;
#if CUTOUT
out vec2 vUv;
flat out float vAlphaCutout;
#endif

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
#if CUTOUT
  vUv = aUv * uUvScale;
  vAlphaCutout = uAlphaCutout;
#endif
}
`;

/** The rigid variant: the world, a prop, a mesh with no rig behind it. */
export const DEPTH_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: false, CUTOUT: false },
  'depth',
);

/** The skinned variant, which reads a joint palette and moves the vertex by it. */
export const DEPTH_SKINNED_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: true, INSTANCED: false, CUTOUT: false },
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
  { SKINNED: false, INSTANCED: true, CUTOUT: false },
  'depth-instanced',
);

/**
 * The variants a cutout caster casts through: a leaf card, a chain link, a fence, whose shape is in
 * its texture's alpha rather than in its geometry.
 *
 * **Variants, not a uniform gate on the plain program**, for this file's own reason: a gate would
 * need the UV, a varying and a bound texture on every opaque caster, and a branch on a varying is
 * not provably uniform, which forbids the implicit derivative the sample below wants. A variant
 * leaves every opaque caster byte for byte as it was. What it costs is one more program each, and
 * a skinned cutout, which nothing has asked for, is not among them.
 */
export const DEPTH_CUTOUT_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: false, CUTOUT: true },
  'depth-cutout',
);

export const DEPTH_INSTANCED_CUTOUT_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: true, CUTOUT: true },
  'depth-instanced-cutout',
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

/**
 * The cutout caster's depth: the plain pass, and a texel of alpha under the cutoff writes nothing.
 *
 * **The sample is the first statement, in uniform control flow**, so its implicit derivative picks
 * the mip the shadow map's texel footprint wants; inside a branch it would be undefined (AGENTS.md,
 * 2026-08-07). The peel's own sample becomes an explicit-level fetch for the same reason, and is
 * bit for bit what it was: that map has one level and a nearest sampler. The discard is last, so
 * nothing samples after it.
 *
 * `uCutoutMap` is declared after `uPreviousShadowMap`, so the peel keeps its bindings and the cutout
 * map takes the next.
 */
export const DEPTH_CUTOUT_FRAG = `#version 300 es
precision highp float;
in vec4 vLightPosition;
in vec2 vUv;
flat in float vAlphaCutout;

uniform highp sampler2D uPreviousShadowMap;
uniform int uPeelShadowLayer;
uniform highp sampler2D uCutoutMap;
${CUTOUT_COVERAGE_GLSL}
void main() {
  /* Credited for its mip level as the surface's own test is, so a leaf casts the shape it draws. */
  float alpha = cutoutAlpha(texture(uCutoutMap, vUv).a, vUv * vec2(textureSize(uCutoutMap, 0)));
  if (uPeelShadowLayer != 0) {
    vec3 p = vLightPosition.xyz / vLightPosition.w;
    vec2 uv = p.xy * 0.5 + 0.5;
    float previousDepth = textureLod(uPreviousShadowMap, uv, 0.0).r;
    if (gl_FragCoord.z <= previousDepth + 0.00001) discard;
  }
  if (alpha < vAlphaCutout) discard;
}
`;
