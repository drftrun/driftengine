/**
 * Instances that each fade on their own, and each wear their own cell of a flipbook, in one
 * translucent draw.
 *
 * A snippet, typechecked with the examples and quoted by the manual's instancing chapter.
 */
import { createMeshInstances } from '@driftengine/core';
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

// #region cells
/** A batch whose instances each name a cell of a flipbook of `frames` frames in one row. */
export function createFlipbookBatch(capacity: number) {
  return { ...createMeshInstances(capacity), uvRegions: new Float32Array(capacity * 4) };
}

/** Each particle on its own frame: the cell's scale, then its offset, per instance. */
export function showFrames(
  renderer: RendererApi,
  batch: InstancedHandle,
  particles: ReturnType<typeof createFlipbookBatch>,
  frameOf: (particle: number) => number,
  frames: number,
): void {
  for (let i = 0; i < particles.count; i += 1) {
    particles.uvRegions.set([1 / frames, 1, frameOf(i) / frames, 0], i * 4);
  }
  renderer.uploadInstanced(batch, particles);
  renderer.drawTranslucentInstanced(batch, particles, 1);
}
// #endregion
