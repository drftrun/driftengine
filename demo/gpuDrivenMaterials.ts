/**
 * Sixteen materials, sixteen dispatches.
 *
 * **The scene the binning exists for.** A visibility buffer records which triangle covered each
 * pixel and nothing about how it looks, so the pixels have to be counted by material, given a
 * contiguous slice each by a prefix sum, and shaded by one dispatch per material. Every one of
 * those is a no-op in a scene with one material, and the arrangement that goes wrong — a bin's
 * slice overlapping its neighbour's — cannot happen when there is only one slice.
 *
 * A draft: see `gpuDrivenRig.ts` for what the pipeline does not draw yet.
 */
import { mountRig, materialsRig } from './gpuDrivenRig';
import type { RenderQualityOptions } from '../packages/core/src/index';
import type { DemoBudget, DemoHandle, DemoScene } from './types';

export const gpuDrivenMaterials: DemoScene = {
  id: 'gpu-driven-materials',
  title: 'Sixteen materials, sixteen dispatches',
  note:
    'The visibility buffer records which triangle covered each pixel and nothing about how it ' +
    'looks. The pixels are then counted by material, given a contiguous slice each by a prefix ' +
    'sum, and shaded by one dispatch per material — including the empty ones, at zero groups.',
  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    return mountRig(canvas, overrides, materialsRig);
  },
};
