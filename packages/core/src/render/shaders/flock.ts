/**
 * Birds: two triangles each, circling on a path computed entirely in the vertex
 * shader.
 *
 * No simulation, no CPU work per frame, no collision. A flock is scenery, and
 * scenery that costs frame time is a bad trade — what it buys is the sense that
 * the world exists without the player, which needs motion and silhouette, not
 * behaviour.
 */
export const FLOCK_VERT = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in float aWing;
layout(location = 2) in float aIndex;

uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uHeight;
uniform float uSpeed;
uniform float uTime;
uniform float uCount;
uniform float uScale;
/** Horizontal wind, m/s. Birds hold station against it rather than riding it. */
uniform vec2 uWind;

out float vShade;

void main() {
  // Each bird gets its own orbit: radius, height and rate all vary with index,
  // so the flock drifts apart and re-gathers instead of turning as one rigid
  // ring — which is what a shared angle alone produces.
  float id = aIndex;
  /*
   * Hashed from id + 1, and that +1 is a bug fix rather than a flourish.
   *
   * fract(sin(x) * k) has a fixed point at zero: sin(0) is 0, so bird 0 came out with spin
   * and lift of exactly 0 while every other bird got a scattered value. Zero is not a
   * middling result here, it is the floor of all three ranges at once — the innermost
   * orbit of the whole flock, the lowest height and the slowest wingbeat. Measured on the
   * storm scene: bird 0 orbited at 8.25 m while birds 1 to 33 spread over 8.34 to 15.72 m.
   * One bird in every flock, in every scene, permanently unlike the rest.
   */
  float seed = id + 1.0;
  float spin = fract(sin(seed * 12.9898) * 43758.5453);
  float lift = fract(sin(seed * 78.233) * 24634.6345);

  float radius = uRadius * (0.55 + spin * 0.5);
  float rate = uSpeed * (0.8 + lift * 0.45) / max(radius, 0.001);
  float angle = uTime * rate + id * 6.2831 / max(uCount, 1.0);

  vec3 heading = vec3(-sin(angle), 0.0, cos(angle));

  /*
   * Birds are not leaves. They hold station against a wind rather than being
   * carried off by it, so the wind does not translate them — it costs them
   * ground speed when they turn into it and gives it back downwind, and it
   * pushes the whole circuit slightly to leeward. The read is that they are
   * working, which is the only reason a bird is interesting at this distance.
   */
  float into = -dot(normalize(heading.xz + vec2(1e-5)), uWind) * 0.06;
  float driftAngle = angle + into;

  vec3 centre = uCenter + vec3(
    cos(driftAngle) * radius + uWind.x * 1.1,
    uHeight * (0.7 + lift * 0.6) + sin(uTime * 0.6 + id) * 1.4,
    sin(driftAngle) * radius + uWind.y * 1.1
  );

  // Wings beat about the bird's own travel direction, so the flap axis follows
  // the turn rather than staying locked to the world.
  vec3 forward = vec3(-sin(driftAngle), 0.0, cos(driftAngle));
  vec3 side = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));

  // Harder into the wind: the beat rate rises with how much of the heading
  // opposes it, which is what makes the effort legible without any simulation.
  float effort = 1.0 + max(into, 0.0) * 22.0;
  float beat = sin(uTime * (9.0 + spin * 4.0) * effort + id) * 0.5 + 0.5;
  // aWing is 0 at the body and 1 at the tip, so only the tip rises.
  float fold = aWing * beat * 0.55;

  vec3 offset = side * (aCorner.x * uScale)
    + forward * (aCorner.y * uScale * 0.6)
    + vec3(0.0, fold * uScale, 0.0);

  vec3 world = centre + offset;
  // Silhouette only: a bird at this distance is a shape against the sky, and
  // shading it properly would just make it grey.
  vShade = 0.55 + beat * 0.25;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

export const FLOCK_FRAG = `#version 300 es
precision highp float;

in float vShade;
uniform vec3 uTint;
out vec4 outColor;

void main() {
  outColor = vec4(uTint * vShade, 1.0);
}
`;
