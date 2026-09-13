/** Grain and relief: the two terms that come from the surface rather than from the light. */

export const SURFACE_GLSL = `float grainHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float grain(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(grainHash(i + vec3(0.0, 0.0, 0.0)), grainHash(i + vec3(1.0, 0.0, 0.0)), u.x),
      mix(grainHash(i + vec3(0.0, 1.0, 0.0)), grainHash(i + vec3(1.0, 1.0, 0.0)), u.x),
      u.y
    ),
    mix(
      mix(grainHash(i + vec3(0.0, 0.0, 1.0)), grainHash(i + vec3(1.0, 0.0, 1.0)), u.x),
      mix(grainHash(i + vec3(0.0, 1.0, 1.0)), grainHash(i + vec3(1.0, 1.0, 1.0)), u.x),
      u.y
    ),
    u.z
  );
}

/**
 * A colour read as a height, for \`uTextureRelief\`.
 *
 * Luminance rather than three.js's red channel alone, because the image doing this job here is
 * the *colour* image and a red-only reading ties how tall a bump is to what colour it happens
 * to be — a rust streak on grey rock would stand proud of it for no reason a surface has. On the
 * greyscale tile a dedicated bump map usually is, the two agree exactly.
 *
 * Rec. 709 weights, matching \`bloom.ts\`'s own discussion of the same coefficients.
 */
float surfaceHeight(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}
`;
