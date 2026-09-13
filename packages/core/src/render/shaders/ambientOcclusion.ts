import { glslIsFarDepth, glslSceneDepthToNdc } from '../depthConvention.ts';
/**
 * Ambient occlusion from depth: the estimate, and the blur that makes it usable.
 *
 * Contact shading — the darkening where two surfaces meet, under a wheel arch, along a panel
 * gap, where a plinth stands on a floor. It is most of what makes a model sit in a room
 * rather than float in it, and its absence does not read as a missing effect. It reads as
 * the geometry having been pasted over the picture.
 *
 * **Two passes rather than one, and that is the whole design decision.** Occlusion estimated
 * inside the composite pass and used directly was built first and looked at: twelve depth
 * samples per pixel is a noisy estimate of a smooth quantity, and a frame of it is salt and
 * pepper over every surface. Every renderer that ships this blurs it, and a blur needs the
 * estimate to exist somewhere first. So the estimate lands in its own single-channel target,
 * gets smoothed by a separable pass that will not cross a depth edge, and the composite
 * multiplies by the result.
 *
 * The pairing that makes twelve taps enough: the sampling directions are turned by a
 * rotation that repeats every four pixels, and the blur runs over eight. Every four-pixel run
 * contains all sixteen rotations exactly once, so averaging one recovers a sixteen-times-denser
 * kernel; averaging two also halves what is left of the noise, and — the part that decides the
 * width — leaves a pixel hard against a silhouette with four consecutive taps still on its own
 * side of the edge. Neither half works alone: a random per-pixel rotation leaves noise the blur
 * can only soften, and a window narrower than two periods leaves the tile itself on screen
 * wherever the depth test cuts the window short, as a dotted line along every edge.
 */

/**
 * The estimate. Writes one channel: 1 is open sky, 0 is fully enclosed.
 *
 * The estimator is the Alchemy/scalable-AO one — for each neighbour, the vector v from this
 * surface to it, weighted max(0, v·n) / (v·v). Two properties earn it its place over a
 * hemisphere of offset points: nothing has to be oriented, so there is no tangent frame and
 * no rotation matrix per pixel, and the 1 / v·v term falls away on its own, so a neighbour
 * further off contributes less without a second range test doing it by hand.
 */
export const AO_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

/**
 * **highp, and the whole effect depends on it.** GLSL ES gives a fragment shader's samplers a
 * default precision of *lowp*, whatever the precision highp float line above says — that
 * sets the default for float, not for a sampler. A lowp sampler may hand back eight bits,
 * and eight bits of depth is a scene collapsed onto a couple of hundred planes.
 *
 * This was built without the qualifier and looked at first. The picture says exactly what it
 * is once you know: the reconstructed normal came back as (0, 0, 1) over every surface,
 * because within one of those planes the depth does not change between neighbouring pixels
 * and the cross product of the two derivatives has nothing to work with. What reached the
 * screen was contour banding along the planes themselves — rings up the car's flanks and
 * stripes across the floor, which is a topographic map of the quantisation.
 */
uniform highp sampler2D uDepth;
/**
 * The projection's x and y scales, which turn a world radius into a screen one.
 *
 * mat4[0][0] and [1][1] of the perspective matrix and nothing else, so the whole projection
 * does not have to be uploaded to answer "how much of the frame does half a metre cover at
 * this depth". It carries the aspect ratio with it, which is why the reach is a vec2: a
 * circle on screen is not a circle in UV.
 */
uniform vec2 uProjScale;
/** Clip back to view space, so a depth sample becomes a position that can be compared. */
uniform mat4 uInvProjection;
/** How far the sampling reaches, in metres of the world. */
uniform float uRadius;

out float fragColor;

/** How many depths each pixel compares itself against. Fixed, so the cost is fixed. */
const int AO_TAPS = 12;
/**
 * The golden angle, in radians.
 *
 * Successive taps turned by it never line up into spokes, which a rational fraction of a
 * turn does: a kernel that repeats a direction is blind along it, and it is blind the same
 * way in every pixel, so it reads as a pattern in the surface rather than as noise.
 */
const float AO_GOLDEN_ANGLE = 2.39996323;
/**
 * How far the sampling may reach across the frame, whatever the depth says.
 *
 * A surface almost touching the near plane projects half a metre onto most of the screen,
 * and without a ceiling those pixels each read the whole frame's depth: the effect stops
 * being contact shading and becomes an expensive wide darkening. 6% of the frame.
 */
