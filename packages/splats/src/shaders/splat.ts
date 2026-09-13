/** The splat program: a screen-space ellipse per Gaussian, sorted far to near and blended over. */

import { OUTPUT_TRANSFORM_GLSL } from '@driftengine/core';

/**
 * How far out the quad reaches, in standard deviations.
 *
 * Two sigma leaves `exp(-4)` — under two percent — at the corner, which is below what an eight-bit
 * frame resolves. Three would be more correct and costs 2.25 times the fill for a contribution
 * nothing can see; a splat cloud is fill-bound, so that is the whole argument.
 */
const SIGMA_REACH = 2.0;

/**
 * The largest an ellipse's semi-axis may be, in pixels.
 *
 * **A guard against one splat costing the whole frame**, not a quality dial. A Gaussian seen
 * nearly edge-on projects to an ellipse whose major axis grows without bound as the surface turns
 * into the view, and one such splat covering the screen at a hundred fragments' worth of blending
 * is a frame that drops. What it gives up is that a genuinely enormous splat is clipped rather
 * than drawn; what would make it wrong is a capture authored at a scale where this is common,
 * which is a capture whose splats are the size of the room.
 */
const MAX_RADIUS_PX = 512.0;

/**
 * The low-pass added to both diagonal terms of the screen-space covariance.
 *
 * **A splat smaller than a pixel must not vanish, and this is what keeps it.** Below about one
 * pixel the projected Gaussian falls between sample points and flickers as the camera moves —
 * the same aliasing a mip chain solves for a texture, solved here by widening the lobe to the
 * sampling rate. 0.3 is what every published implementation of this technique uses and it is a
 * variance in pixels squared, so it is a little over half a pixel of standard deviation.
 *
 * What it costs: a genuinely sub-pixel splat reads slightly larger and slightly dimmer than it
 * should, because widening without renormalising spreads the same alpha over more fragments.
 * What would make it wrong is a capture rendered far above its authored resolution, where every
 * splat is many pixels and this is a rounding error on all of them.
 */
const LOW_PASS = 0.3;

/**
 * Common declarations: the two data textures, the camera, and the viewport.
 *
 * **Both stages read `uSplatData`**, which is why it is declared here rather than in the vertex
 * stage alone — the fragment stage needs the colour, and passing it down as a varying would cost
 * four interpolators against one integer fetch.
 */
const SHARED = `
/**
 * Per-splat data, two texels each: position and colour, then the covariance.
 *
 * \`usampler2D\` and \`texelFetch\`, so there is no filtering and no float-texture extension
 * involved — WebGL2 core is enough. Texel 0 is the three position floats reinterpreted as uints
 * plus an RGBA8 colour; texel 1 is the six unique covariance terms as three half pairs.
 */
uniform highp usampler2D uSplatData;
/** The sorted order, one texel a splat. A new order re-uploads four bytes each and nothing else. */
uniform highp usampler2D uSplatOrder;
/** How many splats are in the order, so a budget can draw a prefix of it. */
uniform int uSplatCount;
/** Splats per row in both textures. A power of two, so the divide is a shift. */
uniform int uSplatStride;
/**
 * Texels one splat occupies: two, or three where the capture carries view-dependent colour.
 *
 * **A uniform rather than a constant**, because it is the *file's* width — a SPLT block carries
 * its own wordsPerSplat. A shader that assumed two would read a three-texel capture's second
 * splat at the first one's covariance, which is a cloud of noise rather than a subtle error.
 */
uniform int uSplatTexels;

uniform mat4 uView;
uniform mat4 uProjection;
/** Pixels, so the ellipse can be built in pixel space and converted once. */
uniform vec2 uViewport;
/** The capture's own transform, so two captures compose in one scene. */
uniform mat4 uModel;
`;

