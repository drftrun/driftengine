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
 * The estimate. Writes one channel at `AO_STORE`: that is open sky, 0 is fully enclosed, and the
 * second axis of the blur decodes it.
 *
 * **Horizons, not neighbours: ground-truth ambient occlusion (Jimenez et al. 2016).** Each pixel
 * walks two lines across the screen, both ways, and keeps the highest thing it can see along each
 * half: the horizon. The sky left between the two horizons of a line, weighted by the cosine to the
 * surface's own normal, is that line's visibility in closed form, and two lines a pixel with the
 * rotation tile below turning them is the hemisphere. It replaced a sum over twelve neighbours that
 * counted anything within the radius as a blocker, however thin: cloth hanging a hand in front of a
 * column darkened the column behind it, which read as a halo round every curtain in a courtyard.
 *
 * **What stops the halo is two rules about the horizon**, both the paper's. A sample fades out of
 * the horizon as it approaches the radius, so a far wall does not shade a floor; and once the walk
 * has passed the highest sample, the horizon sinks back toward what it sees next, so a thin thing
 * in front raises it only while the walk is behind that thing. What that gives up is the shade under
 * a thick object seen edge on, which reads as a thin one; the thickness is a constant because depth
 * alone cannot say how deep anything is.
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
/**
 * Where occlusion fades out: whole up to x metres from the eye, gone y metres past it, and no fade
 * where x is below zero. See occlusionFade.ts.
 */
uniform vec2 uFade;

out float fragColor;

/** Lines across the screen a pixel walks, each both ways. Fixed, so the cost is fixed. */
const int AO_SLICES = 2;
/** Depth samples each way along a line: two lines, two ways, six steps is 24 a pixel. */
const int AO_STEPS = 6;
/**
 * How far the horizon sinks back toward each later sample once the walk has passed the highest one.
 *
 * The paper's thickness heuristic. At zero anything within the radius shades for good, which is the
 * halo; at one a horizon lasts one sample and a real corner loses its shade. A fifth keeps a corner,
 * whose samples keep rising, and lets a curtain's shade drop within the few samples past its edge.
 */
const float AO_THIN = 0.2;
/**
 * How far the sampling may reach across the frame, whatever the depth says.
 *
 * A surface almost touching the near plane projects half a metre onto most of the screen,
 * and without a ceiling those pixels each read the whole frame's depth: the effect stops
 * being contact shading and becomes an expensive wide darkening. 6% of the frame.
 */
const float AO_MAX_REACH_UV = 0.06;
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
/** Stored at half, so a turn the closed form credits past one reaches the blur whole. See AO_STORE in the module. */
const float AO_STORE = 0.5;

/** View-space position of whatever is at this pixel, from its depth alone. */
vec3 viewPosition(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, ${glslSceneDepthToNdc('depth')}, 1.0);
  vec4 view = uInvProjection * clip;
  return view.xyz / view.w;
}

/**
 * The cosine-weighted sky between two horizon angles h0 < 0 < h1, measured from the eye, for a
 * normal at the angle given in the same plane: the paper's closed form. 1 for an open plane facing
 * the eye.
 */
