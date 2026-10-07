/**
 * Instances that each fade on their own, and each wear their own cell of a flipbook, in one
 * translucent draw; a crowd played from a bone animation; and a stage's still draws, recorded once.
 *
 * A snippet, typechecked with the examples and quoted by the manual's instancing chapter.
 */
import { createMeshInstances } from '@driftengine/core';
import type {
  BoneAnimationClip,
  InstancedHandle,
  MeshHandle,
  MeshInstances,
  RendererApi,
  SceneCasterMaterial,
  StaticDrawsHandle,
} from '@driftengine/core';

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

// #region crowd
/** One figure placed many times, each copy playing `clip` from a phase and at a rate of its own. */
export function createCrowd(
  renderer: RendererApi,
  figure: MeshHandle,
  clip: BoneAnimationClip,
  places: readonly Float32Array[],
) {
  const animation = renderer.createBoneAnimation(clip);
  const batch = renderer.createInstanced(figure, places.length, { animation });
  const crowd = {
    ...createMeshInstances(places.length),
    clocks: new Float32Array(places.length * 2),
  };
  places.forEach((model, i) => {
    crowd.models.set(model, i * 16);
    crowd.clocks[i * 2] = i * 0.37; // a phase, in seconds
    crowd.clocks[i * 2 + 1] = 0.9 + (i % 5) * 0.05; // a rate: 1 is the clip's own speed
  });
  crowd.count = places.length;
  renderer.uploadInstanced(batch, crowd);
  return { animation, batch, crowd };
}
// #endregion

// #region static
/** A stage's props that never move, enumerated once and kept: replay it each frame instead. */
export function recordStage(
  renderer: RendererApi,
  props: readonly { mesh: MeshHandle; model: Float32Array; material: SceneCasterMaterial }[],
): StaticDrawsHandle {
  return renderer.createStaticDraws((sink) => {
    for (const prop of props) sink.mesh(prop.mesh, prop.model, prop.material);
  });
}
// #endregion
