import { OUTPUT_TRANSFORM_GLSL } from './outputTransform.ts';

/**
 * Text from a multi-channel signed distance field.
 *
 * GLSL is the source of truth; `npm run wgsl` produces the WGSL beside it. Written to the
 * same rules every other shader here follows, which is why the sampler is `textureLod`:
 * the alpha test is not uniform control flow.
 */

export const SDF_TEXT_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aUv;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec2 vUv;

void main() {
  vUv = aUv;
  gl_Position = uViewProj * uModel * vec4(aPosition, 1.0);
}
`;

export const SDF_TEXT_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uAtlas;
uniform vec3 uColor;
uniform float uOpacity;
/* Texels the field spans, from the atlas metrics. Scales the antialiasing band. */
uniform float uDistanceRange;
uniform vec2 uAtlasSize;

out vec4 outColor;
${OUTPUT_TRANSFORM_GLSL}

/*
 * The middle of the three channels.
 *
 * A single-channel field rounds every corner off at small sizes, because one distance
 * cannot describe two edges meeting. Three channels carry the corner and the median
 * recovers it.
 */
float median(vec3 rgb) {
  return max(min(rgb.r, rgb.g), min(max(rgb.r, rgb.g), rgb.b));
}

void main() {
  vec3 sampled = textureLod(uAtlas, vUv, 0.0).rgb;
  float distance = median(sampled) - 0.5;

  /*
   * The band is one pixel wide *in screen space*, which is what lets one atlas serve every
   * size. A constant band is tuned for one size and is wrong at all the others.
   */
  vec2 texelsPerPixel = fwidth(vUv) * uAtlasSize;
  float pixelRange = max(0.5 * (texelsPerPixel.x + texelsPerPixel.y), 0.0001);
  float coverage = clamp(distance * uDistanceRange / pixelRange + 0.5, 0.0, 1.0);

  outColor = vec4(applyOutputTransform(uColor), coverage * uOpacity);
}
`;