const float AO_MAX_REACH_UV = 0.06;
/**
 * Self-occlusion guard, as a fraction of the pixel's own view depth.
 *
 * Depth is quantised, so a flat surface samples itself very slightly in front of itself and
 * every flat surface in the world comes back faintly dirty. The error grows with distance,
 * which is why the guard is proportional to depth rather than a constant.
 */
const float AO_BIAS = 0.004;
/**
 * The floor under the 1 / (v·v) weighting, in square metres.
 *
 * Not a guard against dividing by zero, which is what a value near the float epsilon would
 * be. The nearest taps land about a centimetre away, where v·v is 1e-4 and the weight is ten
 * thousand — so a depth quantised to a millimetre yields several units of occlusion out of
 * nothing at all. Measured that way first, with 1e-4 here: a flat floor came back as static.
 * A hundredth of a square metre is a tenth of a metre of separation, which is the scale
 * below which two samples are the same surface rather than one occluding the other.
 */
const float AO_EPSILON = 0.01;
/**
 * How many times further one neighbour may be than the other before the pair straddles an edge.
 *
 * Eight, and deliberately far above anything a continuous surface produces. On a plane seen at a
 * grazing angle the two one-sided depth deltas do differ — depth grows nonlinearly with screen
 * position — but only by a few percent except within a pixel or two of the vanishing point. A
 * silhouette is not a factor of eight, it is a factor of hundreds, so the gate can afford to sit
 * high and it is worth putting it there: every fragment this test lets through keeps the plain
 * quad derivative, which is the picture that shipped.
 */
const float AO_EDGE_RATIO = 8.0;
/**
 * The floor under that ratio, as a fraction of the pixel's own view depth.
 *
 * **Without it the test is a comparison of two quantisation errors**, which is how a flat floor
 * acquires a horizontal band at every contour of constant depth. Five percent of the distance is
 * far above any depth buffer's quantum, above the difference two sides of a grazing plane show,
 * and far below the step at any edge worth shading — a kerb against a deck is metres of it.
 */
const float AO_EDGE_FLOOR = 0.05;

/** View-space position of whatever is at this pixel, from its depth alone. */
vec3 viewPosition(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, ${glslSceneDepthToNdc('depth')}, 1.0);
  vec4 view = uInvProjection * clip;
  return view.xyz / view.w;
}

