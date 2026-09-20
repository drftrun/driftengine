/**
 * What a Gaussian would have to change to make the picture right: the derivatives of the rendered
 * frame with respect to every parameter of every Gaussian.
 *
 * **Analytic, and checked against a central difference.** Every term below is a chain rule through
 * the same projection `rasterise.ts` draws with — the view transform, the perspective Jacobian, the
 * screen covariance, its inverse, the exponent, the alpha, and the compositing — and
 * `gradients.test.ts` compares each against the rasteriser it differentiates, nudged. A gradient
 * that is subtly wrong does not fail: it trains to a slightly wrong cloud, which is why the
 * comparison is the test rather than a measure of how well it fits.
 *
 * **The compositing is walked twice.** Forward, nearest first, to know what each Gaussian
 * contributed and what light was left after it; then backward, furthest first, carrying the colour
 * accumulated behind — because what a Gaussian's alpha is worth depends on everything in front of
 * it and everything behind it at once.
 */
import { exactExp } from '@driftengine/core';

import {
  cameraCentre,
  sh1Basis,
  sh1DirectionGradient,
  splatColour,
  SH1_COEFFICIENTS,
  viewDirection,
} from './harmonics.ts';
import {
  visibleGaussians,
  type GaussianSet,
  type Projected,
  type RasterCamera,
} from './project.ts';
import { screenToParameters } from './projectGradient.ts';
import type { Frame } from './rasterise.ts';

/** Where the gradients go: one entry per parameter of every Gaussian. */
export interface GaussianGradients {
  /** Three per Gaussian. */
  readonly positions: Float64Array;
  readonly scales: Float64Array;
  /** Four per Gaussian, xyzw. */
  readonly rotations: Float64Array;
  readonly colors: Float64Array;
  /** Nine per Gaussian, and left at zero for a cloud with no band to fit. */
  readonly sh1: Float64Array;
  /**
   * The gradients **as the screen sees them**, nine per Gaussian: the two of its centre in pixels,
   * the three of its screen covariance, its opacity, and its resolved colour.
   *
   * Everything else here is a chain rule away from these. They are kept because the tiled device
   * rasteriser computes exactly this much and nothing further — the projection and the band are
   * per-splat work that is not worth a dispatch — so this is the surface
   * `scripts/gpu-parity.mjs` holds the two rasterisers to.
   */
  readonly screen: Float64Array;
  /** One per Gaussian. */
  readonly opacities: Float64Array;
}

export function createGradients(count: number): GaussianGradients {
  return {
    positions: new Float64Array(count * 3),
    scales: new Float64Array(count * 3),
    rotations: new Float64Array(count * 4),
    colors: new Float64Array(count * 3),
    sh1: new Float64Array(count * SH1_COEFFICIENTS),
    screen: new Float64Array(count * SCREEN_GRADIENTS),
    opacities: new Float64Array(count),
  };
}

const FAINT = 1 / 255 / 4;

/** Numbers a Gaussian's screen-space gradient occupies: mean, covariance, opacity, colour. */
export const SCREEN_GRADIENTS = 9;

/** The squared difference between a render and a frame, and the render's own gradient. */
export function imageLoss(rendered: Frame, target: Frame, gradient: Float64Array): number {
  let sum = 0;
  for (let at = 0; at < gradient.length; at += 1) {
    const off = (rendered[at] as number) - (target[at] as number);
    sum += off * off;
    gradient[at] = 2 * off;
  }
  return sum;
}

/**
 * The gradients of a render against `dPixels` — the loss's derivative by each rendered channel,
 * four a pixel — added into `out`. The render is repeated here rather than taken as an argument,
 * because the backward walk needs what each Gaussian contributed on the way.
 */
