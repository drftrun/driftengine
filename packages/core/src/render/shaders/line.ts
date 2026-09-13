import { FOG_GLSL } from './fog.ts';
import { OUTPUT_TRANSFORM_GLSL } from './outputTransform.ts';

/**
 * A polyline: a flat colour with a clean edge, a real width, and fog.
 *
 * **The plain sibling of `bolt.ts`, and they share a vertex expansion for a reason.** Both
 * turn a segment into a quad that faces the viewer, because a filament has no thickness to
 * see around and a world-fixed cross would make half the segments vanish edge-on. What they
 * do not share is everything after that: an arc is light arriving, so it is additive,
 * unlit, unfogged and allowed past white; a line is a thing in the world, so it is alpha
 * blended, fogged, and its edge is a clean one.
 *
 * **This exists because there is no portable wide line.** WebGL2's `lineWidth` is clamped to
 * one pixel by nearly every driver, and WebGPU has no line width at all. A one-pixel
 * hairline is also the wrong answer on a high-density display, where it reads as a scratch
 * rather than as a stroke. So the only line worth having is a triangle, which is what this
 * draws.
 */

export const LINE_VERT = `#version 300 es
layout(location = 0) in vec3 aFrom;
layout(location = 1) in vec3 aTo;
/** Along the segment (0 or 1), and which side of it (-1 or +1). */
layout(location = 2) in vec2 aCorner;

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform vec3 uCameraPos;
/** Half-width in metres, and how much of a pixel a far line must still cover. */
uniform float uWidth;
uniform float uMinWidthPerMetre;

out float vSide;
out vec3 vWorldPos;

void main() {
  /*
   * Through the model matrix before anything else, unlike an arc, whose endpoints are
   * world-space by nature. A line is usually attached to something that moves, and the
   * alternative is making every caller transform its own points on the CPU each frame.
   *
   * The width is deliberately *not* scaled by the model. A stroke's weight is a property
   * of how it is drawn rather than of the geometry it follows, so a card that shrinks
   * keeps the same line weight, which is what a reader expects and what a designer means.
   */
  vec3 from = (uModel * vec4(aFrom, 1.0)).xyz;
  vec3 to = (uModel * vec4(aTo, 1.0)).xyz;

  vec3 mid = mix(from, to, aCorner.x);
  vec3 dir = to - from;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec3(0.0, 1.0, 0.0);

  vec3 view = mid - uCameraPos;
  float dist = length(view);
  view = dist > 1e-6 ? view / dist : vec3(0.0, 0.0, 1.0);

  /*
   * Across the segment and across the line of sight. Degenerate exactly when the segment
   * points at the viewer, where any perpendicular is as good as another, and where the
   * segment covers almost no screen anyway.
   */
  vec3 across = cross(dir, view);
  float span = length(across);
  across = span > 1e-4 ? across / span : normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-3));

  /*
   * A floor on the world-space width that grows with distance, so a stroke never thins
   * below a pixel. Under a pixel a thin line does not get fainter, it *flickers*, because
   * the rasteriser catches it on some frames and not others.
   */
  float halfWidth = max(uWidth, dist * uMinWidthPerMetre);
  vec3 world = mid + across * aCorner.y * halfWidth;

  vSide = aCorner.y;
  vWorldPos = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const LINE_FRAG = `#version 300 es
precision highp float;

in float vSide;
in vec3 vWorldPos;

uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uCameraPos;
/**
 * How far in from the edge the stroke fades, as a fraction of its half-width. Zero is a
 * clean edge, one is a stroke that is soft all the way to its middle.
 */
uniform float uSoftness;

${FOG_GLSL}

out vec4 outColor;
${OUTPUT_TRANSFORM_GLSL}

void main() {
  /*
   * Coverage across the ribbon: one down the middle, falling to zero at both edges.
   *
   * The band is at least one pixel wide *in screen space*, which is what lets one shader
   * draw a stroke of any width at any distance without either aliasing into a staircase or
   * blurring into a smear. A constant band is tuned for one width and is wrong at the rest,
   * which is the same argument \`SDF_TEXT_FRAG\` makes for the same reason.
   */
  float edge = 1.0 - abs(vSide);
  float band = max(fwidth(vSide), uSoftness);
  float coverage = smoothstep(0.0, band, edge);

  /*
   * Fogged like geometry, which is where this parts company with \`bolt.ts\`. That shader
   * includes the same helpers and never calls them, because an arc is light arriving
   * rather than a surface losing some of itself to the air on the way over. A drawn line
   * is a thing in the world and recedes like one.
   */
  float fog = mediumFog(distance(vWorldPos, uCameraPos), vWorldPos.y);
  vec3 color = mix(uColor, mediumColor(), fog);
  outColor = vec4(applyOutputTransform(color), coverage * uOpacity);
}
`;
