import { resolveConditionals } from './conditionals.ts';
import { SUN_STATIC_LAYER } from '../shadowMap.ts';
import { CUTOUT_COVERAGE_GLSL } from './cutoutCoverage.ts';
import { CUTOUT_DITHER_GLSL } from '../cutoutDither.ts';
import { SKINNING_GLSL } from './skinning.ts';
import { CLOTH_BINDING_GLSL } from './clothBinding.ts';
import { CHANNEL_ATTRIBUTE, CHANNEL_BEND } from './vertexChannel.ts';
import { BONE_ANIMATION_GLSL } from './boneAnimation.ts';

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
/* Not in the glass-tint caster: a garment is not glass, and its layout keeps its bindings. */
#if GLASS
#else
${CLOTH_BINDING_GLSL}
#endif
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
 * **What a cutout caster adds, and where.** The UV at location 5, where every mesh carries it; three
 * uniforms declared after every other, so no field of the plain variant moves and a binder written
 * against it stays right for this one; and two outputs after vLightPosition, which keeps location 0.
 */
layout(location = 5) in vec3 aUv;
uniform vec2 uUvScale;
uniform vec2 uUvOffset;
/* x the cutoff, y 1 for a dithered edge: see the cutout fragment stages below. */
uniform vec2 uAlphaCutout;
#endif

#if ANIMATED
/*
 * **A bone animation's, after every other declaration** so no field of the variants before it
 * moves: the grain lane the vertex's bone rides in, the scene's clock, and the chunk the colour
 * pass runs — the same expression, or a crowd's shadow stands still while the crowd moves.
 */
layout(location = 8) in float aGrain;
uniform float uSceneTime;
${BONE_ANIMATION_GLSL}
#endif

out vec4 vLightPosition;
#if CUTOUT
/* The texture coordinate and, in z, the texture-array layer the face wears. */
out vec3 vUv;
flat out vec2 vAlphaCutout;
#endif
#if GLASS
/* Where on the pane this is, for the tint's own normal and its angle to the light. Last, so the
   outputs before it keep the locations the plain variants give them. */
out vec3 vGlassWorld;
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
#if ANIMATED
  /* Turned and placed as the colour pass turns and places it; its normal and tangent unused. */
  vec3 animatedNormal = vec3(0.0, 1.0, 0.0);
  vec3 animatedTangent = vec3(1.0, 0.0, 0.0);
  local = vec4(boneAnimate(local.xyz, animatedNormal, animatedTangent), 1.0);
#endif
#if INSTANCED
  mat4 model = mat4(aInstanceModel0, aInstanceModel1, aInstanceModel2, aInstanceModel3);
  /* The bottom row is the instance's texture cell, rebuilt as the row it stands for: see flat. */
  vec4 instanceCell = vec4(model[0].w, model[1].w, model[2].w, model[3].w);
  model[0].w = 0.0;
  model[1].w = 0.0;
  model[2].w = 0.0;
  model[3].w = 1.0;
#else
  mat4 model = uModel;
#endif
  vec4 world = model * local;
#if INSTANCED
  vec3 bent = world.xyz;
#else
  vec3 bent = channelBend(world.xyz, aChannel.x);
#endif
#if SKINNED
#if GLASS
#else
  /* Toward the cloth exactly as the colour pass moves it, or the shadow parts from the garment. */
  if (CLOTH_BOUND) {
    vec3 clothPosition;
    mat3 turn;
    float follow = clothPlace(clothPosition, turn);
    bent = mix(bent, clothPosition, follow);
  }
#endif
#endif
  vLightPosition = uLightViewProj * vec4(bent, world.w);
  gl_Position = vLightPosition;
#if CUTOUT
#if INSTANCED
  /* A cutout instance's shadow is cut by its own cell, as its picture is. */
  vUv = vec3((aUv.xy * instanceCell.xy + instanceCell.zw) * uUvScale + uUvOffset, aUv.z);
#else
  vUv = vec3(aUv.xy * uUvScale + uUvOffset, aUv.z);
