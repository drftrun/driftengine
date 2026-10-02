/**
 * Choosing a backend's quality, asking about the GPU first, and reading what a frame cost.
 *
 * A snippet, not an example: it is typechecked with everything under `examples/` so the manual can
 * quote it, and it is not a page anybody runs. The manual's chapter on backends is built from it.
 */
import { createRenderer, describeGpu } from '@driftengine/core';
import type { RenderBackend, RendererApi } from '@driftengine/core';

// #region profile
/** A quality profile per backend: the function is called once, with the backend that was built. */
export async function rendererFor(canvas: HTMLCanvasElement) {
  return createRenderer(canvas, (backend: RenderBackend) =>
    backend === 'webgpu'
      ? { maxDevicePixelRatio: 2, directionalShadows: true, sceneSamples: 4, bloom: 0.4 }
      : { maxDevicePixelRatio: 1.5, directionalShadows: true },
  );
}
// #endregion

// #region identify
/** Ask what part this is before building, so a known-weak family starts on the lighter profile. */
export async function rendererForThisMachine(canvas: HTMLCanvasElement) {
  const gpu = await describeGpu();
  const heavy = !gpu.weak;
  const created = await createRenderer(canvas, {
    maxDevicePixelRatio: heavy ? 2 : 1.25,
    directionalShadows: true,
    pointShadows: heavy,
  });
  console.info(
    `${created.backend} on ${created.rendererName || 'an unnamed GPU'}: ${created.reason}`,
  );
  return created;
}
// #endregion

// #region budget
/** After `endFrame`: every ceiling the backend imposes, and what this frame asked of it. */
export function reportBudget(renderer: RendererApi): void {
  const budget = renderer.frameBudget;
  if (!budget.dropped) return;
  for (const line of budget.lines) {
    if (line.dropped > 0) {
      console.warn(
        `${line.name}: ${line.used} asked for, ${line.dropped} over the ceiling of ${line.ceiling}`,
      );
    }
  }
}
// #endregion
