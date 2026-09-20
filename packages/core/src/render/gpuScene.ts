/**
 * The scene as the GPU sees it: one transform, one bounding sphere and one material index per
 * instance, in buffers that persist across frames.
 *
 * **Uploaded by dirty range rather than rebuilt.** A GPU-driven frame reads these every frame and
 * reads the processor-side scene not at all, so the cost of keeping them current is the cost of
 * the pipeline. A world of a hundred thousand instances in which four moved must upload four.
 *
 * **One range rather than a list of them**, which is a deliberate approximation: instances that
 * move together are overwhelmingly adjacent in a world partitioned by space, so one
 * first-to-last span costs a few wasted bytes and saves keeping a set. The case it is wrong for
 * — two objects moving at opposite ends of a large world — uploads the whole span between them,
 * and that is the trade being made rather than an oversight.
 *
 * Allocates nothing per write. Every setter fills existing storage.
 */
export interface GpuScene {
  /** Sixteen floats per instance, in the renderer's existing matrix convention. */
  transforms: Float32Array;
  /** Four floats per instance: centre x, y, z then radius. */
  bounds: Float32Array;
  /** One material index per instance. */
  materials: Uint32Array;
  /** Lowest instance written since the last clear, or -1. */
  dirtyFirst: number;
  /** Highest instance written since the last clear, or -1. */
  dirtyLast: number;
}

export function createGpuScene(capacity: number): GpuScene {
  return {
    transforms: new Float32Array(capacity * 16),
    bounds: new Float32Array(capacity * 4),
    materials: new Uint32Array(capacity),
    dirtyFirst: -1,
    dirtyLast: -1,
  };
}

function touch(scene: GpuScene, index: number): void {
  if (scene.dirtyFirst === -1 || index < scene.dirtyFirst) scene.dirtyFirst = index;
  if (index > scene.dirtyLast) scene.dirtyLast = index;
}

export function setInstanceTransform(scene: GpuScene, index: number, m: Float32Array): void {
  scene.transforms.set(m, index * 16);
  touch(scene, index);
}

export function setInstanceBounds(
  scene: GpuScene,
  index: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): void {
  const at = index * 4;
  scene.bounds[at] = cx;
  scene.bounds[at + 1] = cy;
  scene.bounds[at + 2] = cz;
  scene.bounds[at + 3] = radius;
  touch(scene, index);
}

export function setInstanceMaterial(scene: GpuScene, index: number, material: number): void {
  scene.materials[index] = material;
  touch(scene, index);
}

export function dirtyRange(scene: GpuScene): { first: number; count: number } {
  if (scene.dirtyFirst === -1) return { first: 0, count: 0 };
  return { first: scene.dirtyFirst, count: scene.dirtyLast - scene.dirtyFirst + 1 };
}

/** Forget what moved. The data stays; only the record of which part of it is unsent is cleared. */
export function clearDirty(scene: GpuScene): void {
  scene.dirtyFirst = -1;
  scene.dirtyLast = -1;
}