#endif
  vAlphaCutout = uAlphaCutout;
#endif
#if GLASS
  vGlassWorld = bent;
#endif
}
`;

/** The rigid variant: the world, a prop, a mesh with no rig behind it. */
export const DEPTH_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: false, CUTOUT: false, GLASS: false, ANIMATED: false },
  'depth',
);

/** The skinned variant, which reads a joint palette and moves the vertex by it. */
export const DEPTH_SKINNED_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: true, INSTANCED: false, CUTOUT: false, GLASS: false, ANIMATED: false },
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
  { SKINNED: false, INSTANCED: true, CUTOUT: false, GLASS: false, ANIMATED: false },
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
  { SKINNED: false, INSTANCED: false, CUTOUT: true, GLASS: false, ANIMATED: false },
  'depth-cutout',
);

export const DEPTH_INSTANCED_CUTOUT_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: true, CUTOUT: true, GLASS: false, ANIMATED: false },
  'depth-instanced-cutout',
);

/**
 * The variants a crowd casts through: an instanced batch playing a bone animation, its vertices
 * where the clip puts them at each instance's moment. See `shaders/boneAnimation.ts`. No glass
 * variant: a crowd is not glass, and a glass batch that animates casts its tint from rest.
 */
export const DEPTH_INSTANCED_ANIMATED_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: true, CUTOUT: false, GLASS: false, ANIMATED: true },
  'depth-instanced-animated',
);

export const DEPTH_INSTANCED_ANIMATED_CUTOUT_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: true, CUTOUT: true, GLASS: false, ANIMATED: true },
  'depth-instanced-animated-cutout',
);

export const DEPTH_FRAG = `#version 300 es
precision highp float;
in vec4 vLightPosition;

uniform highp sampler2DArray uPreviousShadowMap;
uniform int uPeelShadowLayer;

