import { glslSceneDepthToNdc } from '../depthConvention.ts';
/**
 * Depth of field: a circle of confusion from the depth buffer, and a disc blur that follows it.
 *
 * **A snippet spliced into the composite rather than a pass of its own**, because the composite
 * already holds everything this needs — the resolved scene, its depth, and a place in the chain
 * where the picture is finished but not yet graded. A second fullscreen pass would mean a second
 * read and a second write of the whole frame to add eight taps to the pixels that are out of
 * focus, which is the shape `ambientOcclusion.ts` takes only because it must blur its own noisy
 * estimate first. Nothing here is noisy.
 *
 * **Off costs one comparison.** `uDofStrength` at zero is a branch on a uniform — provably uniform
 * control flow, so it is not the 2026-08-07 case — and the frame is the frame that existed before
 * the effect did, bit for bit.
 *
 * **The model, and why it is stated in metres.** A lens has a plane it is focused on and a depth
 * either side of it that is acceptably sharp; past that, a point becomes a disc whose diameter
 * grows with how far out of focus it is. So the two numbers a caller gives are a *distance* and a
 * *range*, both in metres of the world, and the shader turns them into a radius in pixels. A
 * formulation in depth-buffer units would be cheaper and would mean nothing to anyone: a camera
 * focuses on a thing at a distance, not on a value of `gl_FragCoord.z`.
 *
 * **What the ramp is, exactly.** Zero inside `range` metres of the plane, reaching full blur one
 * more `range` beyond it, clamped there. Linear rather than physical: a real circle of confusion
 * grows without bound behind the plane and toward the lens in front of it, and reproducing that
 * needs an aperture, a focal length and a sensor size — three numbers a game camera does not have
 * and would have to invent. *What that gives up* is that a caller cannot reproduce a particular
 * lens. *What would reverse it* is a consumer matching real optics, and the answer then is those
 * three numbers rather than a different curve on these two.
 *
 * **The bleed, and the one line that handles it.** The classic artefact of a gather blur is a
 * sharp foreground subject collecting colour from the blurred background behind it, so it wears a
 * halo of whatever it is standing in front of. A tap here is weighted by whether it is *behind*
 * the pixel it is blurring into — which it may always contribute to — or in front of it, where it
 * contributes only as far as it is itself defocused. That is one compare per tap and it removes
 * the halo. *What it does not do* is spread a blurred foreground *over* a sharp background, which
 * a gather cannot do at all: no tap on the background ever reaches out to find it. A scatter pass
 * or a separate near field is the answer, and neither is here.
 */

/** How many taps the disc takes. Eight, fixed, so the cost of the effect is a constant. */
export const DOF_TAPS = 8;

export const DEPTH_OF_FIELD_GLSL = `
/** Where the lens is focused, in metres from the camera. */
uniform float uFocusDistance;
/**
 * How many metres either side of that plane stay sharp, and over how many more the blur reaches
 * full strength. One number for both, because two would be a second dial with no second question.
 */
uniform float uFocusRange;
/**
 * The widest the blur may reach, as a fraction of the frame's height. 0 turns the effect off and
 * is the whole of the off path.
 */
uniform float uDofStrength;
/**
 * \`vec2(height / width, 1.0)\`, so a radius given in fractions of the frame's height traces a
 * circle on screen rather than an ellipse stretched by the aspect.
 */
uniform vec2 uDofAspect;
/**
 * The four elements of the inverse projection that turn a depth sample into a view-space distance:
 * \`(m[10], m[14], m[11], m[15])\` in gl-matrix's column-major order, which are \`M[2][2]\`,
 * \`M[2][3]\`, \`M[3][2]\` and \`M[3][3]\`.
 *
 * Four floats rather than the whole matrix, because the other twelve are multiplied by the x and y
 * of a clip position this never needs: a perspective projection's inverse has zeroes where they
 * would land. \`ambientOcclusion.ts\` uploads the full \`uInvProjection\` because it reconstructs a
 * *position* and needs them.
 */
uniform vec4 uDepthToView;

/**
 * Metres in front of the camera, from a depth sample.
 *
 * \`depth * 2.0 - 1.0\` is the same recovery \`cameraBlur\` makes and for the same reason: the depth
 * attachment holds [0, 1] on both backends, the projection whose inverse this carries is the
 * uncorrected OpenGL-convention one, and the engine settles the difference between the two clip
 * spaces in the matrix rather than in the shaders.
 */
float viewDepthOf(vec2 uv) {
  float z = ${glslSceneDepthToNdc('textureLod(uDepth, uv, 0.0).r')};
  return -(uDepthToView.x * z + uDepthToView.y) / (uDepthToView.z * z + uDepthToView.w);
}

/** 0 inside the sharp zone, 1 at full blur. See the header for the shape of the ramp. */
float circleOfConfusion(float viewDepth) {
  float offPlane = abs(viewDepth - uFocusDistance) - uFocusRange;
  return clamp(offPlane / uFocusRange, 0.0, 1.0);
}

/**
 * The eight offsets of the disc, written out.
 *
 * A golden-angle spiral at radii spaced by \`sqrt((i + 0.5) / 8)\`, which fills a disc evenly
 * rather than stacking the taps into a ring. Literals rather than a loop over \`cos\` and \`sin\`,
 * because these are constants and evaluating them per pixel is eight transcendentals for a table.
 * Successive taps turned by the golden angle never line up into spokes, which is the same
 * property \`ambientOcclusion.ts\` picks it for.
 *
 * The colour comes back premultiplied by the weight and the weight rides in \`w\`, rather than an
 * \`inout\` parameter — one value out of one function, which is what the generator translates most
 * predictably.
 */
vec4 dofTap(vec2 direction, float radius, float centreDepth) {
  vec2 uv = vUv + direction * radius * uDofAspect;
  float depth = viewDepthOf(uv);
  /* Behind the pixel it is blurring into, or defocused enough to have spread this far. */
  float weight = depth >= centreDepth ? 1.0 : circleOfConfusion(depth);
  /* textureLod: this is reached through a branch on the circle of confusion, which varies across
     the frame, so it is not uniform control flow. Identical output — one storage level. */
  return vec4(textureLod(uScene, uv, 0.0).rgb * weight, weight);
}

/**
 * The disc, gathered.
 *
 * The centre sample is the colour handed in rather than a fresh fetch, so a pixel that has already
 * been camera-blurred keeps that blur at the middle of its own disc. *What that gives up* is that
 * the eight taps read the unblurred scene, so the two effects compose approximately rather than
 * exactly. *What would make it wrong* is a consumer running both at full strength and caring which
 * order they were applied in, and the answer then is a second scene target for the intermediate.
 */
vec3 depthOfField(vec3 centre) {
  float depth = viewDepthOf(vUv);
  float coc = circleOfConfusion(depth);
  if (coc <= 0.0) return centre;
  float radius = coc * uDofStrength;
  vec4 sum = vec4(centre, 1.0);
  sum += dofTap(vec2( 0.250000,  0.000000), radius, depth);
  sum += dofTap(vec2(-0.319290,  0.292496), radius, depth);
  sum += dofTap(vec2( 0.048872, -0.556877), radius, depth);
  sum += dofTap(vec2( 0.402444,  0.524918), radius, depth);
  sum += dofTap(vec2(-0.738535, -0.130636), radius, depth);
  sum += dofTap(vec2( 0.699605, -0.445031), radius, depth);
  sum += dofTap(vec2(-0.234004,  0.870484), radius, depth);
  sum += dofTap(vec2(-0.446271, -0.859268), radius, depth);
  return sum.rgb / sum.w;
}
`;
