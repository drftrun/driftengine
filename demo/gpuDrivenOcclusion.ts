/**
 * A wall, and what the frame does not draw behind it.
 *
 * **The scene two-phase occlusion exists for.** Phase one draws what was visible last frame, the
 * depth pyramid is reduced from *that* depth, and phase two tests everything else against it — so
 * the field behind the wall is culled against depth from this frame rather than from the last
 * one, which is the difference that stops geometry vanishing for a frame after the camera moves.
 * With one phase the pyramid is empty when the cull runs and the whole field is drawn.
 *
 * A draft: see `gpuDrivenRig.ts` for what the pipeline does not draw yet.
 */
import { mountRig, occlusionRig } from './gpuDrivenRig';
import type { RenderQualityOptions } from '../packages/core/src/index';
import type { DemoBudget, DemoHandle, DemoScene } from './types';

export const gpuDrivenOcclusion: DemoScene = {
  id: 'gpu-driven-occlusion',
  title: 'A wall, and what the frame does not draw behind it',
  note:
    'Phase one draws what was visible last frame, a depth pyramid is reduced from that depth, ' +
    'and phase two tests everything else against it — so the field behind the wall is culled ' +
    'against depth from this frame rather than from the last one.',
  async mount(
    canvas: HTMLCanvasElement,
    _budget: DemoBudget = 'full',
    overrides: RenderQualityOptions = {},
  ): Promise<DemoHandle> {
    return mountRig(canvas, overrides, occlusionRig);
  },
};
