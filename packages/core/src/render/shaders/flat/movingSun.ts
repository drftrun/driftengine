/**
 * The sun's moving layer read through a matrix of its own: the one the frame's dynamic shadow pass
 * was drawn with, where that is not the static layer's.
 *
 * **Why a matrix of its own.** The static layer wants a square over the whole of what stands still,
 * so distant roofs keep their shadows; what moves wants a tight one, so a character's shadow is
 * sharp. One matrix for both is one of the two given up. A caller fits each as it likes and draws
 * each pass with its own (`beginShadowPass(matrix, 'dynamic')`); the renderer keeps the dynamic
 * pass's and the lit stage reads that layer through it, the receiver's position projected from the
 * world here rather than carried in a second varying.
 *
 * **A lit switch, `MOVING_SUN`**, off until a frame's dynamic pass is drawn with a matrix the static
 * layer does not share, then on for good. Declared beside the other lit switches, ahead of the
 * shadow lookup that calls it; compiled out, the moving layer is read at the static layer's place,
 * exactly as it always was, and its matrix and depth span are not declared at all.
 *
 * **What it gives up**: a receiver outside the static layer's square takes no sun shadow at all,
 * moving casters included, since everything is faded by that square first; so the tight square
 * belongs inside the wide one.
 */
export function movingSunGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool MOVING_SUN = false;  // wgsl:override
vec3 movingSunAt() { return vec3(0.0); }
float movingSunSpan() { return 1.0; }
`;
  }
  return /* glsl */ `
/* Whether the moving layer has a matrix of its own. Off until a frame draws it with one: movingSun.ts. */
const bool MOVING_SUN = true;  // wgsl:override
/* The dynamic shadow pass's world-to-light matrix, and the depth it spans in metres. */
uniform mat4 uMovingLightViewProj;
uniform float uMovingShadowDepthSpan;

/* The receiver in the moving layer's map: x and y across it, z its depth, all 0 to 1. */
vec3 movingSunAt() {
  vec4 l = uMovingLightViewProj * vec4(vWorldPos, 1.0);
  return l.xyz / l.w * 0.5 + 0.5;
}

float movingSunSpan() {
  return uMovingShadowDepthSpan;
}
`;
}