void main() {
  /*
   * One output pixel, in UV, along each axis.
   *
   * Taken before anything branches, because that is where a derivative is defined, and taken of
   * vUv rather than of a reconstructed position: vUv is linear across a fullscreen triangle, so
   * these are exact and constant. They are the *output's* pixel, which is what the neighbour
   * taps below want — this estimate runs at half the frame on one backend and at full size on
   * the other, and a step measured in the depth texture's texels would be wrong on one of them.
   */
  vec2 stepX = dFdx(vUv);
  vec2 stepY = dFdy(vUv);

  float depth = textureLod(uDepth, vUv, 0.0).r;
  vec3 p = viewPosition(vUv, depth);
  /*
   * Both derivatives taken before anything branches on the depth. dFdx is only defined where
   * every pixel of the quad reaches it, so a sky pixel returning early would leave the
   * derivative undefined for the *geometry* pixels beside it — a wrong normal along every
   * horizon in the frame, from a shader that reads as correct.
   */
  vec3 dpdx = dFdx(p);
  vec3 dpdy = dFdy(p);
  /* Nothing occludes the sky, and there is no surface here to occlude. */
  if (${glslIsFarDepth('depth')}) {
    fragColor = 1.0;
    return;
  }

  /*
   * At a silhouette, the quad derivative above is replaced by the one-sided difference that
   * stays on this pixel's own surface. **Everywhere else it is left exactly alone**, and that
   * restraint is the whole design of these twelve lines.
   *
   * **What it fixes.** A hardware derivative is a difference across a 2x2 quad, and every
   * silhouette in the frame puts two surfaces in one quad: the difference is a secant from the
   * near surface to the far one, metres long, and the cross product of two such secants is a
   * normal roughly *perpendicular* to the real one. The dot of v with n for taps on the
   * neighbouring surface comes back large and positive, the sum saturates, and the pixel clamps
   * to black — every platform edge, every kerb and the character's own outline carrying black
   * speckle. Speckle rather than a clean line, because the rotation tile below turns each
   * pixel's taps differently, and the depth-aware blur that follows is designed *not* to cross
   * an edge, so it preserved the garbage precisely where the garbage was.
   *
   * **What it must not do, learned the hard way.** The textbook cure is to take both one-sided
   * differences everywhere and keep whichever has the smaller depth delta. That was built and
   * shipped to a reporter, and it bands: the two sides of a flat surface differ by a
   * quantisation step or by nothing, so "smaller delta" selects whichever side happens to read
   * zero, the choice flips wherever the depth steps, and on a plane receding from the camera
   * that is a contour — a horizontal stripe across the floor, over the whole world. The header
   * above this shader describes the same picture arriving from a lowp sampler and names it: a
   * topographic map of the quantisation.
   *
   * So the substitution is gated on a *discontinuity*, not on a preference. One side must be
   * several times the other **and** clear of a floor proportional to this pixel's own distance,
   * which no quantisation step and no continuous slope can reach. On everything that is not an
   * edge these lines change nothing at all, which is what makes them safe to add.
   */
  vec3 right = viewPosition(vUv + stepX, textureLod(uDepth, vUv + stepX, 0.0).r);
  vec3 left = viewPosition(vUv - stepX, textureLod(uDepth, vUv - stepX, 0.0).r);
  vec3 down = viewPosition(vUv + stepY, textureLod(uDepth, vUv + stepY, 0.0).r);
  vec3 up = viewPosition(vUv - stepY, textureLod(uDepth, vUv - stepY, 0.0).r);

  /* View distance is positive down -z, and the floor is a fraction of this pixel's own. */
  float here = -p.z;
  float edgeFloor = AO_EDGE_FLOOR * here;
  float rightGap = abs(-right.z - here);
  float leftGap = abs(-left.z - here);
  float downGap = abs(-down.z - here);
  float upGap = abs(-up.z - here);

  /* Both arms written towards increasing x and y, so which one wins cannot flip the handedness
     of the cross product below — only the eye-facing test after it would have to notice. */
  if (rightGap > leftGap * AO_EDGE_RATIO + edgeFloor) dpdx = p - left;
  else if (leftGap > rightGap * AO_EDGE_RATIO + edgeFloor) dpdx = right - p;
  if (downGap > upGap * AO_EDGE_RATIO + edgeFloor) dpdy = p - up;
  else if (upGap > downGap * AO_EDGE_RATIO + edgeFloor) dpdy = down - p;

  vec3 n = normalize(cross(dpdx, dpdy));
  /*
   * Turned to face the eye. Which sign the cross product comes out with is a fact about the
   * screen-space winding and the handedness of the projection, and a normal pointing away
   * from the camera makes every v·n come back zero, which is a frame with no occlusion in it
   * anywhere. In view space the eye is the origin, so a normal facing it satisfies n·p < 0.
   */
  if (dot(n, p) > 0.0) n = -n;

  /*
   * The radius as a fraction of the frame. A metre subtends less of the screen the further
   * away it is, which is the entire reason this is computed per pixel rather than handed in.
   */
  vec2 reach = min(
    uRadius * uProjScale * 0.5 / max(-p.z, 1e-3),
    vec2(AO_MAX_REACH_UV)
  );

  /*
   * A rotation that repeats every four pixels: sixteen distinct turns laid out over a 4x4
   * tile. Paired with the four-wide blur that follows, every blurred pixel averages all
   * sixteen, which is what makes twelve taps enough. A per-pixel hash would decorrelate
   * neighbours better in principle and is worse here, because the blur can then only soften
   * the noise rather than complete the kernel.
   */
  float tile = mod(gl_FragCoord.x, 4.0) + 4.0 * mod(gl_FragCoord.y, 4.0);
  float turn = tile * (6.2831853 / 16.0);

  float sum = 0.0;
  for (int i = 0; i < AO_TAPS; i++) {
    float t = (float(i) + 0.5) / float(AO_TAPS);
    float angle = turn + float(i) * AO_GOLDEN_ANGLE;
    /* The square root spreads the taps evenly over the disk; without it they crowd the
       centre, where they are measuring the pixel's own depth. */
    vec2 uv = vUv + vec2(cos(angle), sin(angle)) * sqrt(t) * reach;

    /*
     * textureLod, not texture, and it is the rule rather than a preference: this sample sits
     * inside a loop whose iterations a compiler cannot prove uniform, and an implicit
     * derivative there is what lets one flatten the body and pay for every arm. The fetch is
     * identical — the depth texture has one storage level and NEAREST filters, so there is no
     * mip for a derivative to select. See AGENTS.md, 2026-08-07.
     */
    float sampled = textureLod(uDepth, uv, 0.0).r;
    if (${glslIsFarDepth('sampled')}) continue;

    vec3 v = viewPosition(uv, sampled) - p;
    float vv = dot(v, v);
    /* Past the radius it is a different surface rather than a neighbour of this one. */
    if (vv > uRadius * uRadius) continue;
    sum += max(0.0, dot(v, n) - AO_BIAS * (-p.z)) / (vv + AO_EPSILON);
  }

  fragColor = clamp(1.0 - 2.0 * uRadius * sum / float(AO_TAPS), 0.0, 1.0);
}
`;

/**
 * One direction of the blur. Run twice, across and then down.
 *
 * Separable, so a four-wide square costs eight taps rather than sixteen, and **depth-aware**,
 * so it does not carry a car's occlusion out onto the wall behind it. That second part is
 * what separates a blur from a smear: an ordinary gaussian over this estimate produces a
 * dark halo around every silhouette, which is more obviously wrong than the noise it was
 * added to remove.
 */
export const AO_BLUR_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uAo;
/** highp for the same reason as the estimate: a lowp sampler may return eight bits, and a
    blur that decides what an edge is from eight-bit depth finds edges that are not there. */
uniform highp sampler2D uDepth;
/** One texel across, in UV, along the axis being blurred. The other component is zero. */
uniform vec2 uStep;
/**
 * Turns a depth sample into view-space metres, as (m22, m32, m23, m33) of the inverse
 * projection. The whole matrix is not needed to answer how far away a pixel is, and the blur
 * asks that question five times per pixel.
 */
uniform vec4 uDepthToViewZ;

out float fragColor;

/**
 * How far apart two pixels may be, as a fraction of their distance from the eye, before they
 * stop being the same surface.
 *
 * Relative rather than absolute, because the same 5 cm step is a cliff on a dashboard and
 * nothing at all on a far wall.
 */
const float AO_BLUR_DEPTH_TOLERANCE = 0.02;

float viewZ(float depth) {
  float ndc = ${glslSceneDepthToNdc('depth')};
  return (uDepthToViewZ.x * ndc + uDepthToViewZ.y) / (uDepthToViewZ.z * ndc + uDepthToViewZ.w);
}

void main() {
  float centre = viewZ(textureLod(uDepth, vUv, 0.0).r);
  float tolerance = AO_BLUR_DEPTH_TOLERANCE * abs(centre) + 1e-4;
  float sum = 0.0;
  float weight = 0.0;
  /*
   * **Eight consecutive pixels: two whole periods of the rotation tile, not one.**
   *
   * One period was the original design and it is a quarter of a denoiser. The estimate is
   * twelve taps of a noisy quantity, and it is only usable because a run of pixels averages
   * the sixteen rotations of the 4x4 tile back into one kernel — but averaging four estimates
   * divides their noise by two, and two of those four are the *same* pixel's neighbours seen
   * from one side. What reached the screen was a soft field with a visible grain in it, and
   * along every silhouette something worse.
   *
   * **The edge is what forces the second period.** The weight below is designed to fall to zero
   * across a depth edge, so a pixel beside a rail keeps only the taps on its own side. With a
   * four-wide window that can be a single tap — one rotation out of sixteen, at the tile's own
   * four-pixel period, running along the edge. That is the dotted line reported along every
   * rail, and no amount of care in the estimate removes it, because the estimate was never
   * meant to stand alone. Eight wide, a pixel hard against an edge still has four consecutive
   * taps on its own side, which is every phase exactly once — the kernel the estimate was
   * designed around, recovered on the one side it can be recovered from.
   *
   * The cost is four more taps an axis on a single-channel target, and what it buys back is the
   * halving of the noise that the four-wide window was already relying on and not getting.
   */
  for (int i = -3; i <= 4; i++) {
    vec2 uv = vUv + uStep * float(i);
    float z = viewZ(textureLod(uDepth, uv, 0.0).r);
    /* One if this neighbour is on the same surface, falling to zero across an edge. */
    float w = max(0.0, 1.0 - abs(z - centre) / tolerance);
    sum += textureLod(uAo, uv, 0.0).r * w;
    weight += w;
  }
  /* An isolated pixel — a thin rail against a far wall — keeps its own estimate rather than
     dividing by nothing. */
  fragColor = weight > 0.0 ? sum / weight : textureLod(uAo, vUv, 0.0).r;
}
`;
