/**
 * Instances that each fade on their own, in one translucent draw.
 *
 * A snippet, typechecked with the examples and quoted by the manual's instancing chapter.
 */
import type { InstancedHandle, MeshInstances, RendererApi } from '@driftengine/core';

// #region opacity
/** Panes pulsing out of step: an opacity an instance, uploaded with the rest of the batch. */
export function fadingPanes(
  renderer: RendererApi,
  batch: InstancedHandle,
  panes: MeshInstances,
  time: number,
): void {
  const alphas = panes.alphas;
  if (alphas !== undefined) {
    for (let i = 0; i < panes.count; i += 1) alphas[i] = 0.5 + 0.5 * Math.sin(time + i);
  }
  renderer.uploadInstanced(batch, panes);
  renderer.drawTranslucentInstanced(batch, panes, 1);
}
// #endregion