/**
 * The vertex stage: one ellipse per splat, six vertices, no buffers at all.
 *
 * **Nothing is bound but textures.** The geometry is `gl_VertexID` arithmetic — `id / 6` is the
 * splat and `id % 6` is the corner — so this pass owns no vertex buffer and no vertex array on
 * either backend, and the two compute the same geometry from the same one number. `demo/
 * contributedPass.ts` set that precedent and stated the reason.
 *
 * **What it costs: six vertex invocations a splat rather than the four an indexed quad issues.**
 * At a million splats that is two million extra runs of the arithmetic below. The alternative is a
 * static index buffer at 24 MB per million splats, which is why it is not the starting point.
 */
export const SPLAT_VERT = `#version 300 es
precision highp float;
precision highp int;
${SHARED}

out vec2 vCorner;
out vec4 vColor;

/**
 * The l=1 spherical-harmonic band constant, 0.5 * sqrt(3 / pi).
 *
 * The band-0 constant is the *reader's* — splatPly.ts folds it into the colour, because the DC
 * term is a colour once it has been applied. This one belongs here, because the term it scales is
 * a function of the view direction and cannot be folded into anything.
 */
const float SH_C1 = 0.4886025119029199;

/**
 * Where the camera is, in the **capture's own space**.
 *
 * Not world space, and the difference is the whole of what makes this correct: the coefficients
 * were trained in the capture's frame, so a capture placed into a scene by uModel — turned,
 * moved, scaled — must have its view direction expressed in the frame the coefficients know. The
 * inverse of uView * uModel is one CPU matrix a frame; doing it here would be one per vertex.
 */
uniform vec3 uSplatCameraLocal;
/** 0 for a capture with no harmonics, 1 for the l=1 band. The whole of the off path. */
uniform int uSplatShDegree;

/*
 * **Returns \`uvec4\`, and going through \`vec4\` was a real bug.** A position is a float's bits
 * reinterpreted as a uint — 0x3F800000 is 1,065,353,216 — and float32 carries 24 bits of mantissa,
 * so a round trip through it quantises the low bits of every coordinate. The picture that produces
 * is a capture whose splats are all *nearly* in the right place, which reads as a bad export.
 */
uvec4 fetchTexel(int splat, int which) {
  int at = splat * uSplatTexels + which;
  int width = uSplatStride * uSplatTexels;
  return texelFetch(uSplatData, ivec2(at % width, at / width), 0);
}

/*
 * **RGBA8 out of a uint by hand, because \`unpackUnorm4x8\` is GLSL ES 3.10 and this is 3.00.**
 *
 * It compiles through the generator, which raises the version to 310 before handing the source to
 * glslang — so a 3.10 builtin passes generation and fails at runtime on **WebGL2**, the backend
 * with no fallback beneath it. That inverts the safety property the whole
 * authored-in-GLSL-generated-to-WGSL arrangement exists for, and it is invisible until a browser
 * compiles the shader: the WGSL was correct the whole time.
 */
vec4 unpackRgba8(uint packed) {
  return vec4(
    float(packed & 0xFFu),
    float((packed >> 8) & 0xFFu),
    float((packed >> 16) & 0xFFu),
    float((packed >> 24) & 0xFFu)
  ) / 255.0;
}

/**
 * The view-dependent term of one splat's colour, from the texel packSh1 wrote.
 *
 * **The evaluation the reference implementation of this technique uses, in its own sign
 * convention**: −C1·y·c0 + C1·z·c1 − C1·x·c2, with the direction pointing *from* the camera
 * *to* the splat. Reproducing that sign pattern from first principles is where a reimplementation
 * goes wrong, and the failure is a capture whose sheen sits on the wrong side of every surface —
 * plausible from any one angle and unmistakable as soon as the camera moves.
 *
 * Nine bytes and a scale, which packSh1 explains: a per-splat scale spends the sixteenth byte on
 * giving every splat the whole 8-bit range for its own coefficients.
 */
vec3 viewDependentColour(uvec4 sh, vec3 direction) {
  float scale = uintBitsToFloat(sh.w);
  if (scale == 0.0) return vec3(0.0);
  vec4 a = unpackRgba8(sh.x);
  vec4 b = unpackRgba8(sh.y);
  vec4 c = unpackRgba8(sh.z);
  /* (byte / 255 * 255 − 128) / 127 undoes the quantisation exactly at the centre. */
  vec3 c0 = (vec3(a.x, a.y, a.z) * 255.0 - 128.0) / 127.0 * scale;
  vec3 c1 = (vec3(a.w, b.x, b.y) * 255.0 - 128.0) / 127.0 * scale;
  vec3 c2 = (vec3(b.z, b.w, c.x) * 255.0 - 128.0) / 127.0 * scale;
  return SH_C1 * (-direction.y * c0 + direction.z * c1 - direction.x * c2);
}

void main() {
  int vertex = gl_VertexID;
  int slot = vertex / 6;
  int corner = vertex % 6;

  /*
   * Off the end of the order: emit a degenerate triangle rather than clamping to the last splat,
   * which would draw it several times over and read as a bright speck that moves with the budget.
   */
  if (slot >= uSplatCount) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vCorner = vec2(0.0);
    vColor = vec4(0.0);
    return;
  }

  int splat = int(texelFetch(uSplatOrder, ivec2(slot % uSplatStride, slot / uSplatStride), 0).r);

  uvec4 texel0 = fetchTexel(splat, 0);
  uvec4 texel1 = fetchTexel(splat, 1);

  vec3 centre = uintBitsToFloat(texel0.xyz);
  vColor = unpackRgba8(texel0.w);

  /*
   * View-dependent colour, added to the DC term the reader already folded into the RGBA8.
   *
   * A uniform gate, so a capture without the band performs no fetch at all — this is provably
   * uniform control flow and not the 2026-08-07 case. Clamped at zero from below because a
   * negative radiance is not a colour and the reference implementation clamps in the same place;
   * **not clamped above**, because the composite downstream is where a range is resolved and
   * clipping here would throw away exactly the highlight this band exists to produce.
   */
  if (uSplatShDegree > 0) {
    vec3 direction = normalize(centre - uSplatCameraLocal);
    vColor.rgb = max(vColor.rgb + viewDependentColour(fetchTexel(splat, 2), direction), vec3(0.0));
  }

  vec2 c01 = unpackHalf2x16(texel1.x);
  vec2 c23 = unpackHalf2x16(texel1.y);
  vec2 c45 = unpackHalf2x16(texel1.z);
  /* xx xy xz yy yz zz, the order packSplats writes. */
  mat3 sigma = mat3(
    c01.x, c01.y, c23.x,
    c01.y, c23.y, c45.x,
    c23.x, c45.x, c45.y
  );

  vec4 world = uModel * vec4(centre, 1.0);
  vec4 view = uView * world;

  /*
   * Behind the near plane, or far outside the frustum: degenerate. A guard band rather than the
   * exact frustum, because a splat whose centre is just outside still has an ellipse reaching in.
   */
  vec4 clip = uProjection * view;
  if (view.z > -0.01 || abs(clip.x) > clip.w * 1.3 || abs(clip.y) > clip.w * 1.3) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vCorner = vec2(0.0);
    return;
  }

  /*
   * The 2x3 Jacobian of the perspective projection at this point, in pixels.
   *
   * A perspective divide is not linear, so a 3D Gaussian does not project to a 2D one — it
   * projects to something with no closed form. The standard treatment is to linearise about the
   * splat's centre, which is exact at the centre and increasingly wrong toward the edges of the
   * frame. **What would make it wrong** is a very wide field of view, where a splat at the corner
   * is measurably sheared; at ordinary angles the error is far below a pixel.
   */
  float focalX = uProjection[0][0] * uViewport.x * 0.5;
  float focalY = uProjection[1][1] * uViewport.y * 0.5;
  float invZ = 1.0 / view.z;
  float invZ2 = invZ * invZ;
  mat3x2 jacobian = mat3x2(
    focalX * invZ, 0.0,
    0.0, focalY * invZ,
    -focalX * view.x * invZ2, -focalY * view.y * invZ2
  );

  /* Sigma' = J W Sigma W^T J^T, with W the view rotation and the model's. */
  mat3 rotation = mat3(uView * uModel);
  mat3 world3 = rotation * sigma * transpose(rotation);
  mat2 screen = jacobian * world3 * transpose(jacobian);

  /* The low-pass, on the variances only. See LOW_PASS. */
  screen[0][0] += ${LOW_PASS.toFixed(1)};
  screen[1][1] += ${LOW_PASS.toFixed(1)};

  /*
   * Eigen-decompose the symmetric 2x2 in closed form: the axes of the ellipse are its
   * eigenvectors and the semi-axes are the square roots of its eigenvalues.
   */
  float a = screen[0][0];
  float b = screen[0][1];
  float d = screen[1][1];
  float mid = 0.5 * (a + d);
  float discriminant = sqrt(max(0.1, mid * mid - (a * d - b * b)));
  float lambda1 = mid + discriminant;
  float lambda2 = mid - discriminant;

  /* A non-positive minor eigenvalue is a degenerate ellipse: nothing to draw. */
  if (lambda2 <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vCorner = vec2(0.0);
    return;
  }

  vec2 major = normalize(vec2(b, lambda1 - a));
  /* Perpendicular by construction rather than by a second normalize, which would be the same
     vector computed twice and could disagree by an ulp at a degenerate b. */
  vec2 minor = vec2(-major.y, major.x);
  float radius1 = min(${SIGMA_REACH.toFixed(1)} * sqrt(lambda1), ${MAX_RADIUS_PX.toFixed(1)});
  float radius2 = min(${SIGMA_REACH.toFixed(1)} * sqrt(lambda2), ${MAX_RADIUS_PX.toFixed(1)});

  /* Two triangles over the unit square, in the corner order the fragment stage expects. */
  vec2 offsets[6] = vec2[6](
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
  );
  vec2 unit = offsets[corner];
  vCorner = unit * ${SIGMA_REACH.toFixed(1)};

  vec2 offsetPx = unit.x * major * radius1 + unit.y * minor * radius2;
  /* Pixels to clip space: the ellipse was built in pixels, so this is the only conversion. */
  gl_Position = vec4(
    clip.xy + offsetPx / uViewport * 2.0 * clip.w,
    clip.z,
    clip.w
  );
}
`;