export function accumulateGradients(
  set: GaussianSet,
  camera: RasterCamera,
  dPixels: Float64Array,
  out: GaussianGradients,
): void {
  const { width, height } = camera;
  const { order, projected } = visibleGaussians(set, camera);
  const pixels = width * height;

  /* Forward: the light left at each pixel after every Gaussian in front of it. */
  const transmittance = new Float64Array(pixels).fill(1);
  for (const at of order) {
    const one = projected[at] as Projected;
    const determinant = one.a * one.d - one.b * one.b;
    const inverse = [one.d / determinant, -one.b / determinant, one.a / determinant];
    const box = boxOf(one, width, height);
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        const dx = x + 0.5 - one.x;
        const dy = y + 0.5 - one.y;
        const power =
          -0.5 *
          ((inverse[0] as number) * dx * dx +
            2 * (inverse[1] as number) * dx * dy +
            (inverse[2] as number) * dy * dy);
        const alpha = (set.opacities[at] as number) * exactExp(power);
        if (alpha < FAINT) continue;
        const pixel = y * width + x;
        transmittance[pixel] = (transmittance[pixel] as number) * (1 - alpha);
      }
    }
  }

  /* Backward: furthest first, carrying what stands behind each Gaussian. */
  const behind = new Float64Array(pixels * 3);
  const behindAlpha = new Float64Array(pixels);
  const light = Float64Array.from(transmittance);
  const eye = new Float64Array(3);
  cameraCentre(camera.worldToCamera, eye);
  const direction = new Float64Array(3);
  const basis = new Float64Array(3);
  const colour = new Float64Array(3);
  const dColour = new Float64Array(3);
  const dDirection = new Float64Array(3);
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const at = order[index] as number;
    const one = projected[at] as Projected;
    const determinant = one.a * one.d - one.b * one.b;
    const inverse = [one.d / determinant, -one.b / determinant, one.a / determinant];
    const box = boxOf(one, width, height);
    const opacity = set.opacities[at] as number;
    const distance = viewDirection(set.positions, at, eye, direction);
    sh1Basis(direction, basis);
    splatColour(set.colors, set.sh1, at, basis, colour);
    dColour.fill(0);
    /* The screen-space gradients this Gaussian gathers over its own pixels. */
    let dMeanX = 0;
    let dMeanY = 0;
    let dA = 0;
    let dB = 0;
    let dD = 0;
    let dOpacity = 0;
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        const dx = x + 0.5 - one.x;
        const dy = y + 0.5 - one.y;
        const power =
          -0.5 *
          ((inverse[0] as number) * dx * dx +
            2 * (inverse[1] as number) * dx * dy +
            (inverse[2] as number) * dy * dy);
        const weight = exactExp(power);
        const alpha = opacity * weight;
        if (alpha < FAINT) continue;
        const pixel = y * width + x;
        /* Undo this Gaussian's own share to recover the light that reached it. */
        const after = light[pixel] as number;
        const before = alpha === 1 ? after : after / (1 - alpha);
        let dAlpha = 0;
        for (let c = 0; c < 3; c += 1) {
          const grad = dPixels[pixel * 4 + c] as number;
          /* What this Gaussian puts on the pixel, and what its alpha takes from behind it. */
          dColour[c] = (dColour[c] as number) + grad * alpha * before;
          dAlpha += grad * before * ((colour[c] as number) - (behind[pixel * 3 + c] as number));
        }
        const gradAlpha = dPixels[pixel * 4 + 3] as number;
        dAlpha += gradAlpha * before * (1 - (behindAlpha[pixel] as number));
        dOpacity += dAlpha * weight;
        /* Through the exponent to the mean and the covariance. */
        const dPower = dAlpha * opacity * weight;
        const gx = (inverse[0] as number) * dx + (inverse[1] as number) * dy;
        const gy = (inverse[1] as number) * dx + (inverse[2] as number) * dy;
        dMeanX += dPower * gx;
        dMeanY += dPower * gy;
        /*
         * The exponent by the inverse covariance, **entry by entry rather than by three numbers**:
         * the off-diagonal is one of a symmetric pair, so it takes half of what a single shared
         * parameter would, and `dB` below is what puts the two halves back together. Written the
         * other way it is a factor of two on every cross term, which is a wrong gradient that
         * still points roughly the right way — so it fits, slightly wrongly, rather than failing.
         */
        const dInverseA = -0.5 * dPower * dx * dx;
        const dInverseB = -0.5 * dPower * dx * dy;
        const dInverseD = -0.5 * dPower * dy * dy;
        /* d(Σ⁻¹)/dΣ for a symmetric 2 × 2, written out. */
        const ia = inverse[0] as number;
        const ib = inverse[1] as number;
        const id = inverse[2] as number;
        dA += -(
          ia * dInverseA * ia +
          ib * dInverseB * ia +
          ia * dInverseB * ib +
          ib * dInverseD * ib
        );
        dB +=
          -(ia * dInverseA * ib + ib * dInverseB * ib + ia * dInverseB * id + ib * dInverseD * id) *
          2;
        dD += -(
          ib * dInverseA * ib +
          id * dInverseB * ib +
          ib * dInverseB * id +
          id * dInverseD * id
        );
        /* And carry this Gaussian into what stands behind the next one. */
        for (let c = 0; c < 3; c += 1) {
          behind[pixel * 3 + c] =
            alpha * (colour[c] as number) + (1 - alpha) * (behind[pixel * 3 + c] as number);
        }
        behindAlpha[pixel] = alpha + (1 - alpha) * (behindAlpha[pixel] as number);
        light[pixel] = before;
      }
    }
    out.opacities[at] = (out.opacities[at] as number) + dOpacity;
    /* What a device's tiled pass answers, before any of the chain rules below it. */
    const screen = at * SCREEN_GRADIENTS;
    out.screen[screen] = (out.screen[screen] as number) + dMeanX;
    out.screen[screen + 1] = (out.screen[screen + 1] as number) + dMeanY;
    out.screen[screen + 2] = (out.screen[screen + 2] as number) + dA;
    out.screen[screen + 3] = (out.screen[screen + 3] as number) + dB;
    out.screen[screen + 4] = (out.screen[screen + 4] as number) + dD;
    out.screen[screen + 5] = (out.screen[screen + 5] as number) + dOpacity;
    for (let c = 0; c < 3; c += 1) {
      out.screen[screen + 6 + c] = (out.screen[screen + 6 + c] as number) + (dColour[c] as number);
    }
    /*
     * The colour this Gaussian showed, back to the terms it was made of. **A channel the shader
     * clamped at zero took no gradient**: it is flat there, so a constant term already below zero
     * is not pushed further down by a frame that wanted it darker still.
     */
    for (let c = 0; c < 3; c += 1) {
      if (!((colour[c] as number) > 0)) continue;
      out.colors[at * 3 + c] = (out.colors[at * 3 + c] as number) + (dColour[c] as number);
      if (set.sh1 === undefined) continue;
      for (let band = 0; band < 3; band += 1) {
        const slot = at * SH1_COEFFICIENTS + band * 3 + c;
        out.sh1[slot] =
          (out.sh1[slot] as number) + (dColour[c] as number) * (basis[band] as number);
      }
    }
    /*
     * And the band is a **second way a position changes the picture**: moving a Gaussian turns the
     * direction it is seen from, which reshades it. Small next to the term that moves it across the
     * frame, and the difference finds it all the same.
     */
    if (set.sh1 !== undefined && distance > 0) {
      sh1DirectionGradient(set.sh1, at, colour, dColour, dDirection);
      let along = 0;
      for (let axis = 0; axis < 3; axis += 1)
        along += (dDirection[axis] as number) * (direction[axis] as number);
      for (let axis = 0; axis < 3; axis += 1) {
        out.positions[at * 3 + axis] =
          (out.positions[at * 3 + axis] as number) +
          ((dDirection[axis] as number) - along * (direction[axis] as number)) / distance;
      }
    }
    /* Through the projection to the Gaussian's own parameters. */
    screenToParameters(set, at, camera, dMeanX, dMeanY, dA, dB, dD, out);
  }
}

function boxOf(
  one: Projected,
  width: number,
  height: number,
): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.max(0, Math.floor(one.x - one.radius)),
    right: Math.min(width - 1, Math.ceil(one.x + one.radius)),
    top: Math.max(0, Math.floor(one.y - one.radius)),
    bottom: Math.min(height - 1, Math.ceil(one.y + one.radius)),
  };
}
