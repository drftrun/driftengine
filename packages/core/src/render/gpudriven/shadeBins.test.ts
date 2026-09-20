import { expect, test } from 'vitest';

import {
  SCREEN_VERTEX_FLOATS,
  attributeGradients,
  barycentricGradients,
  binPixel,
  interpolate,
  perspectiveBarycentrics,
  screenArea,
  screenBarycentrics,
  screenVertex,
} from './shadeBins.ts';

const WIDTH = 256;
const HEIGHT = 256;

/** A reversed-Z perspective, the convention `depthConvention.ts` ships. */
function viewProj(): Float32Array {
  const near = 0.1;
  const far = 100;
  const f = 1 / Math.tan(Math.PI / 4 / 2);
  const m = new Float32Array(16);
  m[0] = f;
  m[5] = f;
  m[10] = near / (far - near);
  m[11] = -1;
  m[14] = (far * near) / (far - near);
  return m;
}

/** World point through a matrix, as clip x, y, w. */
function toClip(m: Float32Array, x: number, y: number, z: number) {
  return {
    x: (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
    y: (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
    w: (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number),
  };
}

/**
 * A triangle lying on the floor and running away from the camera, which is where perspective
 * correction is unmistakable and an affine interpolation is plainly wrong.
 */
function floorTriangle() {
  const m = viewProj();
  /*
   * **Chosen so that all three corners land on the screen**, which the first version of this test
   * did not do: at a 45 degree field of view a point two metres ahead is outside the frustum past
   * about 0.83 metres across, so a three-metre-wide strip projected to screen x of -335 and every
   * sample taken inside it was outside the triangle. The reconstruction then answered with
   * negative weights, the rebuilt point landed behind the eye, and the failure read as the
   * projection being wrong rather than the fixture.
   *
   * **And no two of them share a depth or a screen row**, which the second version did: with the
   * near edge level and at one depth, the denominator of the perspective correction has a gradient
   * of exactly zero along x, so the quotient rule's whole correction term vanishes there and every
   * perturbation of the three x gradients survived the file. A fixture with a symmetry in it tests
   * less than it looks like it does.
   */
  const world: [number, number, number][] = [
    [-0.55, -0.3, -2],
    [0.62, -0.18, -3.1],
    [0.1, -0.34, -30],
  ];
  const screen = new Float32Array(3 * SCREEN_VERTEX_FLOATS);
  for (let i = 0; i < 3; i += 1) {
    const [x, y, z] = world[i] as [number, number, number];
    const clip = toClip(m, x, y, z);
    expect(
      screenVertex(clip.x, clip.y, clip.w, WIDTH, HEIGHT, screen, i * SCREEN_VERTEX_FLOATS),
    ).toBe(true);
  }
  return { screen, world };
}

/**
 * A point inside the screen triangle, named by the weights it is meant to have.
 *
 * Sampling by hand is what put the first version of this test outside its own triangle. Named this
 * way a sample cannot be outside: the three weights are positive and sum to one, so the point is
 * in the interior by construction, and the test still learns nothing about the weights from it
 * because it is the *screen* combination and the weights under test are the perspective-correct
 * ones.
 */
function inside(screen: Float32Array, a: number, b: number, c: number): [number, number] {
  const sum = a + b + c;
  const wa = a / sum;
  const wb = b / sum;
  const wc = c / sum;
  return [
    (screen[0] as number) * wa + (screen[3] as number) * wb + (screen[6] as number) * wc,
    (screen[1] as number) * wa + (screen[4] as number) * wb + (screen[7] as number) * wc,
  ];
}

/** Both barycentric steps at one pixel, for a triangle that covers it. */
function weightsAt(screen: Float32Array, x: number, y: number) {
  const lambda = new Float32Array(3);
  const corrected = new Float32Array(3);
  expect(screenBarycentrics(screen, x, y, lambda)).toBe(true);
  expect(perspectiveBarycentrics(screen, lambda, corrected)).toBe(true);
  return { lambda, corrected };
}

test('a vertex has all of its own weight and none of the others', () => {
  const { screen } = floorTriangle();
  for (let corner = 0; corner < 3; corner += 1) {
    const { corrected } = weightsAt(
      screen,
      screen[corner * SCREEN_VERTEX_FLOATS] as number,
      screen[corner * SCREEN_VERTEX_FLOATS + 1] as number,
    );
    for (let i = 0; i < 3; i += 1) {
      expect(corrected[i] as number).toBeCloseTo(i === corner ? 1 : 0, 5);
    }
  }
});

test('the three weights sum to one wherever they are taken', () => {
  const { screen } = floorTriangle();
  for (const [x, y] of [
    inside(screen, 1, 1, 1),
    inside(screen, 5, 1, 2),
    inside(screen, 1, 2, 9),
  ]) {
    const { corrected } = weightsAt(screen, x as number, y as number);
    expect(
      (corrected[0] as number) + (corrected[1] as number) + (corrected[2] as number),
    ).toBeCloseTo(1, 6);
  }
});

test('BARYCENTRICS REBUILD THE WORLD POSITION THE RASTERISER WOULD HAVE INTERPOLATED', () => {
  /*
   * The check that makes the whole path honest: take a pixel, rebuild the weights from the
   * triangle alone, interpolate the three world positions with them, and project the result back.
   * It must land on the pixel it started from.
   */
  const { screen, world } = floorTriangle();
  const m = viewProj();
  for (const [x, y] of [
    inside(screen, 1, 1, 1),
    inside(screen, 3, 1, 1),
    inside(screen, 1, 3, 2),
    inside(screen, 1, 1, 6),
  ]) {
    const { corrected } = weightsAt(screen, x as number, y as number);
    const wx = interpolate(world[0]![0], world[1]![0], world[2]![0], corrected);
    const wy = interpolate(world[0]![1], world[1]![1], world[2]![1], corrected);
    const wz = interpolate(world[0]![2], world[1]![2], world[2]![2], corrected);
    const clip = toClip(m, wx, wy, wz);
    const back = new Float32Array(SCREEN_VERTEX_FLOATS);
    screenVertex(clip.x, clip.y, clip.w, WIDTH, HEIGHT, back, 0);
    expect(back[0] as number).toBeCloseTo(x as number, 3);
    expect(back[1] as number).toBeCloseTo(y as number, 3);
  }
});

test('AND THE AFFINE WEIGHTS DO NOT, which is what perspective correction is for', () => {
  /* The same pixel with the screen-space weights used directly lands somewhere else entirely —
     several pixels away on a triangle this foreshortened, which is the affine-texturing look. */
  const { screen, world } = floorTriangle();
  const m = viewProj();
  const [ax, ay] = inside(screen, 1, 1, 4);
  const { lambda } = weightsAt(screen, ax, ay);
  const wx = interpolate(world[0]![0], world[1]![0], world[2]![0], lambda);
  const wy = interpolate(world[0]![1], world[1]![1], world[2]![1], lambda);
  const wz = interpolate(world[0]![2], world[1]![2], world[2]![2], lambda);
  const clip = toClip(m, wx, wy, wz);
  const back = new Float32Array(SCREEN_VERTEX_FLOATS);
  screenVertex(clip.x, clip.y, clip.w, WIDTH, HEIGHT, back, 0);
  expect(Math.abs((back[1] as number) - ay)).toBeGreaterThan(3);
});

test('THE GRADIENTS ARE ANALYTIC AND AGREE WITH A FINITE DIFFERENCE OF THE SAME INTERPOLATION', () => {
  /*
   * **This is the case the plan calls the subtle one.** A fragment shader is handed `dFdx` and
   * `dFdy` because it runs in quads; a compute invocation has no neighbours and no derivative, so
   * a texture fetch without one is either a fixed level — blurry everywhere — or level zero, which
   * sparkles. The claim is that the derived gradient equals what differencing the interpolation
   * would have given, so the level of detail is the same one the forward path chooses.
   */
  const { screen } = floorTriangle();
  /* **All three distinct and none of them zero.** The first version used `[0, 1, 7]`, and a zero
     at the first vertex multiplies that weight's gradient away — so the term for weight zero was
     never read and a perturbation of it survived the whole file. */
  const attribute: [number, number, number] = [2, -3, 7];
  /*
   * **The comparison is relative, and the reason is float32 rather than the step.** A central
   * difference errs as the square of the step, so a fifth of the step should have been
   * twenty-five times closer — it was 6.0e-6 against 8.4e-6, barely moved. The residual is not
   * truncation: the weights are stored in `Float32Array` because the shader's are, so differencing
   * two of them at a separation of 0.02 pixels divides a rounding of about 1e-8 by 0.02 and lands
   * at a few parts in a million. The derivation is exact; what is being compared against is not.
   * A relative bound of a fifth of a percent is far tighter than any gradient error that would
   * choose a different mip level, and every perturbation of the six terms fails it.
   */
  const step = 0.01;
  const close = (derived: number, differenced: number) => {
    expect(Math.abs(derived - differenced) / Math.max(1e-9, Math.abs(differenced))).toBeLessThan(
      2e-3,
    );
  };
  for (const [x, y] of [
    inside(screen, 2, 2, 1),
    inside(screen, 3, 1, 2),
    inside(screen, 1, 1, 4),
  ]) {
    const { lambda, corrected } = weightsAt(screen, x as number, y as number);
    const gradients = new Float32Array(6);
    expect(barycentricGradients(screen, lambda, gradients)).toBe(true);
    const derived = attributeGradients(attribute[0], attribute[1], attribute[2], gradients);

    const at = (px: number, py: number) => {
      const { corrected: w } = weightsAt(screen, px, py);
      return interpolate(attribute[0], attribute[1], attribute[2], w);
    };
    const differenceX =
      (at((x as number) + step, y as number) - at((x as number) - step, y as number)) / (2 * step);
    const differenceY =
      (at(x as number, (y as number) + step) - at(x as number, (y as number) - step)) / (2 * step);

    close(derived.dx, differenceX);
    close(derived.dy, differenceY);
    /* And the value itself is the ordinary weighted sum, so the two agree about where they are. */
    expect(interpolate(attribute[0], attribute[1], attribute[2], corrected)).toBeCloseTo(
      at(x as number, y as number),
      6,
    );
  }
});

test('A PER-TRIANGLE GRADIENT CANNOT DO THIS, because the rate changes across the triangle', () => {
  /*
   * The far end of a foreshortened triangle covers far more surface per pixel than the near end.
   * A single gradient for the whole triangle — which is what an affine derivation gives — is right
   * at one end and wrong at the other, and wrong means the wrong mip level: blurry at the near end
   * or aliased at the far one.
   */
  const { screen } = floorTriangle();
  const attribute: [number, number, number] = [1, 2, 9];
  const gradients = new Float32Array(6);
  const [nx, ny] = inside(screen, 10, 10, 1);
  const near = weightsAt(screen, nx, ny);
  barycentricGradients(screen, near.lambda, gradients);
  const atNear = Math.abs(
    attributeGradients(attribute[0], attribute[1], attribute[2], gradients).dy,
  );
  const [fx, fy] = inside(screen, 1, 1, 40);
  const far = weightsAt(screen, fx, fy);
  barycentricGradients(screen, far.lambda, gradients);
  const atFar = Math.abs(
    attributeGradients(attribute[0], attribute[1], attribute[2], gradients).dy,
  );
  expect(atFar / atNear).toBeGreaterThan(4);
});

test('a degenerate triangle is refused rather than dividing by its own area', () => {
  const screen = new Float32Array([0, 0, 1, 10, 10, 1, 20, 20, 1]);
  expect(screenArea(screen)).toBeCloseTo(0, 9);
  expect(screenBarycentrics(screen, 5, 5, new Float32Array(3))).toBe(false);
  expect(barycentricGradients(screen, new Float32Array([1, 0, 0]), new Float32Array(6))).toBe(
    false,
  );
});

test('A POINT OUTSIDE THE TRIANGLE GETS A NEGATIVE WEIGHT, not a clamped one', () => {
  /* Clamping is how a pixel on the far side of an edge shades as though it were on the triangle,
     which along a silhouette is a fringe of the wrong material. */
  const { screen } = floorTriangle();
  const lambda = new Float32Array(3);
  expect(screenBarycentrics(screen, 5, 250, lambda)).toBe(true);
  /* Far outside on both axes, so this cannot be a rounding question. */
  expect(Math.min(lambda[0] as number, lambda[1] as number, lambda[2] as number)).toBeLessThan(0);
});

test('a vertex behind the eye is refused, because its projection has no meaning', () => {
  const out = new Float32Array(SCREEN_VERTEX_FLOATS);
  expect(screenVertex(1, 1, 0, WIDTH, HEIGHT, out, 0)).toBe(false);
  expect(screenVertex(1, 1, -2, WIDTH, HEIGHT, out, 0)).toBe(false);
});

test('an invocation past the end of its bin has no pixel, not the last one again', () => {
  const pixels = new Uint32Array([9, 4, 7, 100, 200]);
  expect(binPixel(pixels, 1, 3, 0)).toBe(4);
  expect(binPixel(pixels, 1, 3, 2)).toBe(100);
  expect(binPixel(pixels, 1, 3, 3)).toBe(-1);
  expect(binPixel(pixels, 1, 3, 63)).toBe(-1);
});
