/**
 * Rebuilding a pixel's surface from the triangle it recorded.
 *
 * **This is the only part of the shading that differs between the two pipelines.** The forward
 * path gets its surface attributes from the rasteriser's varyings; a visibility buffer has none,
 * so every attribute has to be interpolated here from the three vertices of the triangle the pixel
 * wrote down. The lighting itself is not this module's business and must not become a second copy
 * of the forward path's — a pair of lighting expressions drifts, and the parity gate is then the
 * only thing that notices.
 *
 * **Perspective correction is not optional and screen-space barycentrics are not enough.** A
 * triangle seen at an angle covers pixels whose interpolated attributes are *not* linear in screen
 * position: the correct weights are the screen-space ones divided by each vertex's clip `w` and
 * renormalised. Skipping it is the classic affine-texturing look, and on a floor it is unmistakable.
 *
 * **The gradients are derived analytically, and this is the subtle one.** A fragment shader gets
 * `dFdx` and `dFdy` for free because it runs in quads of four pixels; a compute invocation has no
 * neighbours and no derivative at all. A texture read without one either picks a fixed level —
 * which is a blurry picture everywhere, or an aliased one — or picks level zero, which sparkles.
 * So the rate of change of every barycentric with respect to screen x and y is computed from the
 * triangle's own edge functions, and an attribute's gradient is the same weighted sum its value
 * is. `attributeGradients` is that, and `barycentricGradients` is what it rests on.
 *
 * Everything here takes plain numbers and fills arrays the caller owns, because the shader does the
 * same arithmetic per pixel and the two have to be comparable term by term.
 */

/** Screen position and reciprocal clip w of one vertex: x, y, 1/w. */
export const SCREEN_VERTEX_FLOATS = 3;

/**
 * Project one clip-space vertex into pixel coordinates.
 *
 * Fills `x, y, 1/w`. Answers **false behind the eye**, where the division has no meaning: a
 * visibility buffer cannot record such a pixel in the first place — the rasteriser clipped the
 * triangle before it was drawn — so reaching this with `w <= 0` means the identifier and the
 * geometry have gone out of step, and a silent NaN would shade a plausible-looking wrong surface.
 */
export function screenVertex(
  clipX: number,
  clipY: number,
  clipW: number,
  width: number,
  height: number,
  out: Float32Array,
  at: number,
): boolean {
  if (!(clipW > 1e-9)) return false;
  const inverse = 1 / clipW;
  out[at] = (clipX * inverse * 0.5 + 0.5) * width;
  out[at + 1] = (clipY * inverse * 0.5 + 0.5) * height;
  out[at + 2] = inverse;
  return true;
}

