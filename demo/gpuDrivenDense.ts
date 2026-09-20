/**
 * A million triangles through one indirect draw.
 *
 * **What it exercises is the size**, which is the part of the claim nothing else here reaches:
 * one buffer of clusters, one dispatch over all of them, one draw whose instance count the
 * processor never reads. It is also the scene that found the bake could not produce it — the
 * cluster builder scanned the whole mesh for every member of every cluster until 2026-09-16, and
 * a million triangles extrapolated to days. It is 648 ms now.
 *
 * A draft: see `gpuDrivenRig.ts` for what the pipeline does not draw yet.
 */
import { mountRig, denseRig } from './gpuDrivenRig';
import type { RenderQualityOptions } from '../packages/core/src/index';
import type { DemoBudget, DemoHandle, DemoScene } from './types';

export const gpuDrivenDense: DemoScene = {
  id: 'gpu-driven-dense',
  title: 'A million triangles through one indirect draw',
  note:
    'The whole surface is one buffer of clusters, culled and level-selected on the device and ' +
    'drawn by two indirect calls the processor never sees the counts of. It is the second ' +
    'pipeline: opt-in, WebGPU only, and not yet the engine’s standard material.',
  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    return mountRig(canvas, overrides, denseRig);
  },
};
