/**
 * The vertex stage every full-viewport pass shares.
 *
 * One module because there is one right answer and three programs want it: the composite,
 * the ambient-occlusion estimate and its blur. Copying it into each would be three places
 * for the winding, the UV convention and the triangle-versus-quad decision to drift apart,
 * and a post chain whose passes disagree about which way up the image is fails in a way that
 * looks like every effect being wrong at once.
 */

/**
 * A fullscreen triangle from `gl_VertexID` alone — no vertex buffer, no VAO contents.
 *
 * Three vertices covering the viewport beats two triangles: the shared diagonal of a quad
 * makes some GPUs rasterise the seam twice, and a triangle has no seam.
 */
export const FULLSCREEN_VERT = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  // (-1,-1), (3,-1), (-1,3): a triangle whose clipped interior is exactly the viewport.
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vUv = corner * 0.5 + 0.5;
  gl_Position = vec4(corner, 0.0, 1.0);
}
`;
