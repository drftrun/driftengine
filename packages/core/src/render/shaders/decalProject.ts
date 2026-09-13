/**
 * A decal projected onto whatever the depth buffer holds.
 *
 * **The pass is the inverse of the camera and nothing else.** Each pixel inside the projector's
 * scissor rectangle is turned back into the world point its depth stands for, that point is put
 * into the box's own space, and a mark lands where all three coordinates come back within one. No
 * geometry is clipped and no mesh is built, so the receiving surface may deform, stream in, or be
 * drawn by something with no CPU-side geometry at all — which is exactly what `projectDecal`
 * cannot do and the whole reason this exists beside it.
 *
 * **It multiplies rather than covers, and that is a design decision rather than a shortcut.** A
 * forward renderer has no G-buffer, so by the time this runs the receiving pixel is already lit
 * and there is nowhere to write an albedo. Painting a flat colour over it would light the mark by
 * nothing at all: a scorch mark in an unlit corner would glow. Multiplying takes the receiver's
 * lighting exactly — for a diffuse surface it is identical to having marked the albedo before the
 * light was applied — at the cost that a mark can darken and tint and can never brighten. Scorch,
 * oil, blood, wet patches and blob shadows are what that covers; a glowing rune is not.
 *
 * **Nothing here branches and nothing discards.** White is the identity of a multiply, so a pixel
 * the projector misses writes white and changes nothing, which means the whole shader is one
 * straight line. That is not tidiness: the surface normal comes from the derivatives of the
 * reconstructed position, and a derivative taken inside non-uniform control flow is undefined —
 * the rule `AGENTS.md` states for `texture()` in a branch, arriving through the other door.
 */

import { glslIsFarDepth } from '../depthConvention.ts';

export const DECAL_PROJECT_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/**
 * The depth the frame has drawn, as a copy.
 *
 * **A copy and never the attachment.** Sampling a texture that is attached to the bound
 * framebuffer is undefined in WebGL2, and undefined here means a plausible picture on this driver
 * and a different one on the next: \`SceneTarget.snapshotDepth\` exists for exactly this, and the
 * WebGPU backend reads its resolved depth for the same reason.
 *
 * \`highp\` because it is a 32-bit depth and the reconstruction below is a division by it.
 */
uniform highp sampler2D uDecalDepth;
/**
 * Screen position and stored depth back to the world, which is
 * \`inverse(viewProjection) * DEPTH_01_TO_CLIP\`.
 *
 * The Y-flipped variant of that constant is what the other backend passes, and \`lightVolumeDraw.ts\`
 * carries the derivation and what one missing negation costs.
 */
uniform mat4 uDecalDepthToWorld;
/** World space into the projector's unit box. See \`worldToDecalMatrix\`. */
uniform mat4 uWorldToDecal;
/** Where the eye is, which is what gives the reconstructed normal a defined sign. */
uniform vec3 uDecalEye;
/** The projection axis, normalised. A surface is marked when it faces back along this. */
uniform vec3 uDecalAxis;
/** What the mark multiplies the surface by. */
uniform vec3 uDecalColor;
/** How much of that colour lands. */
uniform float uDecalOpacity;
/** How far a surface may be turned from facing the projector, as a cosine. */
uniform float uDecalFacingCos;
/** How much of the mark's radius is edge. */
uniform float uDecalSoftness;

out vec4 fragColor;

void main() {
  float stored = textureLod(uDecalDepth, vUv, 0.0).r;

  /*
   * The pixel's world position. \`vUv * 2 - 1\` is the screen half of it and \`stored\` the depth
   * half, and the matrix carries the remap from the buffer's sense to the clip space the camera
   * was built in — including, on one backend, the Y flip that the generated WGSL applies to every
   * vertex stage.
   */
  vec4 world = uDecalDepthToWorld * vec4(vUv * 2.0 - 1.0, stored, 1.0);
  vec3 point = world.xyz / world.w;

  /*
   * **The surface normal from the reconstruction's own derivatives**, because there is no normal
   * buffer to read one from and adding one means a second colour attachment on every draw path in
   * the engine. Two neighbouring pixels of the same surface span it, so their cross product is its
   * plane — noisy along a silhouette, where one of the two neighbours is a different surface
   * altogether, and exact everywhere else.
   *
   * **Turned to face the eye rather than trusted.** Which way \`cross\` points depends on which way
   * the framebuffer's rows run, and the two backends disagree about that — so a sign taken from
   * the cross product alone marks the tops of things on one and the undersides on the other, with
   * nothing raising. A visible surface faces the eye by definition, so that is what fixes it.
   */
  vec3 plane = cross(dFdx(point), dFdy(point));
  float span = length(plane);
  vec3 normal = span > 0.0 ? plane / span : uDecalAxis;
  normal *= sign(dot(uDecalEye - point, normal));

  vec3 box = (uWorldToDecal * vec4(point, 1.0)).xyz;

  /* Inside the box on every axis, as a product of three steps rather than three branches. */
  vec3 inside = step(abs(box), vec3(1.0));
  float mark = inside.x * inside.y * inside.z;

  /*
   * An ellipse across the face with a soft edge, rather than the box's own rectangle. A mark with
   * no texture has nothing else to shape it, and a hard rectangle reads as a decal cut out with
   * scissors.
   */
  float radius = length(box.xy);
  mark *= 1.0 - smoothstep(1.0 - uDecalSoftness, 1.0, radius);

  /*
   * Faded rather than cut where the surface turns away from the projector. A wall standing edge-on
   * to the projector occupies one pixel of depth per metre of wall, so an unfaded mark aimed at
   * the floor smears the whole depth of the box up it — the classic failure of a projected decal,
   * and what \`facingCos\` is for on the static half of this too.
   */
  float facing = dot(normal, -uDecalAxis);
  mark *= smoothstep(uDecalFacingCos, min(1.0, uDecalFacingCos + 0.25), facing);

  /* Nothing was drawn here at all, so there is no surface to mark — only the sky. */
  mark *= ${glslIsFarDepth('stored')} ? 0.0 : 1.0;

  /* White is the identity of a multiply, so a pixel the projector missed changes nothing. */
  fragColor = vec4(mix(vec3(1.0), uDecalColor, mark * uDecalOpacity), 1.0);
}
`;