float gtaoArc(float h0, float h1, float normal) {
  float c = cos(normal);
  float s2 = 2.0 * sin(normal);
  return 0.25 * (-cos(2.0 * h0 - normal) + c + h0 * s2) + 0.25 * (-cos(2.0 * h1 - normal) + c + h1 * s2);
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
  /* How far past the caller's fade this pixel is, and open with no walk where it is all the way. */
  float faded = uFade.x < 0.0 ? 0.0 : clamp((length(p) - uFade.x) / max(uFade.y, 1e-4), 0.0, 1.0);
  if (faded >= 1.0) {
    fragColor = AO_STORE;
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
   * screen-space winding and the handedness of the projection, and a normal pointing away from the
   * camera puts every horizon behind the surface. In view space the eye is the origin, so a normal
   * facing it satisfies n·p < 0.
   */
  if (dot(n, p) > 0.0) n = -n;
  vec3 toEye = normalize(-p);

  /*
   * The radius as a fraction of the frame. A metre subtends less of the screen the further away it
   * is, which is the entire reason this is computed per pixel rather than handed in.
   */
  vec2 reach = min(
    uRadius * uProjScale * 0.5 / max(-p.z, 1e-3),
    vec2(AO_MAX_REACH_UV)
  );

  /*
   * A rotation that repeats every four pixels: sixteen turns laid out over a 4x4 tile, spanning the
   * quarter turn between one line and the next, so the eight-wide blur that follows averages every
   * turn of both lines. The first step's distance is staggered by the same tile, so neighbouring
   * pixels do not all sample the same rings either.
   */
  float tile = mod(gl_FragCoord.x, 4.0) + 4.0 * mod(gl_FragCoord.y, 4.0);
  float turn = tile * (1.5707963 / 16.0);
  float stagger = fract(tile * 0.618034);
  /* One output pixel along each axis, in UV. */
  vec2 pixel = vec2(length(stepX), length(stepY));

  float visible = 0.0;
  for (int slice = 0; slice < AO_SLICES; slice++) {
    float angle = turn + float(slice) * (3.1415927 / float(AO_SLICES));
    /*
     * **Even in pixels, not in UV.** A UV step across a wide frame is longer than one down it, so
     * turns spread evenly in UV crowd toward the horizontal once they reach the screen, and on a
     * floor the horizontal lines are the ones that see least of its normal: every flat floor and
     * ceiling came back at 0.82 open, measured, where the construction gives 0.97. A pixel is as
     * wide as it is tall in view space, so a direction even in pixels is even in the world. It is
     * scaled here into UV, and the reach is taken down the frame, whose UV is the same pixels.
     */
    vec2 screen = vec2(cos(angle) * pixel.x / pixel.y, sin(angle));
    /*
     * The line in view space, taken through the same reconstruction the samples use: a step along
     * the screen at this pixel's own depth, so the samples lie in the plane the arc is measured in
     * whatever the frame's aspect and whichever way a backend's clip space counts up.
     */
    vec3 along = normalize(viewPosition(vUv + screen * 1e-3, depth) - p);
    vec3 across = normalize(along - toEye * dot(along, toEye));
    vec3 axis = cross(across, toEye);
    /* The normal projected into the line's plane, and its angle from the eye toward +across. */
    vec3 projected = n - axis * dot(n, axis);
    float projectedLength = length(projected);
    if (projectedLength < 1e-4) continue;
    float normalAngle = atan(dot(projected, across), dot(projected, toEye));

    /* The highest cosine seen each way. */
    float horizon0 = -1.0;
    float horizon1 = -1.0;
    for (int k = 0; k < AO_STEPS; k++) {
      float t = (float(k) + stagger) / float(AO_STEPS);
      /* Squared, so the steps crowd the pixel, where contact shade lives. */
      vec2 stride = screen * reach.y * (t * t + 0.5 / float(AO_STEPS * AO_STEPS));
      for (int side = 0; side < 2; side++) {
        vec2 uv = side == 0 ? vUv - stride : vUv + stride;
        /*
         * textureLod, not texture, and it is the rule rather than a preference: this sits inside a
         * loop whose iterations a compiler cannot prove uniform. The depth texture has one level and
         * NEAREST filters, so the fetch is identical. See AGENTS.md, 2026-08-07.
         */
        float sampled = textureLod(uDepth, uv, 0.0).r;
        if (${glslIsFarDepth('sampled')}) continue;
        vec3 v = viewPosition(uv, sampled) - p;
        float distance2 = dot(v, v);
        if (distance2 < 1e-8) continue;
        float cosine = dot(v, toEye) * inversesqrt(distance2);
        /* Faded to nothing at the radius: a far wall is not an occluder of this surface. */
        float fade = clamp(1.0 - distance2 / (uRadius * uRadius), 0.0, 1.0);
        cosine = mix(-1.0, cosine, fade);
        if (side == 0) horizon0 = cosine > horizon0 ? cosine : mix(horizon0, cosine, AO_THIN);
        else horizon1 = cosine > horizon1 ? cosine : mix(horizon1, cosine, AO_THIN);
      }
    }
    /* Angles from the eye, negative toward -across, and never below the surface's own tangent. */
    float h0 = max(-acos(clamp(horizon0, -1.0, 1.0)), normalAngle - 1.5707963);
    float h1 = min(acos(clamp(horizon1, -1.0, 1.0)), normalAngle + 1.5707963);
    visible += projectedLength * gtaoArc(h0, h1, normalAngle);
  }

  fragColor = clamp(mix(visible / float(AO_SLICES), 1.0, faded) * AO_STORE, 0.0, 1.0);
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
/** One across, carrying the estimate's AO_STORE scale; its inverse down, decoding it. */
uniform float uAoScale;

out float fragColor;

/**
 * How far a neighbour may sit from the depth this pixel's own surface predicts there, as a
 * fraction of that depth, before it stops being the same surface.
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
  float depth = textureLod(uDepth, vUv, 0.0).r;
  float own = textureLod(uAo, vUv, 0.0).r;
  /* Nothing to average over the sky, and no surface to predict one from. */
  if (${glslIsFarDepth('depth')}) {
    fragColor = min(own * uAoScale, 1.0);
    return;
  }
  float centre = viewZ(depth);
  /* Each tap is compared with this pixel's plane, not with its depth. See blurWeight in the module. */
  float inverse = 1.0 / centre;
  float stepAfter = 1.0 / viewZ(textureLod(uDepth, vUv + uStep, 0.0).r) - inverse;
  float stepBefore = inverse - 1.0 / viewZ(textureLod(uDepth, vUv - uStep, 0.0).r);
  float slope = abs(stepAfter) < abs(stepBefore) ? stepAfter : stepBefore;
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
    /* One if this neighbour is on this pixel's surface, falling to zero as it leaves it. */
    float w = max(0.0, 1.0 - abs(z * (inverse + slope * float(i)) - 1.0) / AO_BLUR_DEPTH_TOLERANCE);
    sum += textureLod(uAo, uv, 0.0).r * w;
    weight += w;
  }
  /* An isolated pixel — a thin rail against a far wall — keeps its own estimate rather than
     dividing by nothing. */
  float blurred = weight > 0.0 ? sum / weight : own;
  fragColor = min(blurred * uAoScale, 1.0);
}
`;

/**
 * The estimate's closed form, written out once more so a test can pin it to hand-derived values:
 * the cosine-weighted sky between horizon angles `h0 < 0 < h1` for a normal at `normal`, all in
 * radians from the eye within one line's plane.
 */
export function gtaoArc(h0: number, h1: number, normal: number): number {
  const c = Math.cos(normal);
  const s2 = 2 * Math.sin(normal);
  return (
    0.25 * (-Math.cos(2 * h0 - normal) + c + h0 * s2) +
    0.25 * (-Math.cos(2 * h1 - normal) + c + h1 * s2)
  );
}

/** One step of a horizon: up to a higher sample, or a fifth of the way down toward a lower one. */
export function nextHorizon(horizon: number, cosine: number): number {
  return cosine > horizon ? cosine : horizon + (cosine - horizon) * AO_THIN;
}

/** The shader's thickness heuristic. See `AO_THIN` inside `AO_FRAG`. */
export const AO_THIN = 0.2;

/**
 * What the estimate is multiplied by before it is stored, and divided by once the blur is done.
 *
 * **Half, because an unblurred estimate is allowed past one.** A pixel's two lines see a plane
 * turned away from the eye from two directions, and the closed form credits one of them more than
 * the whole sky and the other less: it is the average over every turn that is exactly one, and the
 * average is what the blur is for. Stored as it came, an eight-bit target clipped every turn above
 * one before the blur could average it, and every surface seen edge on came back a few percent
 * shaded with nothing on it. A line reaches π/2 at most, so half fits the whole range.
 *
 * What it gives up is one bit of the intermediate: steps of 1/128 rather than 1/256 until the
 * second axis decodes, which the eight taps a pixel averages carry below what a frame can show.
 */
export const AO_STORE = 0.5;

/** How far a neighbour may sit from this pixel's surface, as a fraction of its distance. */
export const AO_BLUR_DEPTH_TOLERANCE = 0.02;

/**
 * The blur's weight for a neighbour `offset` pixels along the axis, from view depths: this pixel's
 * own, the two either side of it, and the neighbour's. The shader's lines written out again.
 *
 * **The neighbour is compared with this pixel's plane, not with this pixel's depth.** Comparing
 * depths refused every neighbour of a surface seen edge on: a floor forty metres out changes its
 * depth by four percent a row, twice the tolerance, so the pass down the frame kept the centre alone
 * and left the rotation tile's rows standing — four-pixel stripes across every ramp and far floor,
 * reported as strips on a track. On a plane 1/z is affine in the screen, so one step of it predicts
 * the plane's depth at every tap exactly, and a tap is refused only for leaving the plane.
 *
 * The step is taken from whichever neighbour is closer to the centre in 1/z. At a silhouette that is
 * the one on this pixel's own side, so the far surface cannot bend the prediction toward it; on a
 * plane the two agree to a quantisation step, which moves a weight by nothing a frame shows. What it
 * gives up is a crease: past the fold between a floor and a wall the prediction runs on along the
 * floor, so the wall's taps fade out over the tolerance rather than being kept.
 *
 * **Written here rather than in the shader**, because a comment inside the GLSL is part of the string
 * a consumer ships.
 */
export function blurWeight(
  centre: number,
  before: number,
  after: number,
  neighbour: number,
  offset: number,
): number {
  const inverse = 1 / centre;
  const stepAfter = 1 / after - inverse;
  const stepBefore = inverse - 1 / before;
  const slope = Math.abs(stepAfter) < Math.abs(stepBefore) ? stepAfter : stepBefore;
  return Math.max(
    0,
    1 - Math.abs(neighbour * (inverse + slope * offset) - 1) / AO_BLUR_DEPTH_TOLERANCE,
  );
}