/** Twice the signed area of the screen triangle. Zero where it is degenerate. */
export function screenArea(screen: Float32Array): number {
  const x0 = screen[0] as number;
  const y0 = screen[1] as number;
  const x1 = screen[3] as number;
  const y1 = screen[4] as number;
  const x2 = screen[6] as number;
  const y2 = screen[7] as number;
  return (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
}

/**
 * The screen-space barycentric weights of a point, before perspective correction.
 *
 * Answers false for a degenerate triangle — one whose three screen positions are collinear, which
 * covers no pixel and whose weights are a division by zero. A caller that reaches this has a
 * visibility identifier for a triangle the rasteriser never drew.
 *
 * **A point outside the triangle gets a negative weight rather than a clamp.** Clamping is how a
 * pixel on the far side of an edge ends up shaded as though it were on the triangle, which along a
 * silhouette is a fringe of the wrong material.
 */
export function screenBarycentrics(
  screen: Float32Array,
  x: number,
  y: number,
  out: Float32Array,
): boolean {
  const area = screenArea(screen);
  if (Math.abs(area) < 1e-12) return false;
  const x0 = screen[0] as number;
  const y0 = screen[1] as number;
  const x1 = screen[3] as number;
  const y1 = screen[4] as number;
  const x2 = screen[6] as number;
  const y2 = screen[7] as number;
  const inverse = 1 / area;
  out[1] = ((x - x0) * (y2 - y0) - (x2 - x0) * (y - y0)) * inverse;
  out[2] = ((x1 - x0) * (y - y0) - (x - x0) * (y1 - y0)) * inverse;
  out[0] = 1 - out[1] - out[2];
  return true;
}

/**
 * The perspective-correct weights, from the screen-space ones and the vertices' reciprocal `w`.
 *
 * Each screen weight is scaled by its vertex's `1/w` and the three renormalised. At an orthographic
 * projection every `1/w` is equal and this is the identity, which is why the affine version looks
 * right on a test quad facing the camera and wrong on the floor beneath it.
 */
export function perspectiveBarycentrics(
  screen: Float32Array,
  lambda: Float32Array,
  out: Float32Array,
): boolean {
  const w0 = (lambda[0] as number) * (screen[2] as number);
  const w1 = (lambda[1] as number) * (screen[5] as number);
  const w2 = (lambda[2] as number) * (screen[8] as number);
  const sum = w0 + w1 + w2;
  if (Math.abs(sum) < 1e-20) return false;
  const inverse = 1 / sum;
  out[0] = w0 * inverse;
  out[1] = w1 * inverse;
  out[2] = w2 * inverse;
  return true;
}

/**
 * How each perspective-correct weight changes with screen x and y, at one pixel.
 *
 * Fills six numbers: `d0/dx, d1/dx, d2/dx, d0/dy, d1/dy, d2/dy`.
 *
 * **Derived rather than differenced.** The screen weights are linear in `x` and `y`, so their
 * gradients are constants of the triangle; the perspective-correct ones are a ratio of two linear
 * functions, and the quotient rule gives the rest. What this buys over a finite difference is that
 * it is exact at the pixel rather than an average over one, and that it costs no neighbours — a
 * compute invocation has none.
 */
export function barycentricGradients(
  screen: Float32Array,
  lambda: Float32Array,
  out: Float32Array,
): boolean {
  const area = screenArea(screen);
  if (Math.abs(area) < 1e-12) return false;
  const inverse = 1 / area;
  const x0 = screen[0] as number;
  const y0 = screen[1] as number;
  const x1 = screen[3] as number;
  const y1 = screen[4] as number;
  const x2 = screen[6] as number;
  const y2 = screen[7] as number;

  /* The screen weights' own gradients, which are constant over the triangle. */
  const d1dx = (y2 - y0) * inverse;
  const d1dy = (x0 - x2) * inverse;
  const d2dx = (y0 - y1) * inverse;
  const d2dy = (x1 - x0) * inverse;
  const d0dx = -d1dx - d2dx;
  const d0dy = -d1dy - d2dy;

  const iw0 = screen[2] as number;
  const iw1 = screen[5] as number;
  const iw2 = screen[8] as number;
  const n0 = (lambda[0] as number) * iw0;
  const n1 = (lambda[1] as number) * iw1;
  const n2 = (lambda[2] as number) * iw2;
  const sum = n0 + n1 + n2;
  if (Math.abs(sum) < 1e-20) return false;
  const inverseSum = 1 / sum;

  /* The denominator's own gradient: the same weighted sum of the reciprocal w values. */
  const dSumDx = d0dx * iw0 + d1dx * iw1 + d2dx * iw2;
  const dSumDy = d0dy * iw0 + d1dy * iw1 + d2dy * iw2;

  /* Quotient rule, per weight, with the shared denominator factored out. */
  out[0] = (d0dx * iw0 - n0 * inverseSum * dSumDx) * inverseSum;
  out[1] = (d1dx * iw1 - n1 * inverseSum * dSumDx) * inverseSum;
  out[2] = (d2dx * iw2 - n2 * inverseSum * dSumDx) * inverseSum;
  out[3] = (d0dy * iw0 - n0 * inverseSum * dSumDy) * inverseSum;
  out[4] = (d1dy * iw1 - n1 * inverseSum * dSumDy) * inverseSum;
  out[5] = (d2dy * iw2 - n2 * inverseSum * dSumDy) * inverseSum;
  return true;
}

/** One attribute interpolated by the weights already computed. */
export function interpolate(a0: number, a1: number, a2: number, weights: Float32Array): number {
  return a0 * (weights[0] as number) + a1 * (weights[1] as number) + a2 * (weights[2] as number);
}

/**
 * One attribute's rate of change with screen x and y, from the weight gradients.
 *
 * An attribute is a weighted sum of three constants, so its gradient is the same sum of the
 * weights' gradients. This is what a texture fetch's level of detail is computed from.
 */
export function attributeGradients(
  a0: number,
  a1: number,
  a2: number,
  gradients: Float32Array,
): { dx: number; dy: number } {
  return {
    dx:
      a0 * (gradients[0] as number) + a1 * (gradients[1] as number) + a2 * (gradients[2] as number),
    dy:
      a0 * (gradients[3] as number) + a1 * (gradients[4] as number) + a2 * (gradients[5] as number),
  };
}

/**
 * Which pixel a shading invocation is responsible for.
 *
 * A group covers `BIN_GROUP_SIZE` entries of one material's slice; an invocation past the end of
 * the slice has no pixel, which is the ordinary case because the slice is not a multiple of the
 * group size. Answers -1 there rather than the last pixel of the bin, which would shade it once
 * per spare lane.
 */
export function binPixel(
  pixels: Uint32Array,
  offset: number,
  count: number,
  invocation: number,
): number {
  if (invocation < 0 || invocation >= count) return -1;
  return (pixels[offset + invocation] as number) ?? -1;
}
