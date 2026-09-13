/**
 * A flat, blended rectangle in screen space.
 *
 * The engine could draw a solid rectangle two ways before this and neither is one:
 * `beginInset` clears a box to a colour, which is opaque by definition, and
 * `TextRenderer.setPlate` builds the rectangle out of one lit *cube per cell* — right
 * for a keycap two cells tall, and at panel size a grid of seams: a plate made that
 * way reads as messy rather than as plain.
 *
 * So: two triangles, one colour, one alpha, no lighting and no geometry. What a caller
 * wants when it needs somewhere to read type against.
 *
 * Coordinates are **CSS pixels with a top-left origin**, the same convention
 * `InsetRect` uses and the same one a caller laying out an overlay already has.
 */
export const PANEL_VERT = `#version 300 es
layout(location = 0) in vec2 aCorner;

/** left, top, width, height, in CSS pixels from the top-left of the viewport. */
uniform vec4 uRect;
uniform vec2 uViewport;
/**
 * Clip space, as the backend drawing this defines it. Identity on WebGL2.
 *
 * Like the text pass, this builds its own clip position and never multiplies by a camera, so the
 * correction every other draw carries in its view-projection cannot reach it. Without it the
 * generated vertex shader's Y negation stands uncancelled and the panel lands mirrored about
 * the middle of the frame — a bar drawn at 82% of the height appearing at 18% of it.
 */
uniform mat4 uClipCorrection;

void main() {
  vec2 px = uRect.xy + aCorner * uRect.zw;
  // Into clip space, flipping y: the caller counts down from the top and GL counts up.
  vec2 ndc = vec2(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0);
  gl_Position = uClipCorrection * vec4(ndc, 0.0, 1.0);
}
`;

export const PANEL_FRAG = `#version 300 es
precision highp float;

uniform vec3 uColor;
uniform float uAlpha;

out vec4 outColor;

void main() {
  outColor = vec4(uColor, uAlpha);
}
`;
