/** The sprite program: one textured, tinted quad per instance, blended in submission order. */

import { OUTPUT_TRANSFORM_GLSL } from '@driftengine/core';

/**
 * Below this the fragment is thrown away rather than blended.
 *
 * Half of one eight-bit step. A sprite sheet's transparent margin is exactly zero and costs
 * nothing to reject; what this buys is the *soft* edge of an antialiased glyph or a feathered
 * particle, whose outermost ring blends a texture fetch and a blend for a contribution no frame
 * can show. It is a fill saving and not a correctness rule, which is why it is this low: a cutout
 * threshold that shaved visible alpha would put a hard edge on every soft one.
 */
const ALPHA_FLOOR = 1.0 / 255.0;

export const SPRITE_VERT = `#version 300 es

/**
 * The two edge vectors of the quad, in the space the affine below maps from.
 *
 * Edge vectors rather than a size and an angle: the rotation is resolved on the CPU once per
 * sprite, where it costs one sine, and the vertex stage does two multiplies and an add. A sprite
 * batch is vertex-bound at four thousand quads and this is the whole of its vertex work.
 */
layout(location = 0) in vec4 aEdges;
/** The frame this sprite reads, as (u0, v0) and (u1, v1). */
layout(location = 1) in vec4 aUv;
/** Straight, not premultiplied. The fragment stage premultiplies after the texture fetch. */
layout(location = 2) in vec4 aTint;
/** The corner the two edges grow from. */
layout(location = 3) in vec2 aOrigin;

/**
 * The affine to normalised device coordinates, as (a, b, c, d) and (e, f).
 *
 * Two \`vec4\`s rather than a \`mat3\`, because a \`mat3\` in a uniform block is three
 * sixteen-byte rows for nine useful floats and this is read once per vertex.
 */
uniform vec4 uToNdc0;
uniform vec4 uToNdc1;
/**
 * Clip space, as the backend drawing this defines it. Identity on WebGL2.
 *
 * The same correction \`panel.ts\` carries and for the same reason: this stage builds its own clip
 * position and never multiplies by a camera, so the generated vertex shader's Y negation would
 * stand uncancelled and the whole 2D layer would land mirrored about the middle of the frame.
 */
uniform mat4 uClipCorrection;

out vec2 vUv;
out vec4 vTint;

/**
 * Two triangles, wound so that either winding draws: this pass culls nothing.
 *
 * A sprite is flipped by giving it a negative width, which reverses the winding — so a cull mode
 * would silently drop every mirrored sprite, which is what a character facing left is.
 */
const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  vec2 p = aOrigin + aEdges.xy * corner.x + aEdges.zw * corner.y;
  vec2 ndc = vec2(
    uToNdc0.x * p.x + uToNdc0.z * p.y + uToNdc1.x,
    uToNdc0.y * p.x + uToNdc0.w * p.y + uToNdc1.y
  );
  vUv = mix(aUv.xy, aUv.zw, corner);
  vTint = aTint;
  /* z is 0 and nothing depth-tests here: the order sprites were submitted in is the layering. */
  gl_Position = uClipCorrection * vec4(ndc, 0.0, 1.0);
}
`;

export const SPRITE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uSpriteTexture;

in vec2 vUv;
in vec4 vTint;
out vec4 fragColor;

${OUTPUT_TRANSFORM_GLSL}

void main() {
  /*
   * No branch reaches this fetch, so the implicit derivative is taken in uniform control flow and
   * a sheet may be mipmapped. The 2026-08-07 rule is about a sample under a branch and there is
   * none here; adding one later would mean a \`textureLod\`.
   */
  vec4 texel = texture(uSpriteTexture, vUv);
  vec4 colour = texel * vTint;
  if (colour.a < ${ALPHA_FLOOR.toFixed(8)}) discard;
  colour.rgb = applyOutputTransform(colour.rgb);
  /* Premultiplied out, because the blend is (ONE, ONE_MINUS_SRC_ALPHA). */
  fragColor = vec4(colour.rgb * colour.a, colour.a);
}
`;
