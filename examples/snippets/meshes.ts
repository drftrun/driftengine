/**
 * Meshes: built from shapes, written by hand, rewritten every frame, and uploaded a slice at a time.
 *
 * A snippet, typechecked with the examples and quoted by the manual's meshes chapter.
 */
import { MeshBuilder, StepBudget } from '@driftengine/core';
import { validateMeshData } from '@driftengine/drft';
import type { IncrementalMeshHandle, MeshData, RendererApi } from '@driftengine/core';

// #region builder
/** A lamp post: every shape added to one builder becomes one mesh and one draw. */
export function lampPost(): MeshData {
  return (
    new MeshBuilder()
      .addBox([0, 0.1, 0], [0.4, 0.1, 0.4], [0.3, 0.3, 0.32])
      .addCylinder([0, 2, 0], 0.08, 1.9, 'y', [0.22, 0.23, 0.25], 0, 10)
      .addOrientedBox([0.35, 3.85, 0], [0.4, 0.05, 0.06], [1, 0, 0], [0.22, 0.23, 0.25])
      // The fourth argument is emissive: this glows, where the environment lets emissive through.
      .addSphere([0.7, 3.7, 0], 0.16, [1, 0.85, 0.6], 2.5)
      .build()
  );
}
// #endregion

// #region raw
/** A single triangle from raw arrays: every attribute covers every vertex. */
export function triangle(): MeshData {
  const data: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 0.2, 0.2, 0.2, 1, 0.2, 0.2, 0.2, 1]),
    emissive: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
  validateMeshData(data); // throws, naming the attribute, if anything does not line up
  return data;
}
// #endregion

// #region dynamic
/** A flag whose vertices move every frame: created dynamic once, rewritten in place. */
export function waveFlag(renderer: RendererApi) {
  const data = new MeshBuilder()
    .addQuad([0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0], [0.8, 0.2, 0.2])
    .build();
  const mesh = renderer.createMesh(data, { dynamic: true });
  const positions = new Float32Array(data.positions);
  return (time: number) => {
    for (let i = 0; i < positions.length; i += 3) {
      positions[i + 2] = Math.sin(time * 3 + data.positions[i] * 2) * 0.15 * data.positions[i];
    }
    renderer.updateMesh(mesh, positions);
    return mesh;
  };
}
// #endregion

// #region incremental
/** A large mesh uploaded over several frames, never more than two milliseconds of each. */
const budget = new StepBudget();
let pending: IncrementalMeshHandle | null = null;

export function startUpload(renderer: RendererApi, data: MeshData): void {
  pending = renderer.createMeshIncremental(data);
}

/** Call once a frame. The mesh may be held and measured at once, and drawn once `complete`. */
export function continueUpload(): void {
  if (pending === null) return;
  const upload = pending.upload;
  budget.spend(2, () => (upload.next().done === true ? null : 'mesh'));
  if (pending.mesh.complete) pending = null;
}
// #endregion