/**
 * The fragment stage: the Gaussian's own falloff, premultiplied.
 *
 * **Premultiplied, and that one line is the difference between composing and not.** The pass
 * blends `ONE, ONE_MINUS_SRC_ALPHA` over a scene target that already holds opaque geometry, so
 * the source must arrive with its alpha already folded in. Emitting straight colour there
 * double-counts the alpha and produces a cloud that is too bright at every silhouette — which
 * reads as a exposure problem rather than as a blend-mode one, and is the failure this plan most
 * expects.
 */
export const SPLAT_FRAG = `#version 300 es
precision highp float;
precision highp int;
${OUTPUT_TRANSFORM_GLSL}

in vec2 vCorner;
in vec4 vColor;
out vec4 fragColor;

void main() {
  /* The Gaussian, in units where the quad's corner is SIGMA_REACH standard deviations out. */
  float power = dot(vCorner, vCorner);
  float alpha = vColor.a * exp(-0.5 * power);

  /*
   * Below what an eight-bit frame resolves. Discarding rather than blending nothing saves the
   * read-modify-write on the tail of every splat, which on a fill-bound pass is most of them.
   */
  if (alpha < 0.00392156862745098) discard;

  vec3 colour = applyOutputTransform(vColor.rgb);
  fragColor = vec4(colour * alpha, alpha);
}
`;
