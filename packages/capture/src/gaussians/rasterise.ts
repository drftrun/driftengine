/**
 * A cloud of Gaussians drawn on the CPU: `project.ts`'s ellipses, composited nearest first.
 *
 * **It exists to be differentiated**, which is what separates it from the shader that draws splats
 * in a game. A reference rasteriser is how the gradients in `gradients.ts` are checked — a central
 * difference of this against the analytic answer — and how a fitted cloud is compared with the
 * frames it was fitted to. It is thousands of times slower than the shader, and per-frame rules
 * about allocation do not reach it.
 */
import { exactExp } from '@driftengine/core';

import { cameraCentre, sh1Basis, splatColour, viewDirection } from './harmonics.ts';
import {
  visibleGaussians,
  type GaussianSet,
  type Projected,
  type RasterCamera,
} from './project.ts';

/**
 * A frame this rasteriser writes: **single precision where it stands in for a render target, double
 * where the caller is differentiating through it.** The fitting loop accumulates its loss in double
 * and a frame quantised to single is a floor under every difference taken through one — measured at
 * about a part in five hundred of the slope, against a part in ten million when the frame is double.
 */
export type Frame = Float32Array | Float64Array;

/** Below this the Gaussian contributes nothing worth compositing. */
const FAINT = 1 / 255 / 4;

/**
 * `set` through `camera` into `out`, four floats a pixel: linear colour, premultiplied as it
 * composites, and the alpha the cloud covered the pixel with.
 */
export function rasteriseGaussians(set: GaussianSet, camera: RasterCamera, out: Frame): void {
  const { width, height } = camera;
  out.fill(0);
  const transmittance = new Float64Array(width * height).fill(1);
  const { order, projected } = visibleGaussians(set, camera);
  /* A Gaussian's colour is a function of where it is seen from, so it is resolved once a frame. */
  const eye = new Float64Array(3);
  cameraCentre(camera.worldToCamera, eye);
  const direction = new Float64Array(3);
  const basis = new Float64Array(3);
  const colour = new Float64Array(3);
  for (const at of order) {
    const one = projected[at] as Projected;
    viewDirection(set.positions, at, eye, direction);
    sh1Basis(direction, basis);
    splatColour(set.colors, set.sh1, at, basis, colour);
    const determinant = one.a * one.d - one.b * one.b;
    const inverse = [one.d / determinant, -one.b / determinant, one.a / determinant];
    const left = Math.max(0, Math.floor(one.x - one.radius));
    const right = Math.min(width - 1, Math.ceil(one.x + one.radius));
    const top = Math.max(0, Math.floor(one.y - one.radius));
    const bottom = Math.min(height - 1, Math.ceil(one.y + one.radius));
    const opacity = set.opacities[at] as number;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = x + 0.5 - one.x;
        const dy = y + 0.5 - one.y;
        const power =
          -0.5 *
          ((inverse[0] as number) * dx * dx +
            2 * (inverse[1] as number) * dx * dy +
            (inverse[2] as number) * dy * dy);
        /* The inverse of a positive definite covariance is positive definite, so `power` is at
           most zero and the exponential at most one: there is nothing to guard against here. */
        const alpha = opacity * exactExp(power);
        if (alpha < FAINT) continue;
        const pixel = y * width + x;
        const share = alpha * (transmittance[pixel] as number);
        for (let c = 0; c < 3; c += 1) {
          out[pixel * 4 + c] = (out[pixel * 4 + c] as number) + share * (colour[c] as number);
        }
        out[pixel * 4 + 3] = (out[pixel * 4 + 3] as number) + share;
        transmittance[pixel] = (transmittance[pixel] as number) * (1 - alpha);
      }
    }
  }
}