void main() {
  if (uPeelShadowLayer != 0) {
    vec3 p = vLightPosition.xyz / vLightPosition.w;
    vec2 uv = p.xy * 0.5 + 0.5;
    float previousDepth = texture(uPreviousShadowMap, vec3(uv, ${SUN_STATIC_LAYER}.0)).r;
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
in vec3 vUv;
flat in vec2 vAlphaCutout;

uniform highp sampler2DArray uPreviousShadowMap;
uniform int uPeelShadowLayer;
uniform highp sampler2DArray uCutoutMap;
${CUTOUT_COVERAGE_GLSL}
${CUTOUT_DITHER_GLSL}
void main() {
  /* Credited for its mip level as the surface's own test is, so a leaf casts the shape it draws. */
  vec3 at = vec3(vUv.xy, floor(vUv.z + 0.5));
  float alpha = cutoutAlpha(texture(uCutoutMap, at).a, vUv.xy * vec2(textureSize(uCutoutMap, 0).xy));
  if (uPeelShadowLayer != 0) {
    vec3 p = vLightPosition.xyz / vLightPosition.w;
    vec2 uv = p.xy * 0.5 + 0.5;
    float previousDepth = textureLod(uPreviousShadowMap, vec3(uv, ${SUN_STATIC_LAYER}.0), 0.0).r;
    if (gl_FragCoord.z <= previousDepth + 0.00001) discard;
  }
  /*
   * A dithered edge casts the share it covers, with a pattern that does not move: a shadow map has
   * no temporal resolve of its own and a static layer keeps whatever it was drawn with, so a moving
   * pattern would shimmer there. The map's filter averages it into a soft edge.
   */
  if (vAlphaCutout.y > 0.5) {
    if (!cutoutKeeps(cutoutShare(alpha, vAlphaCutout.x), gl_FragCoord.xy, 0.0)) discard;
  } else if (alpha < vAlphaCutout.x) {
    discard;
  }
}
`;

/**
 * The glass tint's vertex stages: every way a caster is drawn, with the world position handed on.
 *
 * **The same five as the depth pass, and for the same reason**: a pane must cast its colour from
 * exactly where it casts its depth, deformed and placed the same way, or the coloured patch parts
 * from the pane's own shadow edge. The only addition is `vGlassWorld`.
 */
export const GLASS_TINT_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: false, CUTOUT: false, GLASS: true, ANIMATED: false },
  'glass-tint',
);
export const GLASS_TINT_SKINNED_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: true, INSTANCED: false, CUTOUT: false, GLASS: true, ANIMATED: false },
  'glass-tint-skinned',
);
export const GLASS_TINT_INSTANCED_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: true, CUTOUT: false, GLASS: true, ANIMATED: false },
  'glass-tint-instanced',
);
export const GLASS_TINT_CUTOUT_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: false, CUTOUT: true, GLASS: true, ANIMATED: false },
  'glass-tint-cutout',
);
export const GLASS_TINT_INSTANCED_CUTOUT_VERT = resolveConditionals(
  DEPTH_VERT_SOURCE,
  { SKINNED: false, INSTANCED: true, CUTOUT: true, GLASS: true, ANIMATED: false },
  'glass-tint-instanced-cutout',
);

/**
 * What a pane lets through: its transmission and colour, less what it reflects toward the light,
 * and how clear it is — `glassShadow.ts`'s `paneTexel`, stated for the device. Drawn with a
 * multiplying blend and no depth test, so every pane on a ray contributes whatever order they
 * come in.
 *
 * **The pane's normal is its triangle's**, from the derivatives of its world position, first and in
 * uniform control flow: a pane is flat, a sign does not matter to a cosine taken absolutely, and it
 * spares the five vertex stages a normal they would carry for this alone. What it gives up is a
 * curved pane, whose Fresnel steps per triangle; what would change it is glass that is mostly bulbs.
 */
const GLASS_TINT_BODY = /* glsl */ `
  vec3 n = normalize(cross(dFdx(vGlassWorld), dFdy(vGlassWorld)));
  vec3 toLight = uGlassLight.w > 0.5 ? normalize(uGlassLight.xyz - vGlassWorld) : uGlassLight.xyz;
  float cosLight = abs(dot(n, toLight));
  float reflected = 0.04 + 0.96 * pow(1.0 - cosLight, 5.0);
  outTint = vec4(uGlassPane.rgb * (1.0 - reflected), uGlassPane.a);
`;

export const GLASS_TINT_FRAG = `#version 300 es
precision highp float;
in vec4 vLightPosition;
in vec3 vGlassWorld;

/* rgb: transmission times tint; a: clarity, one less the frost. */
uniform vec4 uGlassPane;
/* xyz: the light's position (w 1) or the direction toward it (w 0). */
uniform vec4 uGlassLight;

out vec4 outTint;

void main() {
${GLASS_TINT_BODY}
}
`;

/** A cut-out pane: its colour lands only where its depth does, by the depth cutout's own test. */
export const GLASS_TINT_CUTOUT_FRAG = `#version 300 es
precision highp float;
in vec4 vLightPosition;
in vec3 vUv;
flat in vec2 vAlphaCutout;
in vec3 vGlassWorld;

uniform vec4 uGlassPane;
uniform vec4 uGlassLight;
uniform highp sampler2DArray uCutoutMap;
${CUTOUT_COVERAGE_GLSL}
${CUTOUT_DITHER_GLSL}
out vec4 outTint;

void main() {
  /* First, in uniform control flow, as the depth cutout samples it. */
  vec3 at = vec3(vUv.xy, floor(vUv.z + 0.5));
  float alpha = cutoutAlpha(texture(uCutoutMap, at).a, vUv.xy * vec2(textureSize(uCutoutMap, 0).xy));
${GLASS_TINT_BODY}
  /* The depth cutout's own test, so the colour lands exactly where the depth does. */
  if (vAlphaCutout.y > 0.5) {
    if (!cutoutKeeps(cutoutShare(alpha, vAlphaCutout.x), gl_FragCoord.xy, 0.0)) discard;
  } else if (alpha < vAlphaCutout.x) {
    discard;
  }
}
`;
